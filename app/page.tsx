'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://sqgnrzcmjhwgfjxocvlr.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZ25yemNtamh3Z2ZqeG9jdmxyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM2NzEwMSwiZXhwIjoyMDg3OTQzMTAxfQ.fAnUMR8cXgQ38VWz66UibT83u_JquuXeZRtpiYmbTzM'
)

/* ─── TYPES ─── */
type Branch = { id: string; name: string; address: string }
type Category = { id: string; name_he: string; sort_order: number }
type MenuItem = {
  id: string; category_id: string; name_he: string; name_en: string
  description_he: string; dietary_type: 'parve' | 'meat' | 'dairy'
  is_popular: boolean; is_active: boolean; image_url: string | null
  has_lettuce?: boolean; has_pita?: boolean; has_egg?: boolean; price?: number
}
type Topping = { id: string; name_he: string; type: 'spread' | 'filling' | 'paid_addon'; sort_order: number; price?: number }
type CartItem = {
  item: MenuItem; quantity: number
  sauces: string[]; salads: string[]; paidAddons: string[]
  noLettuce: boolean; notes: string
}
type OrderStatus = 'received' | 'confirmed' | 'preparing' | 'ready' | 'delivered'
type Screen = 'branch' | 'menu' | 'order' | 'tracking'

/* ─── DARK PREMIUM PALETTE ─── */
const C = {
  bg:         '#0D0D0D',
  bgCard:     '#1A1A1A',
  bgCardHover:'#222222',
  border:     '#2A2A2A',
  gold:       '#FFD700',
  goldDim:    '#C9A800',
  white:      '#FFFFFF',
  gray:       '#B0B0B0',
  grayDim:    '#555555',
  green:      '#4ADE80',
  greenBg:    'rgba(74,222,128,0.12)',
  red:        '#FF6B6B',
  redBg:      'rgba(255,107,107,0.12)',
}

const LOGO = 'https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg'

const STATUS_LABELS: Record<OrderStatus, string> = {
  received: 'ממתינה לאישור', confirmed: 'אושרה',
  preparing: 'בהכנה', ready: 'מוכנה לאיסוף', delivered: 'הוגשה',
}
const STATUS_ICONS: Record<OrderStatus, string> = {
  received: '⏳', confirmed: '✅', preparing: '👨‍🍳', ready: '🔔', delivered: '🎉',
}

const isValidPhone = (p: string) => /^05\d{8}$/.test(p.replace(/[-\s]/g, ''))
const fmt = (n: number) => `₪${n.toFixed(0)}`

/* ══════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════ */
export default function Home() {
  const [screen, setScreen] = useState<Screen>('branch')
  const [branches, setBranches] = useState<Branch[]>([])
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [toppings, setToppings] = useState<Topping[]>([])
  const [activeCategory, setActiveCategory] = useState<string>('')
  const [cart, setCart] = useState<CartItem[]>([])
  const [loading, setLoading] = useState(true)

  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null)
  const [showBottomSheet, setShowBottomSheet] = useState(false)
  const [sheetSauces, setSheetSauces] = useState<string[]>([])
  const [sheetSalads, setSheetSalads] = useState<string[]>([])
  const [sheetPaidAddons, setSheetPaidAddons] = useState<string[]>([])
  const [sheetNoLettuce, setSheetNoLettuce] = useState(false)
  const [sheetNotes, setSheetNotes] = useState('')
  const [sheetQty, setSheetQty] = useState(1)

  const [customerName, setCustomerName] = useState('')
  const [orderPhone, setOrderPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit' | 'cibus'>('cash')
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('received')

  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [installPrompt, setInstallPrompt] = useState<any>(null)
  const [showInstallBanner, setShowInstallBanner] = useState(false)
  const [showUpsell, setShowUpsell] = useState(false)
  const [showCart, setShowCart] = useState(false)
  const [editCartIndex, setEditCartIndex] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault()
      setInstallPrompt(e)
      setShowInstallBanner(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    // הסתר אם כבר מותקן
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setShowInstallBanner(false)
    }
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem('falafel_session')
    if (saved) {
      try {
        const s = JSON.parse(saved)
        if (s.orderId && s.expires > Date.now()) {
          setOrderId(s.orderId); setLoading(false); setScreen('tracking');
          fetchBranches(); return
        }
        if (s.branch && s.screen && s.screen !== 'tracking') {
          setSelectedBranch(s.branch)
          if (s.cart) setCart(s.cart)
          setLoading(true)
          restoreBranch(s.branch, s.screen)
          return
        }
      } catch {}
      localStorage.removeItem('falafel_session')
    }
    fetchBranches()
  }, [])

  async function restoreBranch(branch: Branch, savedScreen: Screen) {
    const [catRes, itemRes, topRes, priceRes] = await Promise.all([
      supabase.from('menu_categories').select('*').order('sort_order'),
      supabase.from('menu_items').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('toppings').select('*').order('sort_order'),
      supabase.from('branch_prices').select('item_id, price').eq('branch_id', branch.id).eq('is_available', true),
    ])
    const cats = catRes.data || []
    const prices: Record<string, number> = {}
    for (const p of (priceRes.data || [])) prices[p.item_id] = p.price
    const items = (itemRes.data || []).map((item: any) => ({ ...item, price: prices[item.id] ?? undefined }))
    setCategories(cats)
    setMenuItems(items)
    setToppings(topRes.data || [])
    if (cats.length > 0) setActiveCategory(cats[0].id)
    setLoading(false)
    setScreen(savedScreen)
  }

  async function fetchBranches() {
    const { data } = await supabase.from('branches').select('id, name, address').order('sort_order')
    setBranches(data || [])
    setLoading(false)
  }

  async function selectBranch(branch: Branch) {
    setSelectedBranch(branch)
    setLoading(true)
    const [catRes, itemRes, topRes, priceRes] = await Promise.all([
      supabase.from('menu_categories').select('*').order('sort_order'),
      supabase.from('menu_items').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('toppings').select('*').order('sort_order'),
      supabase.from('branch_prices').select('item_id, price').eq('branch_id', branch.id).eq('is_available', true),
    ])
    const cats = catRes.data || []
    const prices: Record<string, number> = {}
    for (const p of (priceRes.data || [])) prices[p.item_id] = p.price
    const items = (itemRes.data || []).map((item: any) => ({ ...item, price: prices[item.id] ?? undefined }))
    setCategories(cats)
    setMenuItems(items)
    setToppings(topRes.data || [])
    if (cats.length > 0) setActiveCategory(cats[0].id)
    setLoading(false)
    setScreen('menu')
  }

  const cartTotal = cart.reduce((sum, c) => {
    const addonsTotal = c.paidAddons.reduce((s, name) => {
      const t = toppings.find(t => t.name_he === name)
      return s + (t?.price ?? 4)
    }, 0)
    return sum + ((c.item.price || 0) + addonsTotal) * c.quantity
  }, 0)
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)

  useEffect(() => {
    if (screen === 'branch' || screen === 'tracking') return
    if (!selectedBranch) return
    // שמור session רק אם יש פריטים בסל
    if (cart.length === 0) return
    const saved = localStorage.getItem('falafel_session')
    try {
      const s = saved ? JSON.parse(saved) : {}
      if (s.orderId) return
    } catch {}
    localStorage.setItem('falafel_session', JSON.stringify({
      branch: selectedBranch, cart, screen, expires: Date.now() + 6 * 3600 * 1000
    }))
  }, [cart, screen, selectedBranch])

  function handleCartButton() {
    // בדוק אם יש שתייה בסל
    const hasDrinks = cart.some(c => {
      const cat = categories.find(cat => cat.id === c.item.category_id)
      return cat && (cat.name_he.includes('שתי') || cat.name_he.includes('שתיה') || cat.name_he.includes('שתייה') || cat.name_he.includes('משקה'))
    })
    // בדוק אם יש תוספות בתשלום
    const hasPaidAddons = cart.some(c => c.paidAddons.length > 0)
    if (!hasDrinks || !hasPaidAddons) {
      setShowUpsell(true)
    } else {
      setScreen('order')
    }
  }

  function openItem(item: MenuItem) {
    setSelectedItem(item); setSheetSauces([]); setSheetSalads([])
    setSheetPaidAddons([]); setSheetNoLettuce(false); setSheetNotes(''); setSheetQty(1)
    setShowBottomSheet(true)
  }

  function openEditItem(index: number) {
    const c = cart[index]
    setSelectedItem(c.item)
    setSheetSauces(c.sauces)
    setSheetSalads(c.salads)
    setSheetPaidAddons(c.paidAddons)
    setSheetNoLettuce(c.noLettuce)
    setSheetNotes(c.notes)
    setSheetQty(c.quantity)
    setEditCartIndex(index)
    setShowCart(false)
    setShowBottomSheet(true)
  }

  function addToCart() {
    if (!selectedItem) return
    const newItem: CartItem = {
      item: selectedItem, quantity: sheetQty, sauces: sheetSauces,
      salads: sheetSalads,
      paidAddons: sheetPaidAddons, noLettuce: sheetNoLettuce, notes: sheetNotes,
    }
    if (editCartIndex !== null) {
      setCart(prev => prev.map((c, i) => i === editCartIndex ? newItem : c))
      setEditCartIndex(null)
      setShowBottomSheet(false)
    } else {
      setCart(prev => [...prev, newItem])
      setShowBottomSheet(false)

      // גלול לתוספות או שתייה אחרי הוספה לסל
      setTimeout(() => {
        const isAddon = categories.find(c => c.name_he.includes('תוספ'))
        const isDrink = categories.find(c => c.name_he.includes('שתי'))
        const addedCat = categories.find(c => c.id === newItem.item.category_id)
        const isAddingDrink = addedCat?.name_he.includes('שתי')
        const isAddingAddon = addedCat?.name_he.includes('תוספ')

        if (!isAddingDrink && !isAddingAddon) {
          // מנה רגילה — גלול לתוספות
          if (isAddon) {
            setActiveCategory(isAddon.id)
            categoryRefs.current[isAddon.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        } else if (isAddingAddon) {
          // תוספת — גלול לשתייה
          if (isDrink) {
            setActiveCategory(isDrink.id)
            categoryRefs.current[isDrink.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }
      }, 300)
    }
  }

  async function placeOrder() {
    if (!selectedBranch || !isValidPhone(orderPhone) || cart.length === 0 || customerName.trim().length < 2) return
    setPlacingOrder(true)
    const { data: order, error } = await supabase.from('orders').insert([{
      branch_id: selectedBranch.id,
      phone: orderPhone.replace(/[-\s]/g, ''),
      customer_name: customerName.trim(),
      payment_method: paymentMethod,
      status: 'received',
      total_price: cartTotal,
    }]).select().single()

    if (error || !order) {
      console.error('ORDER ERROR:', JSON.stringify(error))
      alert('שגיאה: ' + JSON.stringify(error?.message))
      setPlacingOrder(false); return
    }

    await supabase.from('order_items').insert(
      cart.map(c => ({
        order_id: order.id,
        item_id: c.item.id,
        quantity: c.quantity,
        unit_price: (c.item.price || 0) + c.paidAddons.reduce((s, name) => {
          const t = toppings.find(t => t.name_he === name)
          return s + (t?.price ?? 4)
        }, 0),
        notes: [
          c.sauces.length > 0 ? `רטבים: ${c.sauces.join(', ')}` : '',
          c.salads.length > 0 ? `סלטים: ${c.salads.join(', ')}` : '',
          c.paidAddons.length > 0 ? `תוספות: ${c.paidAddons.join(', ')}` : '',
          c.notes || '',
        ].filter(Boolean).join(' | '),
      }))
    )
    localStorage.setItem('falafel_session', JSON.stringify({ orderId: order.id, expires: Date.now() + 6 * 3600 * 1000 }))
    setOrderId(order.id); setOrderStatus('received'); setCart([])
    setPlacingOrder(false); setScreen('tracking')
  }

  useEffect(() => {
    if (screen !== 'tracking' || !orderId) return
    const poll = async () => {
      const { data } = await supabase.from('orders').select('status').eq('id', orderId).single()
      if (data) setOrderStatus(data.status as OrderStatus)
    }
    poll()
    const id = setInterval(poll, 10000)
    return () => clearInterval(id)
  }, [screen, orderId])

  // אחרי הוגשה — חזור לדף הראשי אחרי 3 שניות
  useEffect(() => {
    if (orderStatus !== 'delivered') return
    const timer = setTimeout(() => {
      localStorage.removeItem('falafel_session')
      setOrderId(null)
      setCart([])
      setScreen('branch')
    }, 3000)
    return () => clearTimeout(timer)
  }, [orderStatus])

  const sauces = toppings.filter(t => t.type === 'spread')
  const saladsOpts = toppings.filter(t => t.type === 'filling')
  const paidAddonsOpts = toppings.filter(t => t.type === 'paid_addon')

  /* ── LOADING ── */
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, fontFamily: 'Heebo, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <img src={LOGO} alt="פלאפל בתחנה" style={{ width: 130, height: 130, objectFit: 'contain', marginBottom: 16 }} />
        <div style={{ color: C.gold, fontSize: 15, fontWeight: 600, letterSpacing: 1 }}>טוען...</div>
      </div>
    </div>
  )

  /* ── BRANCH SCREEN ── */
  if (screen === 'branch') return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
      <div style={{ padding: '56px 24px 44px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', borderBottom: `1px solid ${C.border}` }}>
        <img src={LOGO} alt="פלאפל בתחנה" style={{ width: 150, height: 150, objectFit: 'contain', marginBottom: 16 }} />
        <h1 style={{ color: C.white, fontSize: 28, fontWeight: 900, margin: '0 0 6px', letterSpacing: -0.5 }}>פלאפל בתחנה</h1>
        <p style={{ color: C.gray, fontSize: 15, margin: 0 }}>בחר סניף להזמנה</p>
      </div>
      <div style={{ padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
        {branches.map(b => (
          <button key={b.id} onClick={() => selectBranch(b)}
            style={{ width: '100%', background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 18, padding: '20px 22px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer', textAlign: 'right', fontFamily: 'Heebo, sans-serif', transition: 'border-color 0.15s, background 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.background = C.bgCardHover }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.bgCard }}>
            <div style={{ width: 48, height: 48, background: 'rgba(255,215,0,0.1)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>📍</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 17, color: C.white }}>{b.name}</div>
              {b.address && <div style={{ fontSize: 13, color: C.gray, marginTop: 3 }}>{b.address}</div>}
            </div>
            <div style={{ color: C.gold, fontSize: 20 }}>←</div>
          </button>
        ))}
        {orderId && (
          <button onClick={() => setScreen('tracking')}
            style={{ width: '100%', background: 'rgba(255,215,0,0.08)', border: `1px solid ${C.gold}`, borderRadius: 18, padding: '18px 22px', marginTop: 8, display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer', textAlign: 'right', fontFamily: 'Heebo, sans-serif' }}>
            <div style={{ width: 48, height: 48, background: 'rgba(255,215,0,0.15)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>⏳</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: C.gold }}>מעקב הזמנה פעילה</div>
              <div style={{ fontSize: 13, color: C.gray, marginTop: 2 }}>#{orderId.slice(-6).toUpperCase()}</div>
            </div>
            <div style={{ color: C.gold, fontSize: 20 }}>←</div>
          </button>
        )}
      </div>
    {/* באנר התקנה */}
      {showInstallBanner && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 999,
          background: '#1A1A1A', borderTop: '1px solid #FFD700',
          padding: '14px 16px', direction: 'rtl',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <img src={LOGO} alt="לוגו" style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 10, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>הוסף לפלאפל לטלפון</div>
            <div style={{ color: '#9CA3AF', fontSize: 12 }}>התקן את האפליקציה למסך הבית</div>
          </div>
          <button onClick={async () => {
            if (installPrompt) {
              installPrompt.prompt()
              const result = await installPrompt.userChoice
              if (result.outcome === 'accepted') setShowInstallBanner(false)
            }
          }} style={{
            background: '#FFD700', color: '#000', border: 'none',
            borderRadius: 10, padding: '8px 16px', fontWeight: 800,
            fontSize: 13, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', flexShrink: 0,
          }}>התקן</button>
          <button onClick={() => setShowInstallBanner(false)} style={{
            background: 'none', border: 'none', color: '#6B7280',
            fontSize: 20, cursor: 'pointer', padding: '4px', flexShrink: 0,
          }}>✕</button>
        </div>
      )}
    </div>
  )

  /* ── TRACKING SCREEN ── */
  if (screen === 'tracking') {
    const steps: OrderStatus[] = ['received', 'confirmed', 'preparing', 'ready', 'delivered']
    const currentStep = steps.indexOf(orderStatus)
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
        <div style={{ padding: '36px 24px 28px', textAlign: 'center', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <img src={LOGO} alt="" style={{ width: 100, height: 100, objectFit: 'contain', marginBottom: 14 }} />
          <h1 style={{ color: C.white, fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>מעקב הזמנה</h1>
          <div style={{ color: C.gold, fontSize: 13, fontWeight: 600 }}>#{orderId?.slice(-6).toUpperCase()}</div>
        </div>
        <div style={{ padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ background: C.bgCard, borderRadius: 20, padding: 28, marginBottom: 16, border: `1px solid ${C.border}` }}>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 56 }}>{STATUS_ICONS[orderStatus]}</div>
              <div style={{ fontWeight: 800, fontSize: 22, color: C.white, marginTop: 10 }}>{STATUS_LABELS[orderStatus]}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {steps.slice(0, 4).map((step, i) => (
                <div key={step} style={{ flex: 1, height: 6, borderRadius: 4, background: i <= currentStep ? C.gold : C.border, transition: 'background 0.5s' }} />
              ))}
            </div>
          </div>
          <button onClick={() => { setCart([]); setScreen('branch') }}
            style={{ width: '100%', padding: 15, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 14, fontWeight: 700, fontSize: 15, color: C.gray, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
            + הזמנה חדשה
          </button>
        </div>
      </div>
    )
  }

  /* ── ORDER SCREEN ── */
  if (screen === 'order') return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
      <div style={{ background: C.bgCard, borderBottom: `1px solid ${C.border}`, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => setScreen('menu')}
          style={{ background: C.border, border: 'none', borderRadius: 10, padding: '8px 10px', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: C.white }}>→</button>
        <div style={{ fontWeight: 800, fontSize: 17, color: C.white }}>סיכום הזמנה</div>
      </div>
      <div style={{ padding: 16, maxWidth: 480, margin: '0 auto' }}>
        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 16 }}>📋 סיכום הזמנה</div>
          {cart.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 12, marginBottom: 12, borderBottom: i < cart.length - 1 ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.white }}>{c.item.name_he}</div>
                {c.sauces.length > 0 && <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>רטבים: {c.sauces.join(', ')}</div>}
                {c.salads.length > 0 && <div style={{ fontSize: 12, color: C.gray }}>סלטים: {c.salads.join(', ')}</div>}
                {c.paidAddons.length > 0 && <div style={{ fontSize: 12, color: C.gold }}>תוספות: {c.paidAddons.join(', ')}</div>}
                {c.notes && <div style={{ fontSize: 12, color: C.gray, fontStyle: 'italic' }}>הערה: {c.notes}</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.border, borderRadius: 10, padding: '5px 10px' }}>
                  <button onClick={() => setCart(prev => prev.map((x, ii) => ii === i ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.gold, fontWeight: 700, lineHeight: 1 }}>−</button>
                  <span style={{ fontWeight: 800, minWidth: 16, textAlign: 'center', color: C.white }}>{c.quantity}</span>
                  <button onClick={() => setCart(prev => prev.map((x, ii) => ii === i ? { ...x, quantity: x.quantity + 1 } : x))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.gold, fontWeight: 700, lineHeight: 1 }}>+</button>
                </div>
                <span style={{ fontWeight: 800, color: C.gold, minWidth: 44, textAlign: 'left' }}>
                  {fmt(((c.item.price || 0) + c.paidAddons.reduce((s, name) => {
                    const t = toppings.find(t => t.name_he === name); return s + (t?.price ?? 4)
                  }, 0)) * c.quantity)}
                </span>
                <button onClick={() => setCart(prev => prev.filter((_, ii) => ii !== i))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.red, lineHeight: 1, padding: '4px' }}>🗑️</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, borderTop: `1px solid ${C.border}`, fontWeight: 800, fontSize: 18 }}>
            <span style={{ color: C.gray }}>סה"כ</span>
            <span style={{ color: C.gold }}>{fmt(cartTotal)}</span>
          </div>
        </div>

        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 14 }}>👤 שם מלא</div>
          <input type="text" value={customerName} onChange={e => setCustomerName(e.target.value)}
            placeholder="שם ושם משפחה" dir="rtl"
            style={{ width: '100%', padding: 14, border: `1px solid ${customerName.trim().length >= 2 ? C.green : C.border}`, borderRadius: 12, fontSize: 17, fontFamily: 'Heebo, sans-serif', outline: 'none', boxSizing: 'border-box', background: C.bg, color: C.white }} />
          {customerName.length > 0 && customerName.trim().length < 2 && (
            <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>נא להזין שם מלא</div>
          )}
        </div>

        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 14 }}>📱 מספר טלפון</div>
          <input type="tel" value={orderPhone} onChange={e => setOrderPhone(e.target.value)}
            placeholder="05X-XXXXXXX" dir="ltr"
            style={{ width: '100%', padding: 14, border: `1px solid ${orderPhone && isValidPhone(orderPhone) ? C.green : C.border}`, borderRadius: 12, fontSize: 17, fontFamily: 'Heebo, sans-serif', outline: 'none', boxSizing: 'border-box', background: C.bg, color: C.white }} />
          {orderPhone && !isValidPhone(orderPhone) && (
            <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>מספר לא תקין — חייב להתחיל ב-05 ולהכיל 10 ספרות</div>
          )}
        </div>

        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 24, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 14 }}>💳 אמצעי תשלום</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {(['cash', 'credit', 'cibus'] as const).map(v => (
              <button key={v} onClick={() => setPaymentMethod(v)}
                style={{ padding: 14, border: `1px solid ${paymentMethod === v ? C.gold : C.border}`, borderRadius: 12, background: paymentMethod === v ? 'rgba(255,215,0,0.1)' : C.bg, fontWeight: 700, fontSize: 14, color: paymentMethod === v ? C.gold : C.gray, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
                {v === 'cash' ? '💵 מזומן' : v === 'credit' ? '💳 אשראי' : '🍽️ סיבוס'}
              </button>
            ))}
          </div>
        </div>

        <button onClick={placeOrder} disabled={!isValidPhone(orderPhone) || cart.length === 0 || placingOrder || customerName.trim().length < 2}
          style={{ width: '100%', padding: 17, background: isValidPhone(orderPhone) && cart.length > 0 ? C.gold : C.grayDim, color: '#000', border: 'none', borderRadius: 16, fontSize: 18, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', boxShadow: isValidPhone(orderPhone) ? '0 6px 32px rgba(255,215,0,0.3)' : 'none' }}>
          {placingOrder ? '⏳ שולח הזמנה...' : `✅ שלח הזמנה • ${fmt(cartTotal)}`}
        </button>
      </div>
    </div>
  )

  /* ── MENU SCREEN ── */
  const itemsByCategory: Record<string, MenuItem[]> = {}
  for (const cat of categories) {
    itemsByCategory[cat.id] = menuItems.filter(m => m.category_id === cat.id)
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', direction: 'rtl', paddingBottom: cartCount > 0 ? 96 : 0 }}>

      <div style={{ background: C.bgCard, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 200 }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ padding: '12px 16px 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => { localStorage.removeItem('falafel_session'); setScreen('branch'); setCart([]) }}
              style={{ background: C.border, border: 'none', borderRadius: 10, padding: '8px 10px', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: C.white }}>→</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              <img src={LOGO} alt="לוגו" style={{ width: 34, height: 34, objectFit: 'contain', borderRadius: 8 }} />
              <div>
                <div style={{ fontWeight: 900, fontSize: 16, color: C.white, letterSpacing: -0.3 }}>פלאפל בתחנה</div>
                <div style={{ fontSize: 12, color: C.gray }}>{selectedBranch?.name}</div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', overflowX: 'auto', padding: '0 16px 12px', gap: 8, scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties}>
            {categories.map(cat => (
              <button key={cat.id}
                onClick={() => {
                  setActiveCategory(cat.id)
                  categoryRefs.current[cat.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                style={{ flexShrink: 0, padding: '7px 16px', borderRadius: 20, border: `1px solid ${activeCategory === cat.id ? C.gold : C.border}`, background: activeCategory === cat.id ? C.gold : 'transparent', color: activeCategory === cat.id ? '#000' : C.gray, fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
                {cat.name_he}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {categories.map(cat => {
          const items = itemsByCategory[cat.id] || []
          if (items.length === 0) return null
          return (
            <div key={cat.id} ref={(el: HTMLDivElement | null) => { categoryRefs.current[cat.id] = el }} style={{ scrollMarginTop: 130 }}>
              <div style={{ padding: '20px 16px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ height: 2, width: 4, background: C.gold, borderRadius: 2 }} />
                <div style={{ fontWeight: 900, fontSize: 18, color: C.gold, letterSpacing: -0.2 }}>{cat.name_he}</div>
              </div>
              {items.map(item => (
                <button key={item.id} onClick={() => openItem(item)}
                  style={{ width: '100%', background: 'transparent', border: 'none', borderBottom: `1px solid ${C.border}`, padding: '14px 16px', display: 'flex', gap: 14, alignItems: 'flex-start', cursor: 'pointer', textAlign: 'right', fontFamily: 'Heebo, sans-serif', transition: 'background 0.12s' }}
                  onMouseEnter={e => e.currentTarget.style.background = C.bgCard}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
                      {item.is_popular && <span style={{ background: 'rgba(255,215,0,0.15)', color: C.gold, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>🔥 פופולרי</span>}
                      {item.dietary_type === 'parve' && <span style={{ background: C.greenBg, color: C.green, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>🌿 פרווה</span>}
                      {item.dietary_type === 'meat' && <span style={{ background: C.redBg, color: C.red, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>🥩 בשרי</span>}
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 3 }}>{item.name_he}</div>
                    {item.description_he && <div style={{ fontSize: 13, color: C.gray, marginBottom: 6, lineHeight: 1.4 }}>{item.description_he}</div>}
                    {item.price ? <div style={{ fontWeight: 900, fontSize: 17, color: C.gold }}>{fmt(item.price)}</div> : null}
                  </div>
                  <div style={{ width: 90, height: 90, flexShrink: 0, borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: C.bgCard, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {item.image_url
                      ? <img src={item.image_url} alt={item.name_he} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: 32 }}>🧆</span>}
                  </div>
                </button>
              ))}
            </div>
          )
        })}
      </div>

      {cartCount > 0 && (
        <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 300, maxWidth: 608, margin: '0 auto', display: 'flex', gap: 10 }}>
          {/* כפתור סל */}
          <button onClick={() => setShowCart(true)}
            style={{ padding: '15px 18px', background: C.bgCard, color: C.white, border: `1px solid ${C.gold}`, borderRadius: 16, fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', flexShrink: 0 }}>
            <span style={{ fontSize: 20 }}>🛒</span>
            <span style={{ background: C.gold, color: '#000', borderRadius: 20, padding: '1px 8px', fontSize: 12, fontWeight: 900 }}>{cartCount}</span>
          </button>
          {/* כפתור תשלום */}
          <button onClick={handleCartButton}
            style={{ flex: 1, padding: '15px 20px', background: C.gold, color: '#000', border: 'none', borderRadius: 16, fontSize: 16, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 8px 32px rgba(255,215,0,0.35)' }}>
            <span />
            <span>לתשלום</span>
            <span>{fmt(cartTotal)}</span>
          </button>
        </div>
      )}

      {/* ── סל קניות ── */}
      {showCart && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 450 }}>
          <div onClick={() => setShowCart(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.75)' }} />
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            background: C.bgCard, borderRadius: '24px 24px 0 0',
            padding: '20px 20px 36px', direction: 'rtl',
            maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <div style={{ fontWeight: 900, fontSize: 18, color: C.white }}>🛒 הסל שלך</div>
              <button onClick={() => setShowCart(false)}
                style={{ background: C.border, border: 'none', borderRadius: 10, width: 34, height: 34, cursor: 'pointer', fontSize: 18, color: C.white, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Heebo, sans-serif' }}>✕</button>
            </div>

            {cart.length === 0 ? (
              <div style={{ textAlign: 'center', color: C.gray, padding: '30px 0' }}>הסל ריק</div>
            ) : (
              <>
                {cart.map((c, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    paddingBottom: 14, marginBottom: 14,
                    borderBottom: i < cart.length - 1 ? `1px solid ${C.border}` : 'none',
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: C.white }}>{c.item.name_he}</div>
                      {c.sauces.length > 0 && <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>רטבים: {c.sauces.join(', ')}</div>}
                      {c.salads.length > 0 && <div style={{ fontSize: 12, color: C.gray }}>סלטים: {c.salads.join(', ')}</div>}
                      {c.paidAddons.length > 0 && <div style={{ fontSize: 12, color: C.gold }}>תוספות: {c.paidAddons.join(', ')}</div>}
                      {c.notes && <div style={{ fontSize: 12, color: C.gray, fontStyle: 'italic' }}>הערה: {c.notes}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.border, borderRadius: 10, padding: '5px 10px' }}>
                        <button onClick={() => setCart(prev => prev.map((x, ii) => ii === i ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.gold, fontWeight: 700, lineHeight: 1 }}>−</button>
                        <span style={{ fontWeight: 800, minWidth: 16, textAlign: 'center', color: C.white }}>{c.quantity}</span>
                        <button onClick={() => setCart(prev => prev.map((x, ii) => ii === i ? { ...x, quantity: x.quantity + 1 } : x))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.gold, fontWeight: 700, lineHeight: 1 }}>+</button>
                      </div>
                      <span style={{ fontWeight: 800, color: C.gold, minWidth: 44, textAlign: 'left', fontSize: 14 }}>
                        {fmt(((c.item.price || 0) + c.paidAddons.reduce((s, name) => {
                    const t = toppings.find(t => t.name_he === name); return s + (t?.price ?? 4)
                  }, 0)) * c.quantity)}
                      </span>
                      <button onClick={() => { openEditItem(i) }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.gold, lineHeight: 1, padding: '4px' }}>✏️</button>
                      <button onClick={() => setCart(prev => prev.filter((_, ii) => ii !== i))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.red, lineHeight: 1, padding: '4px' }}>🗑️</button>
                    </div>
                  </div>
                ))}

                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 14, borderTop: `1px solid ${C.border}`, fontWeight: 800, fontSize: 18, marginBottom: 18 }}>
                  <span style={{ color: C.gray }}>סה"כ</span>
                  <span style={{ color: C.gold }}>{fmt(cartTotal)}</span>
                </div>

                <button onClick={() => { setShowCart(false); handleCartButton() }}
                  style={{ width: '100%', padding: 16, background: C.gold, color: '#000', border: 'none', borderRadius: 14, fontSize: 17, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', boxShadow: '0 4px 20px rgba(255,215,0,0.3)' }}>
                  לתשלום • {fmt(cartTotal)}
                </button>
                <button onClick={() => setShowCart(false)}
                  style={{ width: '100%', marginTop: 10, padding: 12, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 14, fontSize: 14, fontWeight: 600, color: C.gray, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
                  המשך בקנייה
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showUpsell && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500 }}>
          <div onClick={() => setShowUpsell(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)' }} />
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            background: C.bgCard, borderRadius: '24px 24px 0 0',
            padding: '24px 20px 36px', direction: 'rtl',
            maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2, margin: '0 auto 20px' }} />
            <div style={{ fontSize: 28, textAlign: 'center', marginBottom: 6 }}>🤔</div>
            <h2 style={{ color: C.white, fontSize: 20, fontWeight: 900, textAlign: 'center', marginBottom: 6 }}>
              שכחת משהו?
            </h2>
            <p style={{ color: C.gray, fontSize: 14, textAlign: 'center', marginBottom: 24 }}>
              הזמנה שלמה יותר עם שתייה ותוספות
            </p>

            {/* שתייה */}
            {(() => {
              const drinkCat = categories.find(cat =>
                cat.name_he.includes('שתי') || cat.name_he.includes('שתיה') || cat.name_he.includes('שתייה') || cat.name_he.includes('משקה')
              )
              const hasDrinks = cart.some(c => c.item.category_id === drinkCat?.id)
              if (drinkCat && !hasDrinks) {
                const drinks = menuItems.filter(m => m.category_id === drinkCat.id && m.price)
                return drinks.length > 0 ? (
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ color: C.gold, fontWeight: 800, fontSize: 16, marginBottom: 12 }}>🥤 שתייה</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {drinks.map(drink => (
                        <div key={drink.id} style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          background: C.bg, borderRadius: 14, padding: '10px 14px',
                          border: `1px solid ${C.border}`,
                        }}>
                          {/* תמונה */}
                          <div style={{ width: 60, height: 60, borderRadius: 10, overflow: 'hidden', flexShrink: 0, background: C.bgCard, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {drink.image_url
                              ? <img src={drink.image_url} alt={drink.name_he} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontSize: 28 }}>🥤</span>}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ color: C.white, fontWeight: 700, fontSize: 15 }}>{drink.name_he}</div>
                            {drink.price && <div style={{ color: C.gold, fontSize: 13, marginTop: 2 }}>{fmt(drink.price)}</div>}
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setCart(prev => [...prev, {
                                item: drink, quantity: 1, sauces: [], salads: [],
                                paidAddons: [], noLettuce: false, notes: ''
                              }])
                            }}
                            style={{
                              background: C.gold, color: '#000', border: 'none',
                              borderRadius: 10, padding: '8px 18px', fontWeight: 800,
                              fontSize: 14, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', flexShrink: 0,
                            }}>+ הוסף</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null
              }
              return null
            })()}

            {/* תוספות */}
            {(() => {
              const addonCat = categories.find(cat =>
                cat.name_he.includes('תוספ') || cat.name_he.includes('ציפס') || cat.name_he.includes('טבעות')
              )
              const addonItems = addonCat
                ? menuItems.filter(m => m.category_id === addonCat.id && m.is_active)
                : []
              const hasAddons = cart.some(c => addonCat && c.item.category_id === addonCat.id)
              if (!hasAddons && addonItems.length > 0) {
                return (
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ color: C.gold, fontWeight: 800, fontSize: 16, marginBottom: 12 }}>🍟 תוספות</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {addonItems.map(a => (
                        <div key={a.id} style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          background: C.bg, borderRadius: 14, padding: '10px 14px',
                          border: `1px solid ${C.border}`,
                        }}>
                          {/* תמונה */}
                          <div style={{ width: 60, height: 60, borderRadius: 10, overflow: 'hidden', flexShrink: 0, background: C.bgCard, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {a.image_url
                              ? <img src={a.image_url} alt={a.name_he} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontSize: 28 }}>🍟</span>}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ color: C.white, fontWeight: 700, fontSize: 15 }}>{a.name_he}</div>
                            {a.price && <div style={{ color: C.gold, fontSize: 13, marginTop: 2 }}>{fmt(a.price)}</div>}
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setCart(prev => [...prev, {
                                item: a, quantity: 1, sauces: [], salads: [],
                                paidAddons: [], noLettuce: false, notes: ''
                              }])
                            }}
                            style={{
                              background: C.gold, color: '#000', border: 'none',
                              borderRadius: 10, padding: '8px 18px', fontWeight: 800,
                              fontSize: 14, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', flexShrink: 0,
                            }}>+ הוסף</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              }
              return null
            })()}

            {/* כפתורים */}
            <button onClick={() => { setShowUpsell(false); setScreen('order') }}
              style={{
                width: '100%', padding: 15, background: C.gold, color: '#000',
                border: 'none', borderRadius: 14, fontSize: 16, fontWeight: 900,
                cursor: 'pointer', fontFamily: 'Heebo, sans-serif', marginBottom: 10,
              }}>
              המשך לתשלום ← {fmt(cartTotal)}
            </button>
            <button onClick={() => setShowUpsell(false)}
              style={{
                width: '100%', padding: 12, background: 'transparent',
                border: `1px solid ${C.border}`, borderRadius: 14, fontSize: 14,
                fontWeight: 600, color: C.gray, cursor: 'pointer', fontFamily: 'Heebo, sans-serif',
              }}>
              חזור לתפריט
            </button>
          </div>
        </div>
      )}

      {showBottomSheet && selectedItem && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400 }}>
          <div onClick={() => setShowBottomSheet(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.75)' }} />
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: C.bgCard, borderRadius: '24px 24px 0 0', maxHeight: '92vh', overflowY: 'auto', paddingBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 0' }}>
              <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, flex: 1, margin: '0 auto' }} />
              <button onClick={() => setShowBottomSheet(false)}
                style={{ background: C.border, border: 'none', borderRadius: 10, width: 34, height: 34, cursor: 'pointer', fontSize: 18, color: C.white, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✕</button>
            </div>

            {selectedItem.image_url
              ? <img src={selectedItem.image_url} alt={selectedItem.name_he} style={{ width: '100%', height: 220, objectFit: 'cover', marginTop: 8 }} />
              : <div style={{ width: '100%', height: 160, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8, fontSize: 56 }}>🧆</div>}

            <div style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                <h2 style={{ fontWeight: 900, fontSize: 22, color: C.white, margin: 0 }}>{selectedItem.name_he}</h2>
                {selectedItem.price ? <div style={{ fontWeight: 900, fontSize: 22, color: C.gold }}>{fmt(selectedItem.price)}</div> : null}
              </div>
              {selectedItem.description_he && (
                <p style={{ color: C.gray, fontSize: 14, margin: '4px 0 12px', lineHeight: 1.5 }}>{selectedItem.description_he}</p>
              )}
              <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
                {selectedItem.is_popular && <span style={{ background: 'rgba(255,215,0,0.15)', color: C.gold, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🔥 פופולרי</span>}
                {selectedItem.dietary_type === 'parve' && <span style={{ background: C.greenBg, color: C.green, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🌿 פרווה</span>}
                {selectedItem.dietary_type === 'meat' && <span style={{ background: C.redBg, color: C.red, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🥩 בשרי</span>}
              </div>

              {saladsOpts.length > 0 && !categories.find(c => c.id === selectedItem?.category_id)?.name_he.includes('שתי') && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.white, marginBottom: 10 }}>🥗 סלטים</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {saladsOpts.filter(s => s.name_he !== 'חסה' || selectedItem?.has_lettuce).map(s => (
                      <DarkChip key={s.id} label={s.name_he}
                        selected={sheetSalads.includes(s.name_he)}
                        onToggle={() => setSheetSalads(prev => prev.includes(s.name_he) ? prev.filter(x => x !== s.name_he) : [...prev, s.name_he])} />
                    ))}
                  </div>
                </div>
              )}

              {sauces.length > 0 && !categories.find(c => c.id === selectedItem?.category_id)?.name_he.includes('שתי') && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.white, marginBottom: 10 }}>🧄 רטבים</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {sauces.map(s => (
                      <DarkChip key={s.id} label={s.name_he} selected={sheetSauces.includes(s.name_he)}
                        onToggle={() => setSheetSauces(prev => prev.includes(s.name_he) ? prev.filter(x => x !== s.name_he) : [...prev, s.name_he])} />
                    ))}
                  </div>
                </div>
              )}

              {paidAddonsOpts.length > 0 && !categories.find(c => c.id === selectedItem?.category_id)?.name_he.includes('שתי') && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.white, marginBottom: 10 }}>➕ תוספות בתשלום</div>
                  {paidAddonsOpts.filter(a => (a.name_he !== 'פיתה' || selectedItem?.has_pita) && (a.name_he !== 'ביצה קשה' || selectedItem?.has_egg !== false)).map(a => (
                    <label key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input type="checkbox" checked={sheetPaidAddons.includes(a.name_he)}
                          onChange={() => setSheetPaidAddons(prev => prev.includes(a.name_he) ? prev.filter(x => x !== a.name_he) : [...prev, a.name_he])}
                          style={{ width: 20, height: 20, accentColor: C.gold, cursor: 'pointer' }} />
                        <span style={{ fontWeight: 600, fontSize: 15, color: C.white }}>{a.name_he}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: C.gold }}>+₪{a.price ?? 4}</span>
                    </label>
                  ))}
                </div>
              )}

              <div style={{ marginBottom: 22 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.white, marginBottom: 10 }}>📝 הערות</div>
                <textarea value={sheetNotes} onChange={e => setSheetNotes(e.target.value)}
                  placeholder="הערות מיוחדות..."
                  style={{ width: '100%', padding: 12, border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 14, fontFamily: 'Heebo, sans-serif', resize: 'none', height: 80, boxSizing: 'border-box', outline: 'none', background: C.bg, color: C.white }} />
              </div>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.bg, borderRadius: 12, padding: '11px 16px', border: `1px solid ${C.border}` }}>
                  <button onClick={() => setSheetQty(q => Math.max(1, q - 1))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: C.gold, fontWeight: 700, lineHeight: 1 }}>−</button>
                  <span style={{ fontWeight: 900, fontSize: 18, minWidth: 24, textAlign: 'center', color: C.white }}>{sheetQty}</span>
                  <button onClick={() => setSheetQty(q => q + 1)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: C.gold, fontWeight: 700, lineHeight: 1 }}>+</button>
                </div>
                <button onClick={addToCart}
                  style={{ flex: 1, padding: 15, background: C.gold, color: '#000', border: 'none', borderRadius: 14, fontSize: 16, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', boxShadow: '0 4px 20px rgba(255,215,0,0.3)' }}>
                  {editCartIndex !== null ? '✅ עדכן מנה' : 'הוסף לסל'} • {fmt(((selectedItem.price || 0) + sheetPaidAddons.reduce((s, name) => {
                    const t = toppings.find(t => t.name_he === name); return s + (t?.price ?? 4)
                  }, 0)) * sheetQty)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── DARK CHIP ─── */
function DarkChip({ label, selected, onToggle, disabled, danger }: {
  label: string; selected: boolean; onToggle: () => void
  disabled?: boolean; danger?: boolean
}) {
  const selBorder = danger ? '#FF6B6B' : '#FFD700'
  const selBg = danger ? 'rgba(255,107,107,0.15)' : 'rgba(255,215,0,0.15)'
  const selColor = danger ? '#FF6B6B' : '#FFD700'
  return (
    <button onClick={onToggle} disabled={disabled}
      style={{ padding: '7px 14px', borderRadius: 20, border: `1px solid ${selected ? selBorder : '#2A2A2A'}`, background: selected ? selBg : 'transparent', color: selected ? selColor : '#B0B0B0', fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'Heebo, sans-serif', opacity: disabled ? 0.35 : 1, transition: 'all 0.12s' }}>
      {label}
    </button>
  )
}