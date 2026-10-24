'use client'

// /order/payment — fallback target of GET /api/payments/hyp/return when the return could not be matched (HYP-08).
// Offers the customer's own open payment (status token kept in localStorage at checkout), never a new payment.

import { useSyncExternalStore } from 'react'
import { HYP_PENDING_PAYMENT_KEY } from '@/lib/hyp/hypCheckoutUi'
import { BRANCH_PHONE } from './PaymentStatusView'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function readPendingToken(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(HYP_PENDING_PAYMENT_KEY) ?? 'null')
    return saved && typeof saved.token === 'string' && UUID_RE.test(saved.token) && saved.expires > Date.now() ? saved.token : null
  } catch {
    return null
  }
}
const noSubscription = () => () => {}

export default function PaymentFallbackPage() {
  // Browser-only value; the server render (and hydration) see null.
  const token = useSyncExternalStore(noSubscription, readPendingToken, () => null)
  return (
    <main dir="rtl" lang="he" style={{ minHeight: '100vh', background: '#0D0D0D', color: '#FFFFFF', fontFamily: 'Heebo, sans-serif', display: 'flex', justifyContent: 'center', padding: '24px 16px', boxSizing: 'border-box' }}>
      <section role="status" aria-live="polite" style={{ width: '100%', maxWidth: 480, background: 'rgba(251,191,36,0.12)', border: '1px solid #FBBF24', borderRadius: 18, padding: 20, textAlign: 'center', alignSelf: 'flex-start' }}>
        <h1 style={{ fontSize: 20, fontWeight: 900, color: '#FBBF24', margin: '0 0 10px' }}>לא הצלחנו לזהות את התשלום</h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, margin: '0 0 16px' }}>אין לבצע תשלום נוסף. אם בוצע חיוב — הוא יטופל, והסניף ייצור קשר במידת הצורך.</p>
        {token && (
          <a href={`/order/payment/${token}`} style={{ display: 'block', minHeight: 48, boxSizing: 'border-box', padding: 14, background: '#FFD700', color: '#000', borderRadius: 14, fontWeight: 900, textDecoration: 'none', marginBottom: 10 }}>
            למצב התשלום שלי
          </a>
        )}
        <a href={`tel:${BRANCH_PHONE.replace(/-/g, '')}`} style={{ color: '#FFD700', fontWeight: 700 }}>📞 הסניף: {BRANCH_PHONE}</a>
      </section>
    </main>
  )
}
