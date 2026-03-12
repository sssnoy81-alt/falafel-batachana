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

/* ─── CONSTANTS ─── */
const C = {
  brown: '#7C4A1E',
  brownLight: '#9B6035',
  brownBg: '#FDF6F0',
  white: '#FFFFFF',
  gray: '#6B7280',
  grayLight: '#F3F4F6',
  border: '#E5E7EB',
  green: '#16A34A',
  red: '#DC2626',
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'ממתינה לאישור',
  confirmed: 'אושרה',
  preparing: 'בהכנה',
  ready: 'מוכנה לאיסוף',
  delivered: 'הוגשה',
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

  // Bottom sheet
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null)
  const [showBottomSheet, setShowBottomSheet] = useState(false)
  const [sheetSauces, setSheetSauces] = useState<string[]>([])
  const [sheetSalads, setSheetSalads] = useState<string[]>([])
  const [sheetPaidAddons, setSheetPaidAddons] = useState<string[]>([])
  const [sheetNoLettuce, setSheetNoLettuce] = useState(false)
  const [sheetNotes, setSheetNotes] = useState('')
  const [sheetQty, setSheetQty] = useState(1)

  // Order
  const [orderPhone, setOrderPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'credit'>('cash')
  const [placingOrder, setPlacingOrder] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('pending')

  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({})

  /* ── Init ── */
  useEffect(() => {
    const saved = localStorage.getItem('falafel_session')
    if (saved) {
      try {
        const s = JSON.parse(saved)
        if (s.orderId && s.expires > Date.now()) {
          setOrderId(s.orderId)
          setScreen('tracking')
          return
        }
      } catch {}
      localStorage.removeItem('falafel_session')
    }
    fetchBranches()
  }, [])

  async function fetchBranches() {
    const { data } = await supabase.from('branches').select('id, name, address').order('name')
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

  /* ── Cart helpers ── */
  const cartTotal = cart.reduce((sum, c) =>
    sum + ((c.item.price || 0) + c.paidAddons.length * 4) * c.quantity, 0)
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)

  function openItem(item: MenuItem) {
    setSelectedItem(item)
    setSheetSauces([])
    setSheetSalads([])
    setSheetPaidAddons([])
    setSheetNoLettuce(false)
    setSheetNotes('')
    setSheetQty(1)
    setShowBottomSheet(true)
  }

  function addToCart() {
    if (!selectedItem) return
    const newItem: CartItem = {
      item: selectedItem, quantity: sheetQty,
      sauces: sheetSauces,
      salads: sheetNoLettuce ? sheetSalads.filter(s => s !== 'חסה') : sheetSalads,
      paidAddons: sheetPaidAddons, noLettuce: sheetNoLettuce, notes: sheetNotes,
    }
    setCart(prev => {
      const idx = prev.findIndex(c => c.item.id === selectedItem.id)
      if (idx >= 0) {
        const u = [...prev]
        u[idx] = { ...u[idx], quantity: u[idx].quantity + sheetQty }
        return u
      }
      return [...prev, newItem]
    })
    setShowBottomSheet(false)
  }

  /* ── Place order ── */
  async function placeOrder() {
    if (!selectedBranch || !isValidPhone(orderPhone) || cart.length === 0) return
    setPlacingOrder(true)
    const { data: order, error } = await supabase.from('orders').insert([{
      branch_id: selectedBranch.id,
      phone: orderPhone.replace(/[-\s]/g, ''),
      payment_method: paymentMethod,
      status: 'pending',
      total: cartTotal,
    }]).select().single()

    if (error || !order) { setPlacingOrder(false); return }

    await supabase.from('order_items').insert(
      cart.map(c => ({
        order_id: order.id,
        menu_item_id: c.item.id,
        quantity: c.quantity,
        price: (c.item.price || 0) + c.paidAddons.length * 4,
        toppings: JSON.stringify({ sauces: c.sauces, salads: c.salads, paidAddons: c.paidAddons }),
        notes: c.notes,
      }))
    )

    localStorage.setItem('falafel_session', JSON.stringify({
      orderId: order.id, expires: Date.now() + 6 * 3600 * 1000
    }))
    setOrderId(order.id)
    setOrderStatus('pending')
    setCart([])
    setPlacingOrder(false)
    setScreen('tracking')
  }

  /* ── Poll tracking ── */
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

  /* ════════════════════════════════════════
     LOADING
  ════════════════════════════════════════ */
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.brownBg, fontFamily: 'Heebo, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <img src="https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg" alt="פלאפל בתחנה" style={{ width: 140, height: 140, objectFit: 'contain', marginBottom: 12 }} />
        <div style={{ color: C.gray, marginTop: 6 }}>טוען...</div>
      </div>
    </div>
  )

  /* ════════════════════════════════════════
     SCREEN: BRANCH
  ════════════════════════════════════════ */
  if (screen === 'branch') return (
    <div style={{ minHeight: '100vh', background: C.brownBg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.brown} 0%, ${C.brownLight} 100%)`, padding: '40px 24px 36px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <img src="https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg" alt="פלאפל בתחנה" style={{ width: 160, height: 160, objectFit: 'contain', marginBottom: 8 }} />
        <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, margin: 0, fontWeight: 600 }}>בחר סניף להזמנה</p>
      </div>
      <div style={{ padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
        {branches.map(b => (
          <button key={b.id} onClick={() => selectBranch(b)}
            style={{ width: '100%', background: C.white, border: `2px solid ${C.border}`, borderRadius: 18, padding: '18px 20px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer', textAlign: 'right', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', transition: 'border-color 0.15s', fontFamily: 'Heebo, sans-serif' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = C.brown)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = C.border)}>
            <div style={{ width: 48, height: 48, background: C.brownBg, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>📍</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 17, color: '#111827' }}>{b.name}</div>
              {b.address && <div style={{ fontSize: 13, color: C.gray, marginTop: 2 }}>{b.address}</div>}
            </div>
            <div style={{ color: C.brown, fontSize: 18 }}>←</div>
          </button>
        ))}
      </div>
    </div>
  )

  /* ════════════════════════════════════════
     SCREEN: TRACKING
  ════════════════════════════════════════ */
  if (screen === 'tracking') {
    const steps: OrderStatus[] = ['pending', 'confirmed', 'preparing', 'ready', 'delivered']
    const currentStep = steps.indexOf(orderStatus)
    return (
      <div style={{ minHeight: '100vh', background: C.brownBg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.brown} 0%, ${C.brownLight} 100%)`, padding: '28px 24px 24px', textAlign: 'center' }}>
          
          <h1 style={{ color: C.white, fontSize: 22, fontWeight: 800, margin: '10px 0 4px' }}>מעקב הזמנה</h1>
          <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>#{orderId?.slice(-6).toUpperCase()}</div>
        </div>
        <div style={{ padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ background: C.white, borderRadius: 20, padding: 28, boxShadow: '0 4px 20px rgba(0,0,0,0.08)', marginBottom: 16 }}>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 56 }}>{STATUS_ICONS[orderStatus]}</div>
              <div style={{ fontWeight: 800, fontSize: 22, color: '#111827', marginTop: 8 }}>{STATUS_LABELS[orderStatus]}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {steps.slice(0, 4).map((step, i) => (
                <div key={step} style={{ flex: 1, height: 7, borderRadius: 4, background: i <= currentStep ? C.brown : C.grayLight, transition: 'background 0.5s' }} />
              ))}
            </div>
          </div>
          <button onClick={() => { localStorage.removeItem('falafel_session'); setOrderId(null); setCart([]); setScreen('branch') }}
            style={{ width: '100%', padding: 15, background: C.brownBg, border: 'none', borderRadius: 14, fontWeight: 700, fontSize: 15, color: C.brown, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
            + הזמנה חדשה
          </button>
        </div>
      </div>
    )
  }

  /* ════════════════════════════════════════
     SCREEN: ORDER FORM
  ════════════════════════════════════════ */
  if (screen === 'order') return (
    <div style={{ minHeight: '100vh', background: C.brownBg, fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 100 }}>
        <button onClick={() => setScreen('menu')} style={{ background: C.grayLight, border: 'none', borderRadius: 10, padding: '8px 12px', cursor: 'pointer', fontSize: 18 }}>→</button>
        <div style={{ fontWeight: 800, fontSize: 18, color: '#111827' }}>סיום הזמנה</div>
      </div>

      <div style={{ padding: 16, maxWidth: 480, margin: '0 auto' }}>
        {/* Order summary */}
        <div style={{ background: C.white, borderRadius: 18, padding: 20, marginBottom: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#111827', marginBottom: 16 }}>📋 סיכום הזמנה</div>
          {cart.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 12, marginBottom: 12, borderBottom: i < cart.length - 1 ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{c.item.name_he}</div>
                {c.sauces.length > 0 && <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>רטבים: {c.sauces.join(', ')}</div>}
                {c.salads.length > 0 && <div style={{ fontSize: 12, color: C.gray }}>סלטים: {c.salads.join(', ')}</div>}
                {c.paidAddons.length > 0 && <div style={{ fontSize: 12, color: C.brown }}>תוספות: {c.paidAddons.join(', ')}</div>}
                {c.notes && <div style={{ fontSize: 12, color: C.gray, fontStyle: 'italic' }}>הערה: {c.notes}</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.grayLight, borderRadius: 10, padding: '5px 10px' }}>
                  <button onClick={() => setCart(prev => prev.map((x, ii) => ii === i ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.brown, fontWeight: 700, lineHeight: 1 }}>−</button>
                  <span style={{ fontWeight: 800, minWidth: 16, textAlign: 'center' }}>{c.quantity}</span>
                  <button onClick={() => setCart(prev => prev.map((x, ii) => ii === i ? { ...x, quantity: x.quantity + 1 } : x))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.brown, fontWeight: 700, lineHeight: 1 }}>+</button>
                </div>
                <span style={{ fontWeight: 800, color: C.brown, minWidth: 48, textAlign: 'left' }}>
                  {fmt(((c.item.price || 0) + c.paidAddons.length * 4) * c.quantity)}
                </span>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, borderTop: `2px solid ${C.border}`, fontWeight: 800, fontSize: 18 }}>
            <span>סה"כ</span>
            <span style={{ color: C.brown }}>{fmt(cartTotal)}</span>
          </div>
        </div>

        {/* Phone */}
        <div style={{ background: C.white, borderRadius: 18, padding: 20, marginBottom: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#111827', marginBottom: 14 }}>📱 מספר טלפון</div>
          <input type="tel" value={orderPhone} onChange={e => setOrderPhone(e.target.value)}
            placeholder="05X-XXXXXXX" dir="ltr"
            style={{ width: '100%', padding: '14px', border: `2px solid ${orderPhone && isValidPhone(orderPhone) ? C.green : C.border}`, borderRadius: 12, fontSize: 17, fontFamily: 'Heebo, sans-serif', outline: 'none', boxSizing: 'border-box' }} />
          {orderPhone && !isValidPhone(orderPhone) && (
            <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>מספר לא תקין — חייב להתחיל ב-05 ולהכיל 10 ספרות</div>
          )}
        </div>

        {/* Payment */}
        <div style={{ background: C.white, borderRadius: 18, padding: 20, marginBottom: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#111827', marginBottom: 14 }}>💳 אמצעי תשלום</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {(['cash', 'credit'] as const).map((v) => (
              <button key={v} onClick={() => setPaymentMethod(v)}
                style={{ padding: 14, border: `2px solid ${paymentMethod === v ? C.brown : C.border}`, borderRadius: 12, background: paymentMethod === v ? C.brownBg : C.white, fontWeight: 700, fontSize: 15, color: paymentMethod === v ? C.brown : C.gray, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
                {v === 'cash' ? '💵 מזומן' : '💳 אשראי'}
              </button>
            ))}
          </div>
        </div>

        <button onClick={placeOrder} disabled={!isValidPhone(orderPhone) || cart.length === 0 || placingOrder}
          style={{ width: '100%', padding: 17, background: isValidPhone(orderPhone) && cart.length > 0 ? C.brown : C.border, color: C.white, border: 'none', borderRadius: 16, fontSize: 18, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', boxShadow: isValidPhone(orderPhone) ? '0 6px 24px rgba(124,74,30,0.35)' : 'none' }}>
          {placingOrder ? '⏳ שולח הזמנה...' : `✅ שלח הזמנה • ${fmt(cartTotal)}`}
        </button>
      </div>
    </div>
  )

  /* ════════════════════════════════════════
     SCREEN: MENU
  ════════════════════════════════════════ */
  const itemsByCategory: Record<string, MenuItem[]> = {}
  for (const cat of categories) {
    itemsByCategory[cat.id] = menuItems.filter(m => m.category_id === cat.id)
  }

  return (
    <div style={{ minHeight: '100vh', background: C.white, fontFamily: 'Heebo, sans-serif', direction: 'rtl', paddingBottom: cartCount > 0 ? 96 : 0 }}>

      {/* ── STICKY HEADER ── */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 200 }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          {/* Brand row */}
          <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setScreen('branch')}
              style={{ background: C.grayLight, border: 'none', borderRadius: 10, padding: '8px 10px', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>→</button>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18, color: '#111827', letterSpacing: -0.3, display: 'flex', alignItems: 'center', gap: 8 }}>
                <img src="https://sqgnrzcmjhwgfjxocvlr.supabase.co/storage/v1/object/public/menu-images/logo-k.jpg" alt="לוגו" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 6 }} />
                פלאפל בתחנה
              </div>
              <div style={{ fontSize: 12, color: C.gray }}>{selectedBranch?.name}</div>
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
                style={{ flexShrink: 0, padding: '7px 16px', borderRadius: 20, border: `2px solid ${activeCategory === cat.id ? C.brown : C.border}`, background: activeCategory === cat.id ? C.brown : C.white, color: activeCategory === cat.id ? C.white : C.gray, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
                {cat.name_he}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── MENU ── */}
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {categories.map(cat => {
          const items = itemsByCategory[cat.id] || []
          if (items.length === 0) return null
          return (
            <div key={cat.id} ref={(el: HTMLDivElement | null) => { categoryRefs.current[cat.id] = el }} style={{ scrollMarginTop: 130 }}>
              <div style={{ padding: '22px 16px 10px', fontWeight: 900, fontSize: 20, color: '#111827', borderBottom: `1px solid ${C.border}` }}>
                {cat.name_he}
              </div>
              {items.map(item => (
                <button key={item.id} onClick={() => openItem(item)}
                  style={{ width: '100%', background: C.white, border: 'none', borderBottom: `1px solid ${C.border}`, padding: '16px', display: 'flex', gap: 14, alignItems: 'flex-start', cursor: 'pointer', textAlign: 'right', fontFamily: 'Heebo, sans-serif' }}>
                  <div style={{ flex: 1 }}>
                    {/* Badges */}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}>
                      {item.is_popular && <span style={{ background: '#FEF3C7', color: '#D97706', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>🔥 פופולרי</span>}
                      {item.dietary_type === 'parve' && <span style={{ background: '#DCFCE7', color: C.green, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>🌿 פרווה</span>}
                      {item.dietary_type === 'meat' && <span style={{ background: '#FEE2E2', color: C.red, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>🥩 בשרי</span>}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 3 }}>{item.name_he}</div>
                    {item.description_he && <div style={{ fontSize: 13, color: C.gray, marginBottom: 6, lineHeight: 1.4 }}>{item.description_he}</div>}
                    {item.price ? <div style={{ fontWeight: 800, fontSize: 16, color: C.brown }}>{fmt(item.price)}</div> : null}
                  </div>
                  {/* Image */}
                  <div style={{ width: 88, height: 88, flexShrink: 0, borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.border}`, background: C.brownBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
            style={{ width: '100%', padding: '15px 20px', background: C.brown, color: C.white, border: 'none', borderRadius: 16, fontSize: 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 8px 32px rgba(124,74,30,0.4)' }}>
            <span style={{ background: 'rgba(255,255,255,0.2)', borderRadius: 8, padding: '3px 10px', fontSize: 14 }}>{cartCount}</span>
            <span>לתשלום</span>
            <span>{fmt(cartTotal)}</span>
          </button>
        </div>
      )}

      {/* ── BOTTOM SHEET ── */}
      {showBottomSheet && selectedItem && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400 }}>
          {/* Overlay */}
          <div onClick={() => setShowBottomSheet(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
          {/* Sheet */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: C.white, borderRadius: '24px 24px 0 0', maxHeight: '92vh', overflowY: 'auto', paddingBottom: 32 }}>
            <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, margin: '12px auto 0' }} />

            {/* Image */}
            {selectedItem.image_url
              ? <img src={selectedItem.image_url} alt={selectedItem.name_he} style={{ width: '100%', height: 200, objectFit: 'cover', marginTop: 8 }} />
              : <div style={{ width: '100%', height: 160, background: C.brownBg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
                  
                </div>}

            <div style={{ padding: '18px 20px' }}>
              {/* Title + price */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                <h2 style={{ fontWeight: 900, fontSize: 22, color: '#111827', margin: 0 }}>{selectedItem.name_he}</h2>
                {selectedItem.price ? <div style={{ fontWeight: 800, fontSize: 20, color: C.brown }}>{fmt(selectedItem.price)}</div> : null}
              </div>
              {selectedItem.description_he && (
                <p style={{ color: C.gray, fontSize: 14, margin: '4px 0 12px', lineHeight: 1.5 }}>{selectedItem.description_he}</p>
              )}
              <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
                {selectedItem.is_popular && <span style={{ background: '#FEF3C7', color: '#D97706', fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🔥 פופולרי</span>}
                {selectedItem.dietary_type === 'parve' && <span style={{ background: '#DCFCE7', color: C.green, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🌿 פרווה</span>}
                {selectedItem.dietary_type === 'meat' && <span style={{ background: '#FEE2E2', color: C.red, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>🥩 בשרי</span>}
              </div>

              {/* Sauces */}
              {sauces.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 10 }}>🧄 רטבים</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {sauces.map(s => (
                      <Chip key={s.id} label={s.name_he} selected={sheetSauces.includes(s.name_he)}
                        onToggle={() => setSheetSauces(prev => prev.includes(s.name_he) ? prev.filter(x => x !== s.name_he) : [...prev, s.name_he])} />
                    ))}
                  </div>
                </div>
              )}

              {/* Salads */}
              {saladsOpts.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 10 }}>🥗 סלטים</div>
                  <div style={{ marginBottom: 10 }}>
                    <Chip label="🚫 ללא חסה" selected={sheetNoLettuce}
                      color={C.red} selectedBg="#FEE2E2"
                      onToggle={() => setSheetNoLettuce(prev => !prev)} />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {saladsOpts.map(s => (
                      <Chip key={s.id} label={s.name_he}
                        selected={sheetSalads.includes(s.name_he)}
                        disabled={s.name_he === 'חסה' && sheetNoLettuce}
                        onToggle={() => setSheetSalads(prev => prev.includes(s.name_he) ? prev.filter(x => x !== s.name_he) : [...prev, s.name_he])} />
                    ))}
                  </div>
                </div>
              )}

              {/* Paid addons */}
              {paidAddonsOpts.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 10 }}>➕ תוספות בתשלום</div>
                  {paidAddonsOpts.map(a => (
                    <label key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input type="checkbox" checked={sheetPaidAddons.includes(a.name_he)}
                          onChange={() => setSheetPaidAddons(prev => prev.includes(a.name_he) ? prev.filter(x => x !== a.name_he) : [...prev, a.name_he])}
                          style={{ width: 20, height: 20, accentColor: C.brown, cursor: 'pointer' }} />
                        <span style={{ fontWeight: 600, fontSize: 15 }}>{a.name_he}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: C.brown }}>+₪4</span>
                    </label>
                  ))}
                </div>
              )}

              {/* Notes */}
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 10 }}>📝 הערות</div>
                <textarea value={sheetNotes} onChange={e => setSheetNotes(e.target.value)}
                  placeholder="הערות מיוחדות..."
                  style={{ width: '100%', padding: 12, border: `2px solid ${C.border}`, borderRadius: 12, fontSize: 14, fontFamily: 'Heebo, sans-serif', resize: 'none', height: 80, boxSizing: 'border-box', outline: 'none' }} />
              </div>

              {/* Qty + Add */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.grayLight, borderRadius: 12, padding: '11px 16px' }}>
                  <button onClick={() => setSheetQty(q => Math.max(1, q - 1))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: C.brown, fontWeight: 700, lineHeight: 1 }}>−</button>
                  <span style={{ fontWeight: 900, fontSize: 18, minWidth: 24, textAlign: 'center' }}>{sheetQty}</span>
                  <button onClick={() => setSheetQty(q => q + 1)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: C.brown, fontWeight: 700, lineHeight: 1 }}>+</button>
                </div>
                <button onClick={addToCart}
                  style={{ flex: 1, padding: 15, background: C.brown, color: C.white, border: 'none', borderRadius: 14, fontSize: 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', boxShadow: '0 4px 16px rgba(124,74,30,0.35)' }}>
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

/* ─── CHIP COMPONENT ─── */
function Chip({ label, selected, onToggle, disabled, color, selectedBg }: {
  label: string; selected: boolean; onToggle: () => void
  disabled?: boolean; color?: string; selectedBg?: string
}) {
  const selColor = color || '#7C4A1E'
  const selBg = selectedBg || '#FDF6F0'
  return (
    <button onClick={onToggle} disabled={disabled}
      style={{ padding: '7px 14px', borderRadius: 20, border: `2px solid ${selected ? selColor : '#E5E7EB'}`, background: selected ? selBg : '#FFFFFF', color: selected ? selColor : '#6B7280', fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'Heebo, sans-serif', opacity: disabled ? 0.4 : 1, transition: 'all 0.12s' }}>
      {label}
    </button>
  )
}