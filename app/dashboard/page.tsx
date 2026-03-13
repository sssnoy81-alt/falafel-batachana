'use client'
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../lib/supabase'

/* ── TYPES ── */
type OrderStatus = 'received' | 'confirmed' | 'preparing' | 'ready' | 'delivered'
type OrderItem = { id: string; item_id: string; quantity: number; unit_price: number; notes: string; name_he?: string }
type Order = {
  id: string; phone: string; status: OrderStatus; total_price: number
  payment_method: string; created_at: string; branch_id: string
  items?: OrderItem[]
}

/* ── THEME ── */
const C = {
  bg: '#0D0D0D', card: '#1A1A1A', border: '#2A2A2A',
  gold: '#FFD700', white: '#FFFFFF', gray: '#B0B0B0',
  received: { bg: 'rgba(99,102,241,0.15)', border: '#6366F1', text: '#A5B4FC', label: 'חדשות 🆕' },
  confirmed: { bg: 'rgba(234,179,8,0.15)', border: '#EAB308', text: '#FDE047', label: 'אושרה ✅' },
  preparing: { bg: 'rgba(249,115,22,0.15)', border: '#F97316', text: '#FDBA74', label: 'בהכנה 👨‍🍳' },
  ready:     { bg: 'rgba(34,197,94,0.15)',  border: '#22C55E', text: '#86EFAC', label: 'מוכנה 🔔' },
  delivered: { bg: 'rgba(100,116,139,0.15)',border: '#64748B', text: '#94A3B8', label: 'נמסרה ✓' },
}

const STATUS_ORDER: OrderStatus[] = ['received', 'confirmed', 'preparing', 'ready', 'delivered']

const NEXT_STATUS: Record<OrderStatus, OrderStatus | null> = {
  received: 'confirmed', confirmed: 'preparing',
  preparing: 'ready', ready: 'delivered', delivered: null,
}

const NEXT_LABEL: Record<OrderStatus, string> = {
  received: 'אשר הזמנה', confirmed: 'התחל הכנה',
  preparing: 'סמן מוכן', ready: 'נמסר ✓', delivered: '',
}

const fmt = (n: number) => `₪${Math.round(n || 0)}`
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

/* ══════════════════════════════
   MAIN
══════════════════════════════ */
export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [customers, setCustomers] = useState<{phone: string; count: number; total: number}[]>([])
  const [tab, setTab] = useState<'orders' | 'customers'>('orders')
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null)
  const [newOrderIds, setNewOrderIds] = useState<Set<string>>(new Set())
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const fetchOrders = useCallback(async () => {
    const today = new Date().toISOString().split('T')[0]
    const { data: ordersData } = await supabase
      .from('orders')
      .select('*')
      .gte('created_at', `${today}T00:00:00`)
      .lte('created_at', `${today}T23:59:59`)
      .order('created_at', { ascending: false })

    if (!ordersData) return

    // Fetch items for each order
    const orderIds = ordersData.map((o: any) => o.id)
    if (orderIds.length > 0) {
      const { data: itemsData } = await supabase
        .from('order_items')
        .select('*')
        .in('order_id', orderIds)

      const { data: menuData } = await supabase
        .from('menu_items')
        .select('id, name_he')

      const menuMap: Record<string, string> = {}
      for (const m of (menuData || [])) menuMap[m.id] = m.name_he

      const itemsByOrder: Record<string, OrderItem[]> = {}
      for (const item of (itemsData || [])) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = []
        itemsByOrder[item.order_id].push({ ...item, name_he: menuMap[item.item_id] || '?' })
      }

      const enriched = ordersData.map((o: any) => ({ ...o, items: itemsByOrder[o.id] || [] }))

      // Detect new received orders
      setOrders(prev => {
        const prevIds = new Set(prev.map(o => o.id))
        const newIds = enriched.filter((o: Order) => o.status === 'received' && !prevIds.has(o.id)).map((o: Order) => o.id)
        if (newIds.length > 0) {
          setNewOrderIds(ids => new Set([...ids, ...newIds]))
          setTimeout(() => setNewOrderIds(ids => { const n = new Set(ids); newIds.forEach(id => n.delete(id)); return n }), 4000)
        }
        return enriched
      })
    } else {
      setOrders([])
    }
    setLoading(false)
  }, [])

  const fetchCustomers = useCallback(async () => {
    const { data } = await supabase.from('orders').select('phone, total_price')
    if (!data) return
    const map: Record<string, { count: number; total: number }> = {}
    for (const o of data) {
      if (!o.phone) continue
      if (!map[o.phone]) map[o.phone] = { count: 0, total: 0 }
      map[o.phone].count++
      map[o.phone].total += o.total_price || 0
    }
    setCustomers(Object.entries(map).map(([phone, v]) => ({ phone, ...v })).sort((a, b) => b.count - a.count))
  }, [])

  useEffect(() => {
    fetchOrders()
    fetchCustomers()
    const interval = setInterval(fetchOrders, 20000)
    return () => clearInterval(interval)
  }, [fetchOrders, fetchCustomers])

  async function updateStatus(order: Order, next: OrderStatus) {
    setUpdatingId(order.id)
    await supabase.from('orders').update({ status: next }).eq('id', order.id)
    setOrders(prev => prev.map(o => o.id === order.id ? { ...o, status: next } : o))
    setUpdatingId(null)
  }

  const todayOrders = orders.filter(o => o.status !== 'delivered')
  const deliveredOrders = orders.filter(o => o.status === 'delivered')
  const newCount = orders.filter(o => o.status === 'received').length

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, fontFamily: 'Heebo, sans-serif' }}>
      <div style={{ textAlign: 'center', color: C.gold }}>🧆 טוען הזמנות...</div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', direction: 'rtl', color: C.white }}>

      {/* ── HEADER ── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 24 }}>🧆</span>
          <div>
            <div style={{ fontWeight: 900, fontSize: 18, color: C.white }}>פלאפל בתחנה</div>
            <div style={{ fontSize: 11, color: C.gray }}>ניהול הזמנות — {new Date().toLocaleDateString('he-IL')}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {newCount > 0 && (
            <div style={{ background: C.gold, color: '#000', borderRadius: 20, padding: '4px 12px', fontWeight: 800, fontSize: 14, animation: 'pulse 1s infinite' }}>
              🆕 {newCount} חדשות!
            </div>
          )}
          <button onClick={fetchOrders} style={{ background: C.border, border: 'none', color: C.gray, padding: '8px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', fontSize: 13 }}>
            🔄 רענן
          </button>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${C.border}`, background: C.card }}>
        {[
          { k: 'orders', label: `📋 הזמנות היום (${orders.length})` },
          { k: 'customers', label: `👥 לקוחות (${customers.length})` },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k as any)}
            style={{ flex: 1, padding: '12px', background: 'transparent', border: 'none', borderBottom: tab === t.k ? `2px solid ${C.gold}` : '2px solid transparent', color: tab === t.k ? C.gold : C.gray, fontWeight: tab === t.k ? 700 : 400, fontSize: 14, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── ORDERS TAB ── */}
      {tab === 'orders' && (
        <div style={{ padding: '16px' }}>

          {orders.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: C.gray }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>😴</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>אין הזמנות היום עדיין</div>
            </div>
          )}

          {/* Status columns */}
          {STATUS_ORDER.filter(s => s !== 'delivered').map(status => {
            const statusOrders = orders.filter(o => o.status === status)
            if (statusOrders.length === 0) return null
            const sc = C[status]
            return (
              <div key={status} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <div style={{ height: 3, width: 20, background: sc.border, borderRadius: 2 }} />
                  <div style={{ fontWeight: 900, fontSize: 16, color: sc.text }}>{sc.label}</div>
                  <div style={{ background: sc.bg, border: `1px solid ${sc.border}`, borderRadius: 20, padding: '2px 10px', fontSize: 13, fontWeight: 700, color: sc.text }}>{statusOrders.length}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                  {statusOrders.map(order => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      isNew={newOrderIds.has(order.id)}
                      isExpanded={expandedOrder === order.id}
                      isUpdating={updatingId === order.id}
                      onToggle={() => setExpandedOrder(prev => prev === order.id ? null : order.id)}
                      onUpdate={updateStatus}
                    />
                  ))}
                </div>
              </div>
            )
          })}

          {/* Delivered today */}
          {deliveredOrders.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ height: 3, width: 20, background: C[`delivered` as const].border, borderRadius: 2 }} />
                <div style={{ fontWeight: 900, fontSize: 16, color: C.delivered.text }}>{C.delivered.label}</div>
                <div style={{ background: C.delivered.bg, border: `1px solid ${C.delivered.border}`, borderRadius: 20, padding: '2px 10px', fontSize: 13, fontWeight: 700, color: C.delivered.text }}>{deliveredOrders.length}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                {deliveredOrders.map(order => (
                  <OrderCard key={order.id} order={order} isNew={false} isExpanded={expandedOrder === order.id}
                    isUpdating={false} onToggle={() => setExpandedOrder(prev => prev === order.id ? null : order.id)} onUpdate={updateStatus} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CUSTOMERS TAB ── */}
      {tab === 'customers' && (
        <div style={{ padding: '16px' }}>
          {customers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: C.gray }}>אין נתוני לקוחות עדיין</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {customers.map((c, i) => (
                <div key={c.phone} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,215,0,0.15)', border: `1px solid ${C.gold}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 16, color: C.gold, flexShrink: 0 }}>
                    {i + 1}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 16, color: C.white, direction: 'ltr' }}>{c.phone}</div>
                    <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>{c.count} הזמנות</div>
                  </div>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontWeight: 900, fontSize: 18, color: C.gold }}>{fmt(c.total)}</div>
                    <div style={{ fontSize: 11, color: C.gray }}>סה"כ</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
        @keyframes glow { 0%,100%{box-shadow:0 0 12px rgba(255,215,0,0.4)} 50%{box-shadow:0 0 28px rgba(255,215,0,0.9)} }
      `}</style>
    </div>
  )
}

/* ── ORDER CARD ── */
function OrderCard({ order, isNew, isExpanded, isUpdating, onToggle, onUpdate }: {
  order: Order; isNew: boolean; isExpanded: boolean; isUpdating: boolean
  onToggle: () => void; onUpdate: (o: Order, s: OrderStatus) => void
}) {
  const sc = C[order.status]
  const next = NEXT_STATUS[order.status]

  return (
    <div style={{
      background: C.card, border: `2px solid ${isNew ? '#FFD700' : sc.border}`,
      borderRadius: 16, overflow: 'hidden',
      animation: isNew ? 'glow 1s ease-in-out 3' : 'none',
      transition: 'border-color 0.3s'
    }}>
      {/* Card Header */}
      <div onClick={onToggle} style={{ padding: '14px 16px', cursor: 'pointer', background: sc.bg, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 20, color: sc.text }}>#{order.id.slice(-4).toUpperCase()}</div>
          <div style={{ fontSize: 12, color: C.gray }}>{fmtTime(order.created_at)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 18, color: '#FFD700' }}>{fmt(order.total_price)}</div>
          <span style={{ color: C.gray, fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Phone + Payment */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.white, direction: 'ltr' }}>📱 {order.phone || '—'}</div>
        <div style={{ fontSize: 12, color: C.gray, background: C.border, padding: '3px 10px', borderRadius: 20 }}>
          {order.payment_method === 'cash' ? '💵 מזומן' : '💳 אשראי'}
        </div>
      </div>

      {/* Items - always visible summary */}
      <div style={{ padding: '12px 16px' }}>
        {(order.items || []).map((item, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, paddingBottom: 8, borderBottom: i < (order.items?.length || 0) - 1 ? `1px solid ${C.border}` : 'none' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.white }}>
                <span style={{ color: '#FFD700', fontWeight: 900 }}>×{item.quantity}</span> {item.name_he}
              </div>
              {item.notes && (
                <div style={{ fontSize: 12, color: C.gray, marginTop: 3, lineHeight: 1.4 }}>{item.notes}</div>
              )}
            </div>
            <div style={{ fontWeight: 700, color: '#FFD700', fontSize: 14, marginRight: 8 }}>{fmt(item.unit_price * item.quantity)}</div>
          </div>
        ))}

        {(order.items || []).length === 0 && (
          <div style={{ color: C.gray, fontSize: 13 }}>אין פרטי מנות</div>
        )}
      </div>

      {/* Action Button */}
      {next && (
        <div style={{ padding: '0 16px 14px' }}>
          <button
            onClick={() => onUpdate(order, next)}
            disabled={isUpdating}
            style={{
              width: '100%', padding: '12px', background: isUpdating ? C.border : sc.border,
              color: order.status === 'received' ? '#000' : C.white,
              border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 900,
              cursor: isUpdating ? 'not-allowed' : 'pointer', fontFamily: 'Heebo, sans-serif',
              transition: 'opacity 0.2s', opacity: isUpdating ? 0.6 : 1
            }}>
            {isUpdating ? '⏳ מעדכן...' : NEXT_LABEL[order.status]}
          </button>
        </div>
      )}

      {order.status === 'delivered' && (
        <div style={{ padding: '8px 16px 14px', textAlign: 'center', color: C.gray, fontSize: 13 }}>✓ הוגש</div>
      )}
    </div>
  )
}