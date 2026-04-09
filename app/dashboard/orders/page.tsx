'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://sqgnrzcmjhwgfjxocvlr.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZ25yemNtamh3Z2ZqeG9jdmxyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM2NzEwMSwiZXhwIjoyMDg3OTQzMTAxfQ.fAnUMR8cXgQ38VWz66UibT83u_JquuXeZRtpiYmbTzM'
)

/* ─── AUTH ─── */
type UserRole = 'admin' | 'adumim' | 'mikhmas'

const USERS: Record<string, { password: string; role: UserRole; label: string; branchId: string | null }> = {
  'admin':   { password: 'Falafel2025!', role: 'admin',   label: 'אדמין — כל הסניפים',    branchId: null },
  'adumim':  { password: 'Adumim123',   role: 'adumim',  label: 'מישור אדומים',           branchId: '8fed141d-0e7c-46c1-803b-88d3d811c1f8' },
  'mikhmas': { password: 'Mikhmas123',  role: 'mikhmas', label: 'מעבר מכמש',              branchId: '3ab15ad1-e835-492b-bae5-11b202ee2314' },
}

interface AuthUser { username: string; role: UserRole; label: string; branchId: string | null }

function LoginScreen({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [showPass, setShowPass] = useState(false)

  function handleLogin() {
    const u = USERS[username.trim().toLowerCase()]
    if (!u || u.password !== password) {
      setError('שם משתמש או סיסמה שגויים')
      return
    }
    setError('')
    onLogin({ username: username.trim().toLowerCase(), role: u.role, label: u.label, branchId: u.branchId })
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
            placeholder="admin / adumim / mikhmas"
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
          style={{
            width: '100%', padding: 14, background: '#FFD700', color: '#000',
            border: 'none', borderRadius: 14, fontSize: 17, fontWeight: 900,
            cursor: 'pointer', fontFamily: 'Heebo, sans-serif',
          }}
        >
          כניסה →
        </button>
      </div>
    </div>
  )
}

/* ─── TYPES ─── */
type OrderStatus = 'received' | 'confirmed' | 'preparing' | 'ready' | 'delivered' | 'cancelled'

interface OrderItem {
  id: string; item_id: string; quantity: number; unit_price: number
  notes: string | null; menu_items: { name_he: string } | null
}

interface Order {
  id: string; branch_id: string; phone: string
  customer_name?: string; daily_number?: number
  status: OrderStatus; total_price: number; payment_method: string
  created_at: string; order_items: OrderItem[]; branches: { name: string } | null
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
  const num = order.daily_number ? String(order.daily_number).padStart(4, '0') : order.id.slice(-4).toUpperCase()
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.93)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0F0F0F', border: '3px solid #F97316', borderRadius: 28, padding: '36px 40px', maxWidth: 700, width: '100%', direction: 'rtl', boxShadow: '0 0 80px rgba(249,115,22,0.25)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ background: 'rgba(249,115,22,0.2)', border: '2px solid #F97316', borderRadius: 16, width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>🍳</div>
            <div>
              <div style={{ color: '#F97316', fontSize: 40, fontWeight: 900, lineHeight: 1 }}>#{num}</div>
              <div style={{ color: '#9CA3AF', fontSize: 16, marginTop: 6 }}>{formatTime(order.created_at)} &nbsp;·&nbsp; {timeSince(order.created_at)}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: '#1A1A1A', border: '1px solid #333', color: '#9CA3AF', borderRadius: 50, width: 48, height: 48, fontSize: 22, cursor: 'pointer', fontFamily: 'Heebo, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>
        {(() => {
          const mains  = order.order_items.filter(oi => getItemType(oi.menu_items?.name_he ?? '') === 'main')
          const addons = order.order_items.filter(oi => getItemType(oi.menu_items?.name_he ?? '') === 'addon')
          const drinks = order.order_items.filter(oi => getItemType(oi.menu_items?.name_he ?? '') === 'drink')

          const renderMain = (oi: OrderItem) => {
            const parts = (oi.notes || '').split(' | ').filter(Boolean)
            const sauces = parts.find(p => p.startsWith('רטבים:'))
            const salads = parts.find(p => p.startsWith('סלטים:'))
            const note   = parts.find(p => !p.startsWith('רטבים:') && !p.startsWith('סלטים:') && !p.startsWith('תוספות:') && !p.startsWith('שתייה:'))
            return (
              <div key={oi.id} style={{ background: '#1A1A1A', border: '2px solid #2A2A2A', borderRadius: 18, padding: '20px 24px', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: sauces || salads || note ? 10 : 0 }}>
                  <div style={{ background: '#F97316', color: '#000', borderRadius: 14, minWidth: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 900, flexShrink: 0 }}>{oi.quantity}</div>
                  <div style={{ color: '#fff', fontSize: 28, fontWeight: 800, lineHeight: 1.2 }}>{oi.menu_items?.name_he ?? 'פריט'}</div>
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
                    const n = oi.menu_items?.name_he ?? 'תוספת'
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
                    const n = oi.menu_items?.name_he ?? 'שתייה'
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
  const num = order.daily_number ? String(order.daily_number).padStart(4, '0') : order.id.slice(-4).toUpperCase()

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
          <span style={{ color: '#9CA3AF', fontSize: 13 }}>{formatTime(order.created_at)}</span>
          <span style={{ color: '#6B7280', fontSize: 12 }}>{timeSince(order.created_at)}</span>
        </div>
        <div style={{ textAlign: 'left' }}>
          {order.customer_name && <div style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>👤 {order.customer_name}</div>}
          <div style={{ color: '#D1D5DB', fontSize: 13, direction: 'ltr' }}>📞 {order.phone}</div>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        {(() => {
          const mains  = order.order_items.filter(oi => getItemType(oi.menu_items?.name_he ?? '') === 'main')
          const addons = order.order_items.filter(oi => getItemType(oi.menu_items?.name_he ?? '') === 'addon')
          const drinks = order.order_items.filter(oi => getItemType(oi.menu_items?.name_he ?? '') === 'drink')
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
                      <span style={{ color: cfg.color, fontWeight: 900 }}>{oi.quantity}×</span>{' '}{oi.menu_items?.name_he ?? 'פריט'}
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
                    const n = oi.menu_items?.name_he ?? 'תוספת'
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
                    const n = oi.menu_items?.name_he ?? 'שתייה'
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
          <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 15 }}>₪{order.total_price}</span>
          <span style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '2px 8px', color: '#9CA3AF', fontSize: 11 }}>
            {order.payment_method === 'cash' ? '💵 מזומן' : order.payment_method === 'cibus' ? '🍽️ סיבוס' : order.payment_method === 'bit' ? '💙 ביט' : '💳 אשראי'}
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
    .map(([phone, ords]) => ({ phone, orders: ords.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), total: ords.reduce((s, o) => s + o.total_price, 0) }))
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
          {c.orders[0]?.customer_name && <div style={{ color: '#9CA3AF', fontSize: 12, marginBottom: 6 }}>👤 {c.orders[0].customer_name}</div>}
          {c.orders.slice(0, 3).map(o => (
            <div key={o.id} style={{ fontSize: 12, color: '#6B7280', borderTop: '1px solid #2A2A2A', paddingTop: 6, marginTop: 6 }}>
              <span style={{ color: STATUS_CONFIG[o.status].color }}>●</span>{' '}
              {formatDate(o.created_at)} {formatTime(o.created_at)} — ₪{o.total_price} ({o.order_items.length} פריטים)
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
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  // בדוק session קיים
  useEffect(() => {
    const saved = localStorage.getItem('dashboard_user')
    if (saved) {
      try {
        const u = JSON.parse(saved) as AuthUser
        // ודא שהמשתמש עדיין תקין
        if (USERS[u.username]) setCurrentUser(u)
      } catch {}
    }
    setAuthChecked(true)
  }, [])

  function handleLogin(user: AuthUser) {
    localStorage.setItem('dashboard_user', JSON.stringify(user))
    setCurrentUser(user)
  }

  function handleLogout() {
    localStorage.removeItem('dashboard_user')
    setCurrentUser(null)
  }

  if (!authChecked) return null

  if (!currentUser) return <LoginScreen onLogin={handleLogin} />

  return <Dashboard user={currentUser} onLogout={handleLogout} />
}

/* ══════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════ */
function Dashboard({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'kanban' | 'customers'>('kanban')
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [filterBranch, setFilterBranch] = useState<string>(user.branchId ?? 'all')
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([])
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

  const fetchOrders = useCallback(async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    let query = supabase
      .from('orders')
      .select(`*, branches(name), order_items(id, item_id, quantity, unit_price, notes, menu_items(name_he))`)
      .gte('created_at', today.toISOString())
      .order('created_at', { ascending: false })

    // סניף ספציפי — הגבלה ברמת DB
    if (user.branchId) {
      query = query.eq('branch_id', user.branchId)
    }

    const { data, error } = await query
    if (!error && data) setOrders(data as Order[])
    setLastRefresh(new Date())
    setLoading(false)
  }, [user.branchId])

  const alarmRef = useRef<any>(null)
  const alarmCtxRef = useRef<any>(null)

  useEffect(() => {
    const hasNew = orders.some(o => o.status === 'received')
    if (hasNew && !alarmRef.current && audioUnlocked) {
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
        alarmCtxRef.current = ctx
        const playLoop = () => {
          if (!alarmRef.current) return
          const now = ctx.currentTime

          // צליל מסעדה חזק — 3 שלבים חדים
          const beep = (freq: number, start: number, dur: number, vol: number) => {
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            // distortion להגברת עוצמה
            const dist = ctx.createWaveShaper()
            const curve = new Float32Array(256)
            for (let i = 0; i < 256; i++) {
              const x = (i * 2) / 256 - 1
              curve[i] = (Math.PI + 200) * x / (Math.PI + 200 * Math.abs(x))
            }
            dist.curve = curve
            osc.connect(dist); dist.connect(gain); gain.connect(ctx.destination)
            osc.frequency.value = freq
            osc.type = 'square'
            gain.gain.setValueAtTime(0, now + start)
            gain.gain.linearRampToValueAtTime(vol, now + start + 0.01)
            gain.gain.setValueAtTime(vol, now + start + dur - 0.02)
            gain.gain.linearRampToValueAtTime(0, now + start + dur)
            osc.start(now + start); osc.stop(now + start + dur + 0.05)
          }

          // 3 צלצולים חדים וחזקים
          beep(1400, 0,    0.18, 1.0)
          beep(1800, 0.22, 0.18, 1.0)
          beep(1400, 0.44, 0.18, 1.0)
          beep(1800, 0.66, 0.18, 1.0)
          beep(2200, 0.88, 0.25, 1.0)

          alarmRef.current = setTimeout(playLoop, 2000)
        }

        alarmRef.current = setTimeout(playLoop, 0)
        playLoop()
      } catch {}
    } else if (!hasNew && alarmRef.current) {
      clearTimeout(alarmRef.current)
      alarmRef.current = null
      try { alarmCtxRef.current?.close() } catch {}
      alarmCtxRef.current = null
    }
  }, [orders, audioUnlocked])

  useEffect(() => {
    const newCount = orders.filter(o => o.status === 'received').length
    prevNewCount.current = newCount
  }, [orders])

  const fetchBranches = useCallback(async () => {
    const { data } = await supabase.from('branches').select('id, name').order('sort_order')
    if (data) setBranches(data)
  }, [])

  useEffect(() => {
    fetchOrders(); fetchBranches()
    const interval = setInterval(fetchOrders, 20000)
    return () => clearInterval(interval)
  }, [fetchOrders, fetchBranches])

  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); setShowInstallBanner(true) }
    window.addEventListener('beforeinstallprompt', handler)
    if (window.matchMedia('(display-mode: standalone)').matches) setShowInstallBanner(false)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleAdvance = async (orderId: string, nextStatus: OrderStatus) => {
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: nextStatus } : o))
    setKitchenOrder(prev => prev?.id === orderId ? null : prev)

    const { error } = await supabase.from('orders').update({ status: nextStatus }).eq('id', orderId)
    if (error) { console.error('שגיאה:', error); fetchOrders() }
  }

  // אדמין יכול לסנן לפי סניף, סניף רגיל — קבוע
  const filteredOrders = user.role === 'admin'
    ? (filterBranch === 'all' ? orders : orders.filter(o => o.branch_id === filterBranch))
    : orders  // כבר מסונן ברמת DB

  const byStatus = STATUSES.reduce((acc, s) => { acc[s] = filteredOrders.filter(o => o.status === s); return acc }, {} as Record<OrderStatus, Order[]>)
  const todayTotal = filteredOrders.filter(o => o.status !== 'received' && o.status !== 'cancelled').reduce((s, o) => s + o.total_price, 0)
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
                ✏️ עריכת הזמנה #{editOrder.daily_number ? String(editOrder.daily_number).padStart(4,'0') : editOrder.id.slice(-4).toUpperCase()}
              </div>
              <button onClick={() => setEditOrder(null)} style={{ background: '#333', border: 'none', color: '#fff', borderRadius: 50, width: 36, height: 36, cursor: 'pointer', fontSize: 18, fontFamily: 'Heebo, sans-serif' }}>✕</button>
            </div>
            {editOrder.order_items.map(oi => (
              <div key={oi.id} style={{ background: '#1A1A1A', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{oi.quantity}× {oi.menu_items?.name_he}</div>
                <textarea
                  value={editNotes[oi.id] ?? (oi.notes || '')}
                  onChange={e => setEditNotes(prev => ({ ...prev, [oi.id]: e.target.value }))}
                  placeholder="הערות למנה..."
                  style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #333', background: '#0D0D0D', color: '#fff', fontSize: 14, fontFamily: 'Heebo, sans-serif', resize: 'none', height: 70, boxSizing: 'border-box' }}
                />
              </div>
            ))}
            <button onClick={async () => {
              for (const [itemId, notes] of Object.entries(editNotes)) {
                await supabase.from('order_items').update({ notes }).eq('id', itemId)
              }
              fetchOrders(); setEditOrder(null); setEditNotes({})
            }} style={{ width: '100%', padding: 14, background: '#FFD700', color: '#000', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 900, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>✅ שמור שינויים</button>
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
              {user.role === 'admin' && <a href="/dashboard" style={{ color: '#6B7280', textDecoration: 'none', fontSize: 13 }}>← דשבורד</a>}
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
                    'מספר': o.daily_number ? String(o.daily_number).padStart(4,'0') : o.id.slice(-4),
                    'שם לקוח': o.customer_name || '', 'טלפון': o.phone,
                    'פריטים': o.order_items.map(i => (i.menu_items?.name_he || '') + ' x' + i.quantity).join(', '),
                    'סכום': o.total_price,
                    'תשלום': o.payment_method === 'cash' ? 'מזומן' : o.payment_method === 'cibus' ? 'סיבוס' : o.payment_method === 'bit' ? 'ביט' : 'אשראי',
                    'שעה': formatTime(o.created_at), 'סניף': o.branches?.name || '',
                  }))
                  const byPhone: Record<string,any[]> = {}
                  delivered.forEach(o => { if(!byPhone[o.phone]) byPhone[o.phone]=[]; byPhone[o.phone].push(o) })
                  const customersData = Object.entries(byPhone).map(([phone, ords]: any) => ({
                    'שם': ords[0]?.customer_name || '', 'טלפון': phone,
                    'מספר הזמנות': ords.length, 'סה"כ': ords.reduce((s:number,o:any) => s+o.total_price, 0),
                  }))
                  const csvOrders = [Object.keys(ordersData[0]||{}).join(','), ...ordersData.map(r => Object.values(r).map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','))].join('\n')
                  const a1 = document.createElement('a'); a1.href = URL.createObjectURL(new Blob([csvOrders], {type:'text/csv;charset=utf-8'})); a1.download = 'הזמנות_' + date.replace(/\//g,'-') + '.csv'; a1.click()
                  setTimeout(() => {
                    const csvCustomers = [Object.keys(customersData[0]||{}).join(','), ...customersData.map(r => Object.values(r).map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','))].join('\n')
                    const a2 = document.createElement('a'); a2.href = URL.createObjectURL(new Blob([csvCustomers], {type:'text/csv;charset=utf-8'})); a2.download = 'לקוחות_' + date.replace(/\//g,'-') + '.csv'; a2.click()
                  }, 500)
                  setTimeout(() => {
                    const total = delivered.reduce((s,o) => s+o.total_price, 0)
                    alert('✅ 2 קבצי CSV הורדו!\n\n📎 כעת יפתח האימייל — צרף את הקבצים שהורדו:\n• הזמנות_' + date.replace(/\//g,'-') + '.csv\n• לקוחות_' + date.replace(/\//g,'-') + '.csv')
                    window.location.href = 'mailto:sssnoy81@gmail.com?subject=' + encodeURIComponent('דוח יומי פלאפל בתחנה — ' + date) + '&body=' + encodeURIComponent('שלום, מצורפים קבצי הדוח היומי לתאריך ' + date + '. סהכ הכנסות: ' + total + ' שח. מספר הזמנות: ' + delivered.length + '. פלאפל בתחנה')
                  }, 1000)
                }} style={{ background: 'rgba(74,222,128,0.15)', color: '#4ADE80', border: '1px solid rgba(74,222,128,0.3)', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>📊 דוח יומי</button>

                {!audioUnlocked ? (
                  <button onClick={() => {
                    try {
                      const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)()
                      ctx.resume().then(() => { localStorage.setItem('audio_unlocked_date', new Date().toDateString()); setAudioUnlocked(true); ctx.close() })
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