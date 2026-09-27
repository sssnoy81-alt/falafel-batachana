'use client'

// Kitchen / staff board. SECURITY (FALAFEL-SN-06E): this page holds NO Supabase client, NO keys and NO
// passwords. Authentication is a server-verified HttpOnly session cookie; every read and write goes through
// the same-origin /api/kitchen/* routes, which enforce the session's branch scope.

import { useState, useEffect, useCallback, useRef } from 'react'
import { DELIVERY_MEAL_SURCHARGE, ORDER_TYPE_LABELS, PAYMENT_METHOD_LABELS, isPaymentMethod, paymentMethodText } from '@/lib/orderConfig'
import type { KitchenBranch, KitchenOrder, KitchenOrderItem, KitchenPublicUser, KitchenSessionResponse } from '@/lib/kitchenTypes'

/* ─── API helpers (same-origin; the session cookie is sent automatically) ─── */
class UnauthorizedError extends Error {}

async function kitchenFetch<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (res.status === 401) throw new UnauthorizedError()
  const json = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(json?.error ?? 'request_failed'), { status: res.status, code: json?.error })
  return json as T
}

/* ─── AUTH ─── */
type AuthUser = KitchenPublicUser

function LoginScreen({ onLogin }: { onLogin: (session: KitchenSessionResponse) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleLogin() {
    if (busy || !username.trim() || !password) return
    setBusy(true); setError('')
    try {
      await kitchenFetch('/api/kitchen/login', { method: 'POST', body: { username: username.trim(), password } })
      const session = await kitchenFetch<KitchenSessionResponse>('/api/kitchen/session')
      setPassword('')
      onLogin(session)
    } catch (e) {
      setError(e instanceof UnauthorizedError ? 'שם משתמש או סיסמה שגויים' : 'לא ניתן להתחבר כרגע. נסו שוב')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#0D0D0D',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Heebo, sans-serif', direction: 'rtl', padding: 20,
    }}>
      <div style={{
        background: '#111', border: '1px solid #2A2A2A', borderRadius: 24,
        padding: '40px 36px', maxWidth: 400, width: '100%',
        boxShadow: '0 0 60px rgba(255,215,0,0.08)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🧆</div>
          <div style={{ color: '#FFD700', fontSize: 22, fontWeight: 900, marginBottom: 4 }}>פלאפל בתחנה</div>
          <div style={{ color: '#6B7280', fontSize: 14 }}>מערכת ניהול הזמנות</div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ color: '#9CA3AF', fontSize: 13, marginBottom: 6, fontWeight: 600 }}>שם משתמש</div>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            autoComplete="username"
            autoCapitalize="none"
            dir="ltr"
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 12,
              border: '1px solid #2A2A2A', background: '#0D0D0D',
              color: '#fff', fontSize: 15, fontFamily: 'Heebo, sans-serif',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ color: '#9CA3AF', fontSize: 13, marginBottom: 6, fontWeight: 600 }}>סיסמה</div>
          <div style={{ position: 'relative' }}>
            <input
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="הזן סיסמה"
              autoComplete="current-password"
              dir="ltr"
              style={{
                width: '100%', padding: '12px 44px 12px 14px', borderRadius: 12,
                border: `1px solid ${error ? '#FF6B6B' : '#2A2A2A'}`, background: '#0D0D0D',
                color: '#fff', fontSize: 15, fontFamily: 'Heebo, sans-serif',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
            <button
              onClick={() => setShowPass(p => !p)}
              style={{
                position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', color: '#6B7280', cursor: 'pointer', fontSize: 18,
              }}
            >{showPass ? '🙈' : '👁️'}</button>
          </div>
        </div>

        {error && (
          <div style={{ color: '#FF6B6B', fontSize: 13, marginBottom: 16, textAlign: 'center', background: 'rgba(255,107,107,0.1)', borderRadius: 8, padding: '8px 12px' }}>
            ❌ {error}
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={busy}
          style={{
            width: '100%', padding: 14, background: '#FFD700', color: '#000',
            border: 'none', borderRadius: 14, fontSize: 17, fontWeight: 900,
            cursor: busy ? 'wait' : 'pointer', fontFamily: 'Heebo, sans-serif', opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? 'מתחבר…' : 'כניסה →'}
        </button>
      </div>
    </div>
  )
}

/* ─── TYPES (server contract: lib/kitchenTypes.ts) ─── */
type OrderStatus = 'received' | 'confirmed' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
type OrderItem = KitchenOrderItem
type Order = Omit<KitchenOrder, 'status'> & { status: OrderStatus }

const isDeliveryOrder = (order: Order) => order.type === 'delivery'
const paymentLabel = (v: string) => isPaymentMethod(v) ? PAYMENT_METHOD_LABELS[v] : (v || '—')

function DeliveryDetails({ order, large }: { order: Order; large?: boolean }) {
  const d = order.delivery
  const fs = large ? 20 : 12
  return (
    <div style={{ background: 'rgba(96,165,250,0.08)', border: `${large ? 2 : 1}px solid rgba(96,165,250,0.5)`, borderRadius: large ? 16 : 8, padding: large ? '16px 20px' : '6px 8px', marginBottom: large ? 16 : 6 }}>
      <div style={{ color: '#60A5FA', fontWeight: 900, fontSize: large ? 24 : 13, marginBottom: 4 }}>🛵 משלוח</div>
      {d ? (
        <>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: fs }}>📍 {d.address}</div>
          {d.courierNotes && <div style={{ color: '#FED7AA', fontSize: fs - 1, marginTop: 3 }}>📝 לשליח: {d.courierNotes}</div>}
          {(d.mealSurcharge > 0 || d.deliveryFee > 0) && (
            <div style={{ color: '#9CA3AF', fontSize: large ? 15 : 11, marginTop: 4 }}>
              {d.mealQuantity ? `תוספת מנות ${d.mealQuantity} × ₪${DELIVERY_MEAL_SURCHARGE} = ₪${d.mealSurcharge}` : ''}
              {d.mealQuantity && d.deliveryFee ? ' · ' : ''}
              {d.deliveryFee ? `דמי משלוח ₪${d.deliveryFee}` : ''}
            </div>
          )}
        </>
      ) : (
        <div style={{ color: '#9CA3AF', fontSize: fs }}>פרטי כתובת לא זמינים</div>
      )}
    </div>
  )
}

function csvDeliveryFields(o: Order) {
  const d = isDeliveryOrder(o) ? o.delivery : null
  return {
    'סוג הזמנה': ORDER_TYPE_LABELS[isDeliveryOrder(o) ? 'delivery' : 'pickup'],
    'כתובת': d?.address ?? '',
    'הערות לשליח': d?.courierNotes ?? '',
    'כמות מנות לחיוב משלוח': d ? d.mealQuantity : 0,
    'תוספת משלוח למנות': d ? d.mealSurcharge : 0,
    'דמי משלוח': d ? d.deliveryFee : 0,
  }
}

const STATUS_CONFIG: Record<OrderStatus, {
  label: string; color: string; bg: string; border: string;
  next: OrderStatus | null; nextLabel: string
}> = {
  received:  { label: 'חדשה',  color: '#FFD700', bg: 'rgba(255,215,0,0.1)',    border: 'rgba(255,215,0,0.4)',   next: 'confirmed', nextLabel: 'אשר הזמנה' },
  confirmed: { label: 'אושרה', color: '#60A5FA', bg: 'rgba(96,165,250,0.1)',   border: 'rgba(96,165,250,0.4)',  next: 'preparing', nextLabel: 'התחל הכנה' },
  preparing: { label: 'בהכנה', color: '#F97316', bg: 'rgba(249,115,22,0.1)',   border: 'rgba(249,115,22,0.4)',  next: 'ready',     nextLabel: 'מוכן' },
  ready:     { label: 'מוכנה', color: '#4ADE80', bg: 'rgba(74,222,128,0.1)',   border: 'rgba(74,222,128,0.4)',  next: 'delivered', nextLabel: 'נמסר' },
  delivered: { label: 'נמסרה', color: '#6B7280', bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.3)', next: null,        nextLabel: '' },
  cancelled: { label: 'בוטלה', color: '#FF6B6B', bg: 'rgba(255,107,107,0.08)', border: 'rgba(255,107,107,0.3)', next: null,        nextLabel: '' },
}

const STATUSES: OrderStatus[] = ['received', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled']

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })
}
function timeSince(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diff < 1) return 'עכשיו'
  if (diff < 60) return `לפני ${diff} דק'`
  return `לפני ${Math.floor(diff / 60)} שעות`
}

/* ─── זיהוי סוג פריט לפי שם ─── */
// זיהוי סוג פריט — מנות ראשיות לפי שם מדויק, שתייה לפי מילת מפתח, שאר = תוספת
const MAIN_KEYWORDS = [
  'פלאפל בפיתה', 'פלאפל בבגט', 'פלאפל בצלחת',
  'סביח בפיתה', 'סביח בבגט', 'סביח בצלחת',
  'תסביח בפיתה', 'תסביח בבגט',
  'שניצל בפיתה', 'שניצל בבגט',
  'חזה עוף בפיתה', 'חזה עוף בבגט',
  'המבורגר',
  'סלט חזה עוף', 'סלט שניצל',
  'עסקית המבורגר', 'עסקית חזה עוף', 'עסקית שניצל', 'עסקית פלאפל', 'עסקית סביח',
  'ארוחת ילדים',
]
const DRINK_KEYWORDS = ['פחית', 'זכוכית', 'מים', 'סודה', 'פיוז', 'קולה', 'זירו', 'ענבים', 'ספרייט']

function getItemType(name: string): 'addon' | 'drink' | 'main' {
  const n = (name || '').trim()
  if (DRINK_KEYWORDS.some(k => n.includes(k))) return 'drink'
  if (MAIN_KEYWORDS.some(k => n.includes(k))) return 'main'
  return 'addon'
}

function KitchenModal({ order, onClose, onDone }: {
  order: Order; onClose: () => void; onDone: (id: string) => void
}) {
  const num = order.dailyNumber ? String(order.dailyNumber).padStart(4, '0') : order.id.slice(-4).toUpperCase()
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.93)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0F0F0F', border: '3px solid #F97316', borderRadius: 28, padding: '36px 40px', maxWidth: 700, width: '100%', direction: 'rtl', boxShadow: '0 0 80px rgba(249,115,22,0.25)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ background: 'rgba(249,115,22,0.2)', border: '2px solid #F97316', borderRadius: 16, width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>🍳</div>
            <div>
              <div style={{ color: '#F97316', fontSize: 40, fontWeight: 900, lineHeight: 1 }}>#{num}</div>
              <div style={{ color: '#9CA3AF', fontSize: 16, marginTop: 6 }}>{formatTime(order.createdAt)} &nbsp;·&nbsp; {timeSince(order.createdAt)}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: '#1A1A1A', border: '1px solid #333', color: '#9CA3AF', borderRadius: 50, width: 48, height: 48, fontSize: 22, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>
        {isDeliveryOrder(order) && <DeliveryDetails order={order} large />}
        {(() => {
          const mains  = order.items.filter(oi => getItemType(oi.name) === 'main')
          const addons = order.items.filter(oi => getItemType(oi.name) === 'addon')
          const drinks = order.items.filter(oi => getItemType(oi.name) === 'drink')

          const renderMain = (oi: OrderItem) => {
            const parts = (oi.notes || '').split(' | ').filter(Boolean)
            const sauces = parts.find(p => p.startsWith('רטבים:'))
            const salads = parts.find(p => p.startsWith('סלטים:'))
            const note   = parts.find(p => !p.startsWith('רטבים:') && !p.startsWith('סלטים:') && !p.startsWith('תוספות:') && !p.startsWith('שתייה:'))
            return (
              <div key={oi.id} style={{ background: '#1A1A1A', border: '2px solid #2A2A2A', borderRadius: 18, padding: '20px 24px', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: sauces || salads || note ? 10 : 0 }}>
                  <div style={{ background: '#F97316', color: '#000', borderRadius: 14, minWidth: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 900, flexShrink: 0 }}>{oi.quantity}</div>
                  <div style={{ color: '#fff', fontSize: 28, fontWeight: 800, lineHeight: 1.2 }}>{oi.name}</div>
                </div>
                {sauces && <div style={{ color: '#9CA3AF', fontSize: 16, marginBottom: 4 }}>🧄 {sauces.replace('רטבים: ', '')}</div>}
                {salads && <div style={{ color: '#9CA3AF', fontSize: 16, marginBottom: 4 }}>🥗 {salads.replace('סלטים: ', '')}</div>}
                {note && (
                  <div style={{ background: 'rgba(249,115,22,0.15)', border: '2px solid rgba(249,115,22,0.6)', borderRadius: 12, padding: '12px 16px', marginTop: 8 }}>
                    <div style={{ color: '#F97316', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>📝 הערה:</div>
                    <div style={{ color: '#FED7AA', fontSize: 22, fontWeight: 800, lineHeight: 1.4 }}>{note}</div>
                  </div>
                )}
              </div>
            )
          }

          return (
            <div style={{ marginBottom: 36 }}>
              {/* מנות ראשיות */}
              {mains.map(renderMain)}

              {/* תוספות מרוכזות */}
              {addons.length > 0 && (
                <div style={{ background: 'rgba(255,215,0,0.06)', border: '1.5px solid rgba(255,215,0,0.25)', borderRadius: 16, padding: '16px 20px', marginBottom: 10 }}>
                  <div style={{ color: '#FFD700', fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🍟 תוספות</div>
                  {Object.entries(addons.reduce((acc, oi) => {
                    const n = oi.name
                    acc[n] = (acc[n] || 0) + oi.quantity
                    return acc
                  }, {} as Record<string,number>)).map(([name, qty]) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                      <div style={{ background: '#FFD700', color: '#000', borderRadius: 8, minWidth: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 900 }}>{qty}</div>
                      <div style={{ color: '#fff', fontSize: 20, fontWeight: 700 }}>{name}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* שתייה מרוכזת */}
              {drinks.length > 0 && (
                <div style={{ background: 'rgba(96,165,250,0.06)', border: '1.5px solid rgba(96,165,250,0.25)', borderRadius: 16, padding: '16px 20px', marginBottom: 10 }}>
                  <div style={{ color: '#60A5FA', fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🥤 שתייה</div>
                  {Object.entries(drinks.reduce((acc, oi) => {
                    const n = oi.name
                    acc[n] = (acc[n] || 0) + oi.quantity
                    return acc
                  }, {} as Record<string,number>)).map(([name, qty]) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                      <div style={{ background: '#60A5FA', color: '#000', borderRadius: 8, minWidth: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 900 }}>{qty}</div>
                      <div style={{ color: '#fff', fontSize: 20, fontWeight: 700 }}>{name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        <button onClick={() => { onDone(order.id); onClose() }} style={{ width: '100%', padding: '20px 0', background: '#4ADE80', color: '#000', border: 'none', borderRadius: 18, fontSize: 26, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
          ✅ מוכן — העבר להגשה
        </button>
      </div>
    </div>
  )
}

function OrderCard({ order, onAdvance, onKitchenOpen, onEdit }: {
  order: Order; onAdvance: (id: string, next: OrderStatus) => void
  onKitchenOpen?: (order: Order) => void; onEdit?: (order: Order) => void
}) {
  const cfg = STATUS_CONFIG[order.status]
  const isNew = order.status === 'received'
  const isPreparing = order.status === 'preparing'
  const num = order.dailyNumber ? String(order.dailyNumber).padStart(4, '0') : order.id.slice(-4).toUpperCase()

  return (
    <div
      onClick={isPreparing && onKitchenOpen ? () => onKitchenOpen(order) : undefined}
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 10, position: 'relative', animation: isNew ? 'pulse 2s infinite' : 'none', direction: 'rtl', cursor: isPreparing ? 'pointer' : 'default' }}
    >
      {isPreparing && (
        <div style={{ position: 'absolute', top: 8, right: 10, background: '#F97316', color: '#000', borderRadius: 6, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>🔍 הגדל</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: cfg.color, fontWeight: 700, fontSize: 15 }}>#{num}</span>
          <span style={{ color: '#9CA3AF', fontSize: 13 }}>{formatTime(order.createdAt)}</span>
          <span style={{ color: '#6B7280', fontSize: 12 }}>{timeSince(order.createdAt)}</span>
        </div>
        <div style={{ textAlign: 'left' }}>
          {order.customerName && <div style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>👤 {order.customerName}</div>}
          <div style={{ color: '#D1D5DB', fontSize: 13, direction: 'ltr' }}>📞 {order.phone}</div>
        </div>
      </div>
      {isDeliveryOrder(order) && <DeliveryDetails order={order} />}
      <div style={{ marginBottom: 10 }}>
        {(() => {
          const mains  = order.items.filter(oi => getItemType(oi.name) === 'main')
          const addons = order.items.filter(oi => getItemType(oi.name) === 'addon')
          const drinks = order.items.filter(oi => getItemType(oi.name) === 'drink')
          return (
            <>
              {/* מנות ראשיות */}
              {mains.map(oi => {
                const parts = (oi.notes || '').split(' | ').filter(Boolean)
                const sauces = parts.find(p => p.startsWith('רטבים:'))
                const salads = parts.find(p => p.startsWith('סלטים:'))
                const note   = parts.find(p => !p.startsWith('רטבים:') && !p.startsWith('סלטים:') && !p.startsWith('תוספות:') && !p.startsWith('שתייה:'))
                return (
                  <div key={oi.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '8px 10px', marginBottom: 5 }}>
                    <div style={{ color: '#fff', fontSize: 14, fontWeight: 800, marginBottom: sauces || salads || note ? 5 : 0 }}>
                      <span style={{ color: cfg.color, fontWeight: 900 }}>{oi.quantity}×</span>{' '}{oi.name}
                    </div>
                    {sauces && <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 2 }}>🧄 {sauces.replace('רטבים: ', '')}</div>}
                    {salads && <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 2 }}>🥗 {salads.replace('סלטים: ', '')}</div>}
                    {note && (
                      <div style={{ background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.5)', borderRadius: 6, padding: '4px 8px', marginTop: 3, display: 'flex', gap: 4 }}>
                        <span style={{ fontSize: 11 }}>📝</span>
                        <span style={{ color: '#FED7AA', fontSize: 12, fontWeight: 800 }}>{note}</span>
                      </div>
                    )}
                  </div>
                )
              })}
              {/* תוספות — מרוכז לפי שם */}
              {addons.length > 0 && (
                <div style={{ background: 'rgba(255,215,0,0.05)', border: '1px solid rgba(255,215,0,0.2)', borderRadius: 8, padding: '5px 8px', marginBottom: 5 }}>
                  {Object.entries(addons.reduce((acc, oi) => {
                    const n = oi.name
                    acc[n] = (acc[n] || 0) + oi.quantity
                    return acc
                  }, {} as Record<string,number>)).map(([name, qty]) => (
                    <div key={name} style={{ fontSize: 12, color: '#FFD700', fontWeight: 700 }}>
                      🍟 <span style={{ fontWeight: 900 }}>{qty}×</span> {name}
                    </div>
                  ))}
                </div>
              )}
              {/* שתייה — מרוכז לפי שם */}
              {drinks.length > 0 && (
                <div style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: 8, padding: '5px 8px' }}>
                  {Object.entries(drinks.reduce((acc, oi) => {
                    const n = oi.name
                    acc[n] = (acc[n] || 0) + oi.quantity
                    return acc
                  }, {} as Record<string,number>)).map(([name, qty]) => (
                    <div key={name} style={{ fontSize: 12, color: '#60A5FA', fontWeight: 700 }}>
                      🥤 <span style={{ fontWeight: 900 }}>{qty}×</span> {name}
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        })()}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 15 }}>₪{order.totalPrice}</span>
          {isDeliveryOrder(order) && <span style={{ background: 'rgba(96,165,250,0.2)', color: '#60A5FA', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 800 }}>🛵 משלוח</span>}
          <span style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '2px 8px', color: '#9CA3AF', fontSize: 11 }}>
            {paymentLabel(order.paymentMethod)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(order.status === 'confirmed' || order.status === 'preparing') && onEdit && (
            <button onClick={e => { e.stopPropagation(); onEdit(order) }} style={{ background: 'transparent', color: '#FFD700', border: '1px solid #FFD700', borderRadius: 6, padding: '4px 8px', fontWeight: 700, fontSize: 11, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', whiteSpace: 'nowrap' }}>✏️</button>
          )}
          {(order.status === 'confirmed' || order.status === 'preparing') && (
            <button onClick={e => { e.stopPropagation(); if(confirm('לבטל הזמנה #' + num + '?')) onAdvance(order.id, 'cancelled') }} style={{ background: 'transparent', color: '#FF6B6B', border: '1px solid #FF6B6B', borderRadius: 6, padding: '4px 8px', fontWeight: 700, fontSize: 11, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', whiteSpace: 'nowrap' }}>✕</button>
          )}
          {cfg.next && (
            <button onClick={e => { e.stopPropagation(); onAdvance(order.id, cfg.next!) }} style={{ background: cfg.color, color: '#000', border: 'none', borderRadius: 8, padding: '6px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>{cfg.nextLabel}</button>
          )}
        </div>
      </div>
    </div>
  )
}

function CustomerTab({ orders }: { orders: Order[] }) {
  const byPhone: Record<string, Order[]> = {}
  orders.forEach(o => { if (!byPhone[o.phone]) byPhone[o.phone] = []; byPhone[o.phone].push(o) })
  const customers = Object.entries(byPhone)
    .map(([phone, ords]) => ({ phone, orders: ords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), total: ords.reduce((s, o) => s + o.totalPrice, 0) }))
    .sort((a, b) => b.total - a.total)

  return (
    <div style={{ padding: '0 4px' }}>
      {customers.length === 0 && <div style={{ color: '#6B7280', textAlign: 'center', marginTop: 40 }}>אין היסטוריית לקוחות</div>}
      {customers.map(c => (
        <div key={c.phone} style={{ background: '#1A1A1A', border: '1px solid #2A2A2A', borderRadius: 12, padding: '14px 16px', marginBottom: 10, direction: 'rtl' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ color: '#E5E7EB', fontSize: 14, direction: 'ltr' }}>📞 {c.phone}</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <span style={{ color: '#9CA3AF', fontSize: 12 }}>{c.orders.length} הזמנות</span>
              <span style={{ color: '#FFD700', fontWeight: 700 }}>₪{c.total}</span>
            </div>
          </div>
          {c.orders[0]?.customerName && <div style={{ color: '#9CA3AF', fontSize: 12, marginBottom: 6 }}>👤 {c.orders[0].customerName}</div>}
          {c.orders.slice(0, 3).map(o => (
            <div key={o.id} style={{ fontSize: 12, color: '#6B7280', borderTop: '1px solid #2A2A2A', paddingTop: 6, marginTop: 6 }}>
              <span style={{ color: STATUS_CONFIG[o.status].color }}>●</span>{' '}
              {formatDate(o.createdAt)} {formatTime(o.createdAt)} — ₪{o.totalPrice} ({o.items.length} פריטים)
            </div>
          ))}
          {c.orders.length > 3 && <div style={{ color: '#4B5563', fontSize: 11, marginTop: 4 }}>+ עוד {c.orders.length - 3} הזמנות</div>}
        </div>
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════ */
export default function OrdersPage() {
  // The server session (HttpOnly cookie) is authoritative; this is only its client-side mirror.
  const [session, setSession] = useState<KitchenSessionResponse | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    try { localStorage.removeItem('dashboard_user') } catch {} // remove the old client-side "login" if present
    kitchenFetch<KitchenSessionResponse>('/api/kitchen/session')
      .then(s => { if (!cancelled) setSession(s) })
      .catch(() => { if (!cancelled) setSession(null) }) // 401 / error → login screen
      .finally(() => { if (!cancelled) setAuthChecked(true) })
    return () => { cancelled = true }
  }, [])

  const handleUnauthorized = useCallback(() => setSession(null), [])

  async function handleLogout() {
    try { await kitchenFetch('/api/kitchen/logout', { method: 'POST', body: {} }) } catch {}
    setSession(null)
  }

  if (!authChecked) return (
    <div style={{ minHeight: '100vh', background: '#0D0D0D', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
      בודק התחברות…
    </div>
  )

  if (!session) return <LoginScreen onLogin={setSession} />

  return <Dashboard key={session.user.username} user={session.user} branches={session.branches}
    onLogout={handleLogout} onUnauthorized={handleUnauthorized} />
}

/* ══════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════ */
function Dashboard({ user, branches, onLogout, onUnauthorized }: {
  user: AuthUser; branches: KitchenBranch[]; onLogout: () => void; onUnauthorized: () => void
}) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [actionError, setActionError] = useState('')
  const [activeTab, setActiveTab] = useState<'kanban' | 'customers'>('kanban')
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  // Admin only: 'all' or a branch id. The API enforces the real scope for every role.
  const [filterBranch, setFilterBranch] = useState<string>('all')
  const [kitchenOrder, setKitchenOrder] = useState<Order | null>(null)
  const [editOrder, setEditOrder] = useState<Order | null>(null)
  const [editNotes, setEditNotes] = useState<Record<string, string>>({})
  const prevNewCount = useRef(0)
  const [installPrompt, setInstallPrompt] = useState<any>(null)
  const [showInstallBanner, setShowInstallBanner] = useState(false)
  const [audioUnlocked, setAudioUnlocked] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('audio_unlocked_date') === new Date().toDateString()
  })

  // Today's orders (Israel day) for the session's scope — from the secure kitchen API.
  const fetchOrders = useCallback(async () => {
    const qs = user.role === 'admin' ? `?branch=${encodeURIComponent(filterBranch)}` : ''
    try {
      const res = await kitchenFetch<{ orders: Order[] }>(`/api/kitchen/orders${qs}`)
      setOrders(res.orders)
      setLoadError(false)
      setLastRefresh(new Date())
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return }
      setLoadError(true) // keep the last good list; the next poll retries
    } finally {
      setLoading(false)
    }
  }, [user.role, filterBranch, onUnauthorized])

  const alarmRef = useRef<any>(null)
  const alarmCtxRef = useRef<any>(null)

  // פונקציה לנגינת צלצול — AudioContext חדש בכל פעם (הכי אמין)
  function playAlarmBeep() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      ctx.resume().then(() => {
        const now = ctx.currentTime
        const beep = (freq: number, start: number, dur: number) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain); gain.connect(ctx.destination)
          osc.type = 'square'
          osc.frequency.value = freq
          gain.gain.setValueAtTime(0.8, now + start)
          gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur)
          osc.start(now + start)
          osc.stop(now + start + dur + 0.05)
        }
        beep(1200, 0.0,  0.15)
        beep(1600, 0.2,  0.15)
        beep(1200, 0.4,  0.15)
        beep(1600, 0.6,  0.15)
        beep(2000, 0.8,  0.2)
        setTimeout(() => { try { ctx.close() } catch {} }, 2000)
      })
    } catch {}
  }

  useEffect(() => {
    const hasNew = orders.some(o => o.status === 'received')

    if (hasNew && !alarmRef.current && audioUnlocked) {
      alarmRef.current = true as any
      const loop = () => {
        if (!alarmRef.current) return
        playAlarmBeep()
        alarmRef.current = setTimeout(loop, 2500)
      }
      loop()
    } else if (!hasNew && alarmRef.current) {
      clearTimeout(alarmRef.current as any)
      alarmRef.current = null
    }
  }, [orders, audioUnlocked])

  useEffect(() => {
    const newCount = orders.filter(o => o.status === 'received').length
    prevNewCount.current = newCount
  }, [orders])

  useEffect(() => {
    fetchOrders()
    const interval = setInterval(fetchOrders, 20000)
    return () => clearInterval(interval)
  }, [fetchOrders])

  // Stop the new-order alarm when the board unmounts (logout / session expiry).
  useEffect(() => () => {
    if (alarmRef.current) clearTimeout(alarmRef.current)
    alarmRef.current = null
  }, [])

  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); setShowInstallBanner(true) }
    window.addEventListener('beforeinstallprompt', handler)
    if (window.matchMedia('(display-mode: standalone)').matches) setShowInstallBanner(false)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  // Status change through the secure API. The server validates the transition, updates conditionally
  // (conflict-safe across tablets) and sends the "ready" push itself — no separate push call here.
  const handleAdvance = async (orderId: string, nextStatus: OrderStatus) => {
    setActionError('')
    setKitchenOrder(prev => prev?.id === orderId ? null : prev)
    try {
      await kitchenFetch(`/api/kitchen/orders/${encodeURIComponent(orderId)}/status`, { method: 'PATCH', body: { status: nextStatus } })
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: nextStatus } : o)) // only after server success
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return }
      const code = (e as { code?: string }).code
      setActionError(code === 'conflict' || code === 'invalid_transition' || code === 'not_found'
        ? 'ההזמנה עודכנה במכשיר אחר — הרשימה רועננה'
        : 'הפעולה נכשלה. נסו שוב')
      fetchOrders()
    }
  }

  async function saveNotes() {
    setActionError('')
    try {
      for (const [itemId, notes] of Object.entries(editNotes)) {
        await kitchenFetch(`/api/kitchen/order-items/${encodeURIComponent(itemId)}/notes`, { method: 'PATCH', body: { notes } })
      }
      setEditOrder(null); setEditNotes({})
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return }
      const code = (e as { code?: string }).code
      setActionError(code === 'invalid_state' ? 'לא ניתן לערוך הערות בשלב זה של ההזמנה' : 'שמירת ההערות נכשלה. נסו שוב')
    } finally {
      fetchOrders()
    }
  }

  // Scope is enforced by the API (admin: ?branch=; branch users: own branch only).
  const filteredOrders = orders

  const byStatus = STATUSES.reduce((acc, s) => { acc[s] = filteredOrders.filter(o => o.status === s); return acc }, {} as Record<OrderStatus, Order[]>)
  const todayTotal = filteredOrders.filter(o => o.status !== 'received' && o.status !== 'cancelled').reduce((s, o) => s + o.totalPrice, 0)
  const newCount = byStatus.received.length

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0D0D0D; }
        @keyframes pulse { 0%,100%{box-shadow:0 0 0 0 rgba(255,215,0,0.4)} 50%{box-shadow:0 0 0 6px rgba(255,215,0,0)} }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#1A1A1A} ::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
      `}</style>

      {editOrder && (
        <div onClick={() => setEditOrder(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '2px solid #FFD700', borderRadius: 24, padding: 28, maxWidth: 500, width: '100%', direction: 'rtl', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ color: '#FFD700', fontSize: 22, fontWeight: 900 }}>
                ✏️ עריכת הזמנה #{editOrder.dailyNumber ? String(editOrder.dailyNumber).padStart(4,'0') : editOrder.id.slice(-4).toUpperCase()}
              </div>
              <button onClick={() => setEditOrder(null)} style={{ background: '#333', border: 'none', color: '#fff', borderRadius: 50, width: 36, height: 36, cursor: 'pointer', fontSize: 18, fontFamily: 'Heebo, sans-serif' }}>✕</button>
            </div>
            {editOrder.items.map(oi => (
              <div key={oi.id} style={{ background: '#1A1A1A', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{oi.quantity}× {oi.name}</div>
                <textarea
                  value={editNotes[oi.id] ?? (oi.notes || '')}
                  maxLength={500}
                  onChange={e => setEditNotes(prev => ({ ...prev, [oi.id]: e.target.value }))}
                  placeholder="הערות למנה..."
                  style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #333', background: '#0D0D0D', color: '#fff', fontSize: 14, fontFamily: 'Heebo, sans-serif', resize: 'none', height: 70, boxSizing: 'border-box' }}
                />
              </div>
            ))}
            {actionError && (
              <div style={{ color: '#FF6B6B', background: 'rgba(255,107,107,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10, textAlign: 'center' }}>❌ {actionError}</div>
            )}
            <button onClick={saveNotes} style={{ width: '100%', padding: 14, background: '#FFD700', color: '#000', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>✅ שמור שינויים</button>
          </div>
        </div>
      )}

      {kitchenOrder && (
        <KitchenModal order={kitchenOrder} onClose={() => setKitchenOrder(null)} onDone={(id) => handleAdvance(id, 'ready')} />
      )}

      <div style={{ minHeight: '100vh', background: '#0D0D0D', color: '#fff', fontFamily: 'Heebo, sans-serif', direction: 'rtl' }}>
        <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '12px 16px', position: 'sticky', top: 0, zIndex: 50 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#FFD700', fontSize: 18, fontWeight: 800 }}>🧆 הזמנות היום</span>
              {newCount > 0 && <span style={{ background: '#FFD700', color: '#000', borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 700, animation: 'pulse 1.5s infinite' }}>{newCount} חדשות!</span>}
              {/* תג הסניף הנוכחי */}
              <span style={{ background: user.role === 'admin' ? 'rgba(96,165,250,0.15)' : 'rgba(74,222,128,0.15)', color: user.role === 'admin' ? '#60A5FA' : '#4ADE80', border: `1px solid ${user.role === 'admin' ? 'rgba(96,165,250,0.4)' : 'rgba(74,222,128,0.4)'}`, borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>
                {user.role === 'admin' ? '👑' : '📍'} {user.label}
              </span>
            </div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ color: '#4ADE80', fontWeight: 700, fontSize: 15 }}>₪{todayTotal}</div>
              <div style={{ color: '#6B7280', fontSize: 10 }}>עודכן {formatTime(lastRefresh.toISOString())}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button onClick={() => {
                  const delivered = filteredOrders.filter(o => o.status === 'delivered')
                  if (delivered.length === 0) { alert('אין הזמנות שנמסרו היום'); return }
                  const date = new Date().toLocaleDateString('he-IL')
                  const ordersData = delivered.map(o => ({
                    'מספר': o.dailyNumber ? String(o.dailyNumber).padStart(4,'0') : o.id.slice(-4),
                    'שם לקוח': o.customerName || '', 'טלפון': o.phone,
                    'פריטים': o.items.map(i => (i.name) + ' x' + i.quantity).join(', '),
                    ...csvDeliveryFields(o),
                    'סכום סופי': o.totalPrice,
                    'תשלום': paymentMethodText(o.paymentMethod),
                    'שעה': formatTime(o.createdAt), 'סניף': o.branchName || '',
                  }))
                  const byPhone: Record<string,any[]> = {}
                  delivered.forEach(o => { if(!byPhone[o.phone]) byPhone[o.phone]=[]; byPhone[o.phone].push(o) })
                  const customersData = Object.entries(byPhone).map(([phone, ords]: any) => ({
                    'שם': ords[0]?.customerName || '', 'טלפון': phone,
                    'מספר הזמנות': ords.length, 'סה"כ': ords.reduce((s:number,o:any) => s+o.totalPrice, 0),
                  }))
                  const csvOrders = [Object.keys(ordersData[0]||{}).join(','), ...ordersData.map(r => Object.values(r).map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','))].join('\n')
                  const a1 = document.createElement('a'); a1.href = URL.createObjectURL(new Blob([csvOrders], {type:'text/csv;charset=utf-8'})); a1.download = 'הזמנות_' + date.replace(/\//g,'-') + '.csv'; a1.click()
                  setTimeout(() => {
                    const csvCustomers = [Object.keys(customersData[0]||{}).join(','), ...customersData.map(r => Object.values(r).map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','))].join('\n')
                    const a2 = document.createElement('a'); a2.href = URL.createObjectURL(new Blob([csvCustomers], {type:'text/csv;charset=utf-8'})); a2.download = 'לקוחות_' + date.replace(/\//g,'-') + '.csv'; a2.click()
                  }, 500)
                  setTimeout(() => {
                    const total = delivered.reduce((s,o) => s+o.totalPrice, 0)
                    alert('✅ 2 קבצי CSV הורדו!\n\n📎 כעת יפתח האימייל — צרף את הקבצים שהורדו:\n• הזמנות_' + date.replace(/\//g,'-') + '.csv\n• לקוחות_' + date.replace(/\//g,'-') + '.csv')
                    window.location.href = 'mailto:sssnoy81@gmail.com?subject=' + encodeURIComponent('דוח יומי פלאפל בתחנה — ' + date) + '&body=' + encodeURIComponent('שלום, מצורפים קבצי הדוח היומי לתאריך ' + date + '. סהכ הכנסות: ' + total + ' שח. מספר הזמנות: ' + delivered.length + '. פלאפל בתחנה')
                  }, 1000)
                }} style={{ background: 'rgba(74,222,128,0.15)', color: '#4ADE80', border: '1px solid rgba(74,222,128,0.3)', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>📊 דוח יומי</button>

                {!audioUnlocked ? (
                  <button onClick={() => {
                    try {
                      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
                      const ctx = new AudioCtx()
                      ctx.resume().then(() => {
                        // נגן צפצוף בדיקה
                        const osc = ctx.createOscillator()
                        const gain = ctx.createGain()
                        osc.connect(gain); gain.connect(ctx.destination)
                        osc.frequency.value = 1000; osc.type = 'square'
                        gain.gain.setValueAtTime(0.6, ctx.currentTime)
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
                        osc.start(); osc.stop(ctx.currentTime + 0.4)
                        localStorage.setItem('audio_unlocked_date', new Date().toDateString())
                        setAudioUnlocked(true)
                        setTimeout(() => { try { ctx.close() } catch {} }, 800)
                      }).catch(() => {
                        localStorage.setItem('audio_unlocked_date', new Date().toDateString())
                        setAudioUnlocked(true)
                      })
                    } catch { localStorage.setItem('audio_unlocked_date', new Date().toDateString()); setAudioUnlocked(true) }
                  }} style={{ background: '#FF6B6B', color: '#000', border: 'none', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>🔔 הפעל התראות</button>
                ) : (
                  <div style={{ color: '#4ADE80', fontSize: 10, alignSelf: 'center' }}>🔔 פעיל</div>
                )}

                {/* כפתור התקנה PWA */}
                {showInstallBanner && (
                  <button onClick={async () => {
                    if (installPrompt) {
                      installPrompt.prompt()
                      const result = await installPrompt.userChoice
                      if (result.outcome === 'accepted') setShowInstallBanner(false)
                    }
                  }} style={{ background: 'rgba(255,215,0,0.15)', color: '#FFD700', border: '1px solid rgba(255,215,0,0.4)', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>📲 התקן</button>
                )}
                {/* כפתור יציאה */}
                <button onClick={onLogout} style={{ background: 'rgba(255,107,107,0.1)', color: '#FF6B6B', border: '1px solid rgba(255,107,107,0.3)', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>יציאה</button>
              </div>
            </div>
          </div>

          {/* אדמין בלבד — פילטר סניפים */}
          {user.role === 'admin' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[{ id: 'all', name: 'כל הסניפים' }, ...branches].map(b => (
                <button key={b.id} onClick={() => setFilterBranch(b.id)} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', fontWeight: filterBranch === b.id ? 700 : 400, background: filterBranch === b.id ? '#FFD700' : '#1A1A1A', color: filterBranch === b.id ? '#000' : '#9CA3AF', border: `1px solid ${filterBranch === b.id ? '#FFD700' : '#333'}` }}>{b.name}</button>
              ))}
            </div>
          )}
          {(loadError || actionError) && !editOrder && (
            <div onClick={() => setActionError('')} style={{ marginTop: 8, color: '#FF6B6B', background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', borderRadius: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>
              ❌ {actionError || 'טעינת ההזמנות נכשלה — מנסה שוב…'}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid #222', background: '#111' }}>
          {([['kanban', '📋 הזמנות היום'], ['customers', '👥 לקוחות']] as const).map(([tab, label]) => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex: 1, padding: '10px 0', background: 'none', border: 'none', color: activeTab === tab ? '#FFD700' : '#6B7280', fontWeight: activeTab === tab ? 700 : 400, fontSize: 14, fontFamily: 'Heebo, sans-serif', cursor: 'pointer', borderBottom: activeTab === tab ? '2px solid #FFD700' : '2px solid transparent' }}>{label}</button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#6B7280' }}>טוען הזמנות...</div>
        ) : activeTab === 'customers' ? (
          <div style={{ padding: 12 }}><CustomerTab orders={filteredOrders} /></div>
        ) : (
          <div style={{ display: 'flex', gap: 10, padding: 12, overflowX: 'auto', alignItems: 'flex-start', minHeight: 'calc(100vh - 130px)' }}>
            {STATUSES.map(status => {
              const cfg = STATUS_CONFIG[status]
              const colOrders = byStatus[status]
              return (
                <div key={status} style={{ minWidth: 260, maxWidth: 300, flex: '0 0 260px', background: '#111', borderRadius: 14, border: '1px solid #222' }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ color: cfg.color, fontWeight: 700, fontSize: 14 }}>{cfg.label}</span>
                      {status === 'preparing' && <span style={{ color: '#F97316', fontSize: 10, marginRight: 6, opacity: 0.8 }}>לחץ להגדלה</span>}
                    </div>
                    <span style={{ background: cfg.bg, color: cfg.color, borderRadius: 20, padding: '1px 10px', fontSize: 13, fontWeight: 700, border: `1px solid ${cfg.border}` }}>{colOrders.length}</span>
                  </div>
                  <div style={{ padding: '10px', maxHeight: '75vh', overflowY: 'auto' }}>
                    {colOrders.length === 0
                      ? <div style={{ color: '#374151', textAlign: 'center', fontSize: 12, padding: '20px 0' }}>אין הזמנות</div>
                      : colOrders.map(order => (
                        <OrderCard key={order.id} order={order} onAdvance={handleAdvance} onKitchenOpen={status === 'preparing' ? setKitchenOrder : undefined} onEdit={setEditOrder} />
                      ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}