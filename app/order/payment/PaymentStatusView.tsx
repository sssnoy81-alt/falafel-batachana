// Presentational payment-status view (HYP-08). No hooks, no I/O: the page passes the parsed public status.
// Shows only the sanitized state and, once confirmed, the order / daily number — never payment or personal data.

import { STATE_VIEW, type HypPublicStatus } from '@/lib/hyp/hypStatusUi'

const C = {
  bg: '#0D0D0D', bgCard: '#1A1A1A', border: '#2A2A2A', gold: '#FFD700', white: '#FFFFFF', gray: '#B0B0B0',
  green: '#4ADE80', greenBg: 'rgba(74,222,128,0.12)', red: '#FF6B6B', redBg: 'rgba(255,107,107,0.12)',
  amber: '#FBBF24', amberBg: 'rgba(251,191,36,0.12)', blueBg: 'rgba(255,215,0,0.08)',
}
const TONE = {
  info: { color: C.gold, bg: C.blueBg, icon: '⏳' },
  success: { color: C.green, bg: C.greenBg, icon: '✅' },
  error: { color: C.red, bg: C.redBg, icon: '✖' },
  warning: { color: C.amber, bg: C.amberBg, icon: '⚠' },
} as const

export const BRANCH_PHONE = '058-5505014'   // מישור אדומים (the only pilot branch)

export interface PaymentStatusViewProps {
  status: HypPublicStatus | null
  phase: 'loading' | 'ready' | 'not_found' | 'error' | 'stopped'
  onTrack?: () => void
  onRefresh?: () => void
}

export function PaymentStatusView({ status, phase, onTrack, onRefresh }: PaymentStatusViewProps) {
  const view = status ? STATE_VIEW[status.state] : null
  const tone = view ? TONE[view.tone] : TONE.info
  const title = phase === 'not_found' ? 'לא מצאנו את התשלום'
    : phase === 'loading' && !view ? 'טוען את מצב התשלום…'
    : view?.title ?? 'לא ניתן לטעון את מצב התשלום'
  const body = phase === 'not_found' ? 'הקישור אינו תקין או שפג תוקפו. אם בוצע חיוב — נא לפנות לסניף.'
    : phase === 'loading' && !view ? 'רגע אחד…'
    : view?.body ?? 'נסו לרענן בעוד רגע. אין לבצע תשלום נוסף.'

  return (
    <main dir="rtl" lang="he" style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Heebo, sans-serif', color: C.white,
                                       display: 'flex', justifyContent: 'center', padding: '24px 16px', boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        <h1 style={{ fontSize: 20, fontWeight: 900, margin: '0 0 16px', textAlign: 'center' }}>פלאפל בתחנה — מצב התשלום</h1>
        <section role="status" aria-live="polite" aria-atomic="true"
                 style={{ background: tone.bg, border: `1px solid ${tone.color}`, borderRadius: 18, padding: 20, textAlign: 'center' }}>
          <div aria-hidden="true" style={{ fontSize: 36, marginBottom: 8 }}>{tone.icon}</div>
          <h2 style={{ fontSize: 20, fontWeight: 900, color: tone.color, margin: '0 0 10px' }}>{title}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: C.white, margin: 0 }}>{body}</p>
          {status?.state === 'confirmed' && status.order && (
            <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '16px 0 0' }}>
              <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12 }}>
                <dt style={{ fontSize: 12, color: C.gray }}>מספר יומי</dt>
                <dd style={{ margin: 0, fontSize: 28, fontWeight: 900, color: C.gold }}>{status.order.dailyNumber ?? '—'}</dd>
              </div>
              <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12 }}>
                <dt style={{ fontSize: 12, color: C.gray }}>מספר הזמנה</dt>
                <dd style={{ margin: 0, fontSize: 28, fontWeight: 900, color: C.white }}>{status.order.orderNumber ?? '—'}</dd>
              </div>
            </dl>
          )}
        </section>

        <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
          {status?.state === 'confirmed' && status.order && onTrack && (
            <button type="button" onClick={onTrack}
                    style={{ width: '100%', minHeight: 48, padding: 14, background: C.gold, color: '#000', border: 'none', borderRadius: 14, fontSize: 17, fontWeight: 900, cursor: 'pointer', fontFamily: 'inherit' }}>
              למעקב אחרי ההזמנה
            </button>
          )}
          {view?.offerNewOrder && (
            <a href="/order" style={{ display: 'block', textAlign: 'center', minHeight: 48, boxSizing: 'border-box', padding: 14, background: C.bgCard, color: C.white, border: `1px solid ${C.border}`, borderRadius: 14, fontSize: 16, fontWeight: 700, textDecoration: 'none' }}>
              חזרה להזמנה
            </a>
          )}
          {(phase === 'stopped' || phase === 'error') && onRefresh && (
            <button type="button" onClick={onRefresh}
                    style={{ width: '100%', minHeight: 48, padding: 14, background: C.bgCard, color: C.white, border: `1px solid ${C.border}`, borderRadius: 14, fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              בדיקת מצב מחדש
            </button>
          )}
          {(status?.state === 'in_review' || phase === 'not_found' || status?.state === 'refunded') && (
            <a href={`tel:${BRANCH_PHONE.replace(/-/g, '')}`} style={{ display: 'block', textAlign: 'center', color: C.gold, fontSize: 15, fontWeight: 700, padding: 8 }}>
              📞 הסניף: {BRANCH_PHONE}
            </a>
          )}
        </div>
      </div>
    </main>
  )
}
