'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

/* ─── TYPES ─── */
type Branch = { id: string; name: string; address: string }
type Category = { id: string; name_he: string; sort_order: number }
type MenuItem = {
  id: string; category_id: string; name_he: string; name_en: string
  description_he: string; dietary_type: 'parve' | 'meat' | 'dairy'
  is_popular: boolean; is_active: boolean; image_url: string | null
  price?: number
}
type Topping = { id: string; name_he: string; type: 'spread' | 'filling' | 'paid_addon'; sort_order: number }
type CartItem = {
  item: MenuItem; quantity: number
  sauces: string[]; salads: string[]; paidAddons: string[]
  noLettuce: boolean; notes: string
}
type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'ready' | 'delivered'
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
  pending: 'ממתינה לאישור', confirmed: 'אושרה',
  preparing: 'בהכנה', ready: 'מוכנה לאיסוף', delivered: 'הוגשה',
}
const STATUS_ICONS: Record<OrderStatus, string> = {
  pending: '⏳', confirmed: '✅', preparing: '👨‍🍳', ready: '🔔', delivered: '🎉',
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

  const [orderPhone, setOrderPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit'>('cash')
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('pending')

  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    const saved = localStorage.getItem('falafel_session')
    if (saved) {
      try {
        const s = JSON.parse(saved)
        if (s.orderId && s.expires > Date.now()) {
          setOrderId(s.orderId); setScreen('tracking'); return
        }
        // Restore branch + cart if mid-order
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
      supabase.from('menu_items').select('*').eq('is_active', true),
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
      supabase.from('menu_items').select('*').eq('is_active', true),
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

  const cartTotal = cart.reduce((sum, c) => sum + ((c.item.price || 0) + c.paidAddons.length * 4) * c.quantity, 0)
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)

  // Save session on every cart/screen change
  useEffect(() => {
    if (screen === 'branch' || screen === 'tracking') return
    if (!selectedBranch) return
    const saved = localStorage.getItem('falafel_session')
    try {
      const s = saved ? JSON.parse(saved) : {}
      if (s.orderId) return // don't overwrite active order
    } catch {}
    localStorage.setItem('falafel_session', JSON.stringify({
      branch: selectedBranch, cart, screen, expires: Date.now() + 6 * 3600 * 1000
    }))
  }, [cart, screen, selectedBranch])

  function openItem(item: MenuItem) {
    setSelectedItem(item); setSheetSauces([]); setSheetSalads([])
    setSheetPaidAddons([]); setSheetNoLettuce(false); setSheetNotes(''); setSheetQty(1)
    setShowBottomSheet(true)
  }

  function addToCart() {
    if (!selectedItem) return
    const newItem: CartItem = {
      item: selectedItem, quantity: sheetQty, sauces: sheetSauces,
      salads: sheetNoLettuce ? sheetSalads.filter(s => s !== 'חסה') : sheetSalads,
      paidAddons: sheetPaidAddons, noLettuce: sheetNoLettuce, notes: sheetNotes,
    }
    setCart(prev => {
      const idx = prev.findIndex(c => c.item.id === selectedItem.id)
      if (idx >= 0) {
        const u = [...prev]; u[idx] = { ...u[idx], quantity: u[idx].quantity + sheetQty }; return u
      }
      return [...prev, newItem]
    })
    setShowBottomSheet(false)
  }

  async function placeOrder() {
    if (!selectedBranch || !isValidPhone(orderPhone) || cart.length === 0) return
    setPlacingOrder(true)
    const { data: order, error } = await supabase.from('orders').insert([{
      branch_id: selectedBranch.id,
      phone: orderPhone.replace(/[-\s]/g, ''),
      payment_method: paymentMethod,
      status: 'pending',
      total_price: cartTotal,
    }]).select().single()

    if (error || !order) { setPlacingOrder(false); return }

    await supabase.from('order_items').insert(
      cart.map(c => ({
        order_id: order.id, menu_item_id: c.item.id, quantity: c.quantity,
        price: (c.item.price || 0) + c.paidAddons.length * 4,
        toppings: JSON.stringify({ sauces: c.sauces, salads: c.salads, paidAddons: c.paidAddons }),
        notes: c.notes,
      }))
    )
    localStorage.setItem('falafel_session', JSON.stringify({ orderId: order.id, expires: Date.now() + 6 * 3600 * 1000 }))
    setOrderId(order.id); setOrderStatus('pending'); setCart([])
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
      {/* Hero */}
      <div style={{ padding: '56px 24px 44px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', borderBottom: `1px solid ${C.border}` }}>
        <img src={LOGO} alt="פלאפל בתחנה" style={{ width: 150, height: 150, objectFit: 'contain', marginBottom: 16 }} />
        <h1 style={{ color: C.white, fontSize: 28, fontWeight: 900, margin: '0 0 6px', letterSpacing: -0.5 }}>פלאפל בתחנה</h1>
        <p style={{ color: C.gray, fontSize: 15, margin: 0 }}>בחר סניף להזמנה</p>
      </div>

      {/* Branches */}
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
      </div>
    </div>
  )

  /* ── TRACKING SCREEN ── */
  if (screen === 'tracking') {
    const steps: OrderStatus[] = ['pending', 'confirmed', 'preparing', 'ready', 'delivered']
    const currentStep = steps.indexOf(orderStatus)
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
        <div style={{ padding: '36px 24px 28px', textAlign: 'center', borderBottom: `1px solid ${C.border}` }}>
          <img src={LOGO} alt="" style={{ width: 70, height: 70, objectFit: 'contain', marginBottom: 12 }} />
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
          <button onClick={() => { localStorage.removeItem('falafel_session'); setOrderId(null); setCart([]); setScreen('branch') }}
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
        {/* Cart items */}
        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 16 }}>📋 סיכום הזמנה</div>
          {cart.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 12, marginBottom: 12, borderBottom: i < cart.length - 1 ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.white }}>{c.item.name_he}</div>
                {c.sauces.length > 0 && <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>רטבים: {c.sauces.join(', ')}</div>}
                {c.salads.length > 0 && <div style={{ fontSize: 12, color: C.gray }}>מילויים: {c.salads.join(', ')}</div>}
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
                  {fmt(((c.item.price || 0) + c.paidAddons.length * 4) * c.quantity)}
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

        {/* Phone */}
        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 14 }}>📱 מספר טלפון</div>
          <input type="tel" value={orderPhone} onChange={e => setOrderPhone(e.target.value)}
            placeholder="05X-XXXXXXX" dir="ltr"
            style={{ width: '100%', padding: 14, border: `1px solid ${orderPhone && isValidPhone(orderPhone) ? C.green : C.border}`, borderRadius: 12, fontSize: 17, fontFamily: 'Heebo, sans-serif', outline: 'none', boxSizing: 'border-box', background: C.bg, color: C.white }} />
          {orderPhone && !isValidPhone(orderPhone) && (
            <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>מספר לא תקין — חייב להתחיל ב-05 ולהכיל 10 ספרות</div>
          )}
        </div>

        {/* Payment */}
        <div style={{ background: C.bgCard, borderRadius: 18, padding: 20, marginBottom: 24, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.white, marginBottom: 14 }}>💳 אמצעי תשלום</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {(['cash', 'credit'] as const).map(v => (
              <button key={v} onClick={() => setPaymentMethod(v)}
                style={{ padding: 14, border: `1px solid ${paymentMethod === v ? C.gold : C.border}`, borderRadius: 12, background: paymentMethod === v ? 'rgba(255,215,0,0.1)' : C.bg, fontWeight: 700, fontSize: 15, color: paymentMethod === v ? C.gold : C.gray, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
                {v === 'cash' ? '💵 מזומן' : '💳 אשראי'}
              </button>
            ))}
          </div>
        </div>

        <button onClick={placeOrder} disabled={!isValidPhone(orderPhone) || cart.length === 0 || placingOrder}
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

      {/* ── STICKY HEADER ── */}
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
          {/* Category tabs */}
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

      {/* ── MENU ITEMS ── */}
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {categories.map(cat => {
          const items = itemsByCategory[cat.id] || []
          if (items.length === 0) return null
          return (
            <div key={cat.id} ref={(el: HTMLDivElement | null) => { categoryRefs.current[cat.id] = el }} style={{ scrollMarginTop: 130 }}>
              {/* Category header */}
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

      {/* ── CART BUTTON ── */}
      {cartCount > 0 && (
        <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 300, maxWidth: 608, margin: '0 auto' }}>
          <button onClick={() => setScreen('order')}
            style={{ width: '100%', padding: '15px 20px', background: C.gold, color: '#000', border: 'none', borderRadius: 16, fontSize: 16, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 8px 32px rgba(255,215,0,0.35)' }}>
            <span style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 8, padding: '3px 10px', fontSize: 14 }}>{cartCount}</span>
            <span>לתשלום</span>
            <span>{fmt(cartTotal)}</span>
          </button>
        </div>
      )}

      {/* ── BOTTOM SHEET ── */}
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

              {sauces.length > 0 && (
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

              {saladsOpts.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.white, marginBottom: 10 }}>🥗 מילויים</div>
                  <div style={{ marginBottom: 10 }}>
                    <DarkChip label="🚫 ללא חסה" selected={sheetNoLettuce} danger
                      onToggle={() => setSheetNoLettuce(prev => !prev)} />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {saladsOpts.map(s => (
                      <DarkChip key={s.id} label={s.name_he}
                        selected={sheetSalads.includes(s.name_he)}
                        disabled={s.name_he === 'חסה' && sheetNoLettuce}
                        onToggle={() => setSheetSalads(prev => prev.includes(s.name_he) ? prev.filter(x => x !== s.name_he) : [...prev, s.name_he])} />
                    ))}
                  </div>
                </div>
              )}

              {paidAddonsOpts.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.white, marginBottom: 10 }}>➕ תוספות בתשלום</div>
                  {paidAddonsOpts.map(a => (
                    <label key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input type="checkbox" checked={sheetPaidAddons.includes(a.name_he)}
                          onChange={() => setSheetPaidAddons(prev => prev.includes(a.name_he) ? prev.filter(x => x !== a.name_he) : [...prev, a.name_he])}
                          style={{ width: 20, height: 20, accentColor: C.gold, cursor: 'pointer' }} />
                        <span style={{ fontWeight: 600, fontSize: 15, color: C.white }}>{a.name_he}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: C.gold }}>+₪4</span>
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
                  הוסף לסל • {fmt(((selectedItem.price || 0) + sheetPaidAddons.length * 4) * sheetQty)}
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