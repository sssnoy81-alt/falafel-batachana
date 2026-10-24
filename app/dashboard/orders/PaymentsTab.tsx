'use client'

// Staff payment reconciliation tab (HYP-08 view, HYP-09 recovery). Data: GET /api/kitchen/payments (kitchen session +
// branch scope enforced by the server). Recovery controls appear ONLY for items the server marked with actions, i.e.
// only for an account the server authorized (HYP_STAFF_RECOVERY_ENABLED + admin + HYP_STAFF_RECOVERY_USERS). Each action
// posts to /api/kitchen/payments/[ref]; the server re-checks everything. Nothing here refunds, voids or contacts HYP.

import { useCallback, useEffect, useState } from 'react'
import type { MoneyState, ReconciliationCategory, ReconciliationItem } from '@/lib/hyp/hypReconciliation'
import type { RecoveryAction } from '@/lib/hyp/hypStaffRecovery'

export const CATEGORY_LABELS: Readonly<Record<ReconciliationCategory, { label: string; hint: string; color: string; urgent: boolean }>> = {
  paid_no_order: { label: 'שולם — ההזמנה טרם נוצרה', urgent: true, color: '#FF6B6B', hint: 'התשלום אושר אך אין הזמנה במטבח. לבדוק מול הלקוח; אפשר לשלוח למטבח.' },
  finalize_failed: { label: 'שולם — יצירת ההזמנה נכשלה', urgent: true, color: '#FF6B6B', hint: 'החיוב קיים וההזמנה לא נוצרה. לא לחייב שוב; אפשר לנסות לשלוח למטבח שוב.' },
  late_return: { label: 'שולם באיחור — ממתין להחלטה', urgent: true, color: '#F97316', hint: 'התשלום אושר אחרי שפג זמן ההזמנה, ולכן לא נשלח למטבח אוטומטית.' },
  duplicate_charge: { label: 'חיוב כפול אפשרי', urgent: true, color: '#F97316', hint: 'נרשם יותר מחיוב אחד לאותה הזמנה. את העודף יש לבטל / לזכות בפורטל HYP.' },
  amount_mismatch: { label: 'סכום החיוב שונה מההזמנה', urgent: true, color: '#F97316', hint: 'הסכום שחויב שונה מסכום ההזמנה. לא נוצרה הזמנה; נדרש ביטול או זיכוי בפורטל.' },
  non_capture: { label: 'אישור ללא חיוב (J2 / J5 / דחוי)', urgent: false, color: '#FBBF24', hint: 'החברה אישרה כרטיס או מסגרת בלי חיוב בפועל. לבדוק בפורטל HYP (ייתכן שהמסגרת חסומה).' },
  verify_rejected: { label: 'אימות נכשל — לבדוק בפורטל', urgent: false, color: '#FBBF24', hint: 'החזרה מדף התשלום לא אומתה. לבדוק בפורטל HYP אם בוצע חיוב.' },
  returned_unverified: { label: 'חזרה מהסליקה — טרם אומתה', urgent: false, color: '#FBBF24', hint: 'הלקוח חזר מדף התשלום והאימות לא הושלם (תקלה זמנית). לבדוק בפורטל HYP.' },
  no_return: { label: 'לא התקבלה חזרה — לבדוק בפורטל', urgent: false, color: '#FBBF24', hint: 'אין חזרה מדף התשלום. ייתכן שהלקוח שילם וסגר את הדפדפן — לחפש בפורטל HYP.' },
  manual_hold: { label: 'בהמתנה לטיפול ידני', urgent: false, color: '#9CA3AF', hint: 'סומן לטיפול ידני.' },
  flagged: { label: 'סומן לטיפול', urgent: false, color: '#9CA3AF', hint: 'סומן על ידי הצוות.' },
  awaiting_customer: { label: 'הלקוח בדף התשלום', urgent: false, color: '#6B7280', hint: 'ממתין שהלקוח ישלים את התשלום.' },
}

export const MONEY_STATE_LABELS: Readonly<Record<MoneyState, { label: string; color: string }>> = {
  confirmed: { label: 'תשלום מאושר', color: '#4ADE80' },
  unknown: { label: 'תשלום לא ידוע', color: '#FBBF24' },
  not_captured: { label: 'לא נגבה', color: '#9CA3AF' },
  refund_required: { label: 'נדרש זיכוי — טרם בוצע', color: '#FF6B6B' },
  refunded_externally: { label: 'זיכוי / ביטול בוצע בפורטל', color: '#60A5FA' },
}

/** Each action, what staff must confirm, and which evidence fields it needs. */
export const ACTION_UI: Readonly<Record<RecoveryAction, { label: string; confirm: string; fields: ('tx' | 'txSelect' | 'amount' | 'reference')[] }>> = {
  portal_paid: { label: 'אישור תשלום שנמצא בפורטל HYP', fields: ['tx', 'amount'], confirm: 'בדקתי בפורטל HYP: העסקה הזו קיימת ובוצע בה חיוב בסכום שהזנתי.' },
  finalize: { label: 'שליחת ההזמנה למטבח', fields: [], confirm: 'התשלום אושר, וידאתי מול הלקוח שהוא עדיין רוצה את ההזמנה ושאין לו הזמנה אחרת עליה.' },
  no_charge_found: { label: 'סימון: לא נמצא חיוב', fields: [], confirm: 'בדקתי בפורטל HYP ולא נמצא חיוב עבור ההפניה הזו.' },
  flag_refund_required: { label: 'סימון: נדרש זיכוי', fields: [], confirm: 'זה סימון בלבד — הזיכוי עדיין לא בוצע ויבוצע בפורטל HYP.' },
  flag_investigation: { label: 'סימון: לבירור', fields: [], confirm: 'נדרש בירור נוסף (פורטל / לקוח).' },
  clear_flag: { label: 'הסרת סימון', fields: [], confirm: 'הטיפול שסומן הסתיים.' },
  record_void: { label: 'רישום ביטול שכבר בוצע בפורטל', fields: ['txSelect', 'amount', 'reference'], confirm: 'הביטול כבר בוצע בפורטל HYP; האסמכתא והסכום הועתקו משם.' },
  record_refund: { label: 'רישום זיכוי שכבר בוצע בפורטל', fields: ['txSelect', 'amount', 'reference'], confirm: 'הזיכוי כבר בוצע בפורטל HYP; האסמכתא והסכום הועתקו משם.' },
}

export type RecoverySubmit = (ref: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>

const time = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', background: '#0D0D0D', color: '#FFF', border: '1px solid #333', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }

function RecoveryForm({ item, onSubmit }: { item: ReconciliationItem; onSubmit: RecoverySubmit }) {
  const [action, setAction] = useState<RecoveryAction | ''>('')
  const [note, setNote] = useState(''); const [tx, setTx] = useState(''); const [amount, setAmount] = useState(''); const [reference, setReference] = useState('')
  const [confirmed, setConfirmed] = useState(false); const [ackDuplicate, setAckDuplicate] = useState(false)
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('')
  const ui = action ? ACTION_UI[action] : null
  const duplicate = item.category === 'duplicate_charge'
  const approved = item.transactions.filter(t => t.outcome === 'approved')
  const ready = !!action && note.trim().length >= 3 && confirmed && !busy && (action !== 'finalize' || !duplicate || ackDuplicate)
    && (!ui?.fields.includes('amount') || amount.trim() !== '') && (!ui?.fields.some(f => f === 'tx' || f === 'txSelect') || tx !== '')
    && (!ui?.fields.includes('reference') || reference.trim() !== '')
  const submit = async () => {
    if (!ready || !action) return
    setBusy(true); setMessage('')
    const payload: Record<string, unknown> = { action, note: note.trim(), confirm: true }
    if (ui?.fields.some(f => f === 'tx' || f === 'txSelect')) payload.hypTransId = tx.trim()
    if (ui?.fields.includes('amount')) payload.amount = amount.trim()
    if (ui?.fields.includes('reference')) payload.reference = reference.trim()
    if (action === 'finalize') payload.ackDuplicate = ackDuplicate
    const r = await onSubmit(item.ref, payload)
    setMessage(r.message); setBusy(false)
    if (r.ok) { setAction(''); setNote(''); setTx(''); setAmount(''); setReference(''); setConfirmed(false); setAckDuplicate(false) }
  }
  return (
    <details style={{ marginTop: 10, borderTop: '1px solid #333', paddingTop: 8 }}>
      <summary style={{ cursor: 'pointer', color: '#FFD700', fontSize: 13, fontWeight: 700 }}>פעולות צוות</summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <label style={{ fontSize: 12, color: '#9CA3AF' }}>פעולה
          <select value={action} onChange={e => { setAction(e.target.value as RecoveryAction | ''); setConfirmed(false) }} style={input}>
            <option value="">— בחרו פעולה —</option>
            {item.actions.map(a => <option key={a} value={a}>{ACTION_UI[a].label}</option>)}
          </select>
        </label>
        {ui?.fields.includes('tx') && (
          <label style={{ fontSize: 12, color: '#9CA3AF' }}>מספר עסקה בפורטל HYP
            <input value={tx} onChange={e => setTx(e.target.value)} dir="ltr" inputMode="numeric" maxLength={40} style={input} />
          </label>
        )}
        {ui?.fields.includes('txSelect') && (
          <label style={{ fontSize: 12, color: '#9CA3AF' }}>העסקה שבוטלה / זוכתה
            <select value={tx} onChange={e => setTx(e.target.value)} style={input}>
              <option value="">— בחרו עסקה —</option>
              {approved.map(t => <option key={t.hypTransId} value={t.hypTransId}>{t.hypTransId} · ₪{t.amount.toFixed(2)}</option>)}
            </select>
          </label>
        )}
        {ui?.fields.includes('amount') && (
          <label style={{ fontSize: 12, color: '#9CA3AF' }}>סכום בש״ח (כמו בפורטל, למשל 40.00)
            <input value={amount} onChange={e => setAmount(e.target.value)} dir="ltr" inputMode="decimal" maxLength={9} style={input} />
          </label>
        )}
        {ui?.fields.includes('reference') && (
          <label style={{ fontSize: 12, color: '#9CA3AF' }}>אסמכתת הביטול / הזיכוי מהפורטל
            <input value={reference} onChange={e => setReference(e.target.value)} dir="ltr" maxLength={40} style={input} />
          </label>
        )}
        {ui && (
          <label style={{ fontSize: 12, color: '#9CA3AF' }}>הערה (חובה — נשמרת ביומן)
            <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={2} style={input} />
          </label>
        )}
        {ui && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#FFF' }}>
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> {ui.confirm}
          </label>
        )}
        {action === 'finalize' && duplicate && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#F97316' }}>
            <input type="checkbox" checked={ackDuplicate} onChange={e => setAckDuplicate(e.target.checked)} /> ידוע לי שיש חיוב כפול; את העודף אזכה בנפרד בפורטל HYP.
          </label>
        )}
        {ui && (
          <button type="button" onClick={submit} disabled={!ready}
                  style={{ minHeight: 40, padding: '8px 12px', background: ready ? '#FFD700' : '#333', color: ready ? '#000' : '#777', border: 'none', borderRadius: 8, fontWeight: 900, cursor: ready ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
            {busy ? 'שומר…' : 'אישור הפעולה'}
          </button>
        )}
        {message && <div role="status" style={{ fontSize: 12, color: '#D1D5DB' }}>{message}</div>}
      </div>
    </details>
  )
}

export function PaymentsReconciliationList({ items, available, error, canRecover = false, onAction }: {
  items: ReconciliationItem[]; available: boolean; error: string; canRecover?: boolean; onAction?: RecoverySubmit
}) {
  if (!available) return <div role="status" style={{ color: '#9CA3AF', padding: 24, textAlign: 'center' }}>מודול התשלומים המקוונים אינו מותקן במסד הנתונים.</div>
  return (
    <section dir="rtl" aria-label="התאמת תשלומים מקוונים" style={{ display: 'grid', gap: 10 }}>
      <div role="note" style={{ background: '#111', border: '1px solid #333', borderRadius: 10, padding: '8px 12px', color: '#9CA3AF', fontSize: 12, lineHeight: 1.6 }}>
        {canRecover
          ? 'פעולות צוות מתועדות ביומן עם שם המשתמש. המערכת לא מבצעת זיכויים או ביטולים — אלה נעשים בפורטל HYP ורק נרשמים כאן עם האסמכתא.'
          : 'תצוגה לקריאה בלבד. פעולות צוות זמינות רק למנהלים מורשים; הטיפול דרך פורטל HYP ופנייה ללקוח, לפי מספר ההפניה.'}
      </div>
      {error && <div role="alert" style={{ color: '#FF6B6B', fontSize: 13 }}>❌ {error}</div>}
      {items.length === 0 && !error && <div role="status" style={{ color: '#4ADE80', padding: 24, textAlign: 'center' }}>✅ אין תשלומים שדורשים טיפול</div>}
      {items.map(it => {
        const c = CATEGORY_LABELS[it.category]; const m = MONEY_STATE_LABELS[it.moneyState]
        return (
          <article key={it.ref} aria-label={c.label} style={{ background: '#1A1A1A', border: `1px solid ${c.color}`, borderRadius: 12, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <strong style={{ color: c.color, fontSize: 14 }}>{c.urgent ? '⚠ ' : ''}{c.label}</strong>
              <span style={{ color: '#FFD700', fontWeight: 900, fontSize: 16 }}>₪{it.amount.toFixed(2)}</span>
            </div>
            <span style={{ display: 'inline-block', marginTop: 6, fontSize: 11, fontWeight: 700, color: m.color, border: `1px solid ${m.color}`, borderRadius: 20, padding: '1px 8px' }}>{m.label}</span>
            <p style={{ color: '#D1D5DB', fontSize: 12, margin: '6px 0', lineHeight: 1.5 }}>{c.hint}</p>
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '4px 12px', margin: 0, fontSize: 12, color: '#9CA3AF' }}>
              <div><dt style={{ display: 'inline' }}>הפניה (HYP Order): </dt><dd style={{ display: 'inline', margin: 0, color: '#FFF', fontFamily: 'monospace', direction: 'ltr' }}>{it.ref}</dd></div>
              <div><dt style={{ display: 'inline' }}>לקוח: </dt><dd style={{ display: 'inline', margin: 0, color: '#FFF' }}>{it.customerName ?? '—'} {it.phone ? <a href={`tel:${it.phone}`} style={{ color: '#FFD700' }}>{it.phone}</a> : null}</dd></div>
              <div><dt style={{ display: 'inline' }}>נוצר: </dt><dd style={{ display: 'inline', margin: 0 }}>{time(it.createdAt)}</dd></div>
              <div><dt style={{ display: 'inline' }}>חזרה: </dt><dd style={{ display: 'inline', margin: 0 }}>{time(it.returnedAt)}</dd></div>
              <div><dt style={{ display: 'inline' }}>אושר תשלום: </dt><dd style={{ display: 'inline', margin: 0 }}>{time(it.paidAt)}</dd></div>
              <div><dt style={{ display: 'inline' }}>עודכן: </dt><dd style={{ display: 'inline', margin: 0 }}>{time(it.updatedAt)}</dd></div>
              {it.dailyNumber !== null && <div><dt style={{ display: 'inline' }}>הזמנה: </dt><dd style={{ display: 'inline', margin: 0, color: '#FFF' }}>#{it.dailyNumber}</dd></div>}
              {it.errorCode && <div><dt style={{ display: 'inline' }}>קוד: </dt><dd style={{ display: 'inline', margin: 0, fontFamily: 'monospace', direction: 'ltr' }}>{it.errorCode}</dd></div>}
            </dl>
            {it.staffFlag && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#FBBF24' }}>
                🏷 {it.staffFlag === 'refund_required' ? 'נדרש זיכוי (טרם בוצע)' : 'לבירור'} · {it.staffFlagBy} · {time(it.staffFlagAt)}{it.staffFlagNote ? ` · ${it.staffFlagNote}` : ''}
              </div>
            )}
            {it.transactions.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingInlineStart: 18, fontSize: 12, color: '#9CA3AF' }}>
                {it.transactions.map(t => (
                  <li key={t.hypTransId}>עסקה <span style={{ fontFamily: 'monospace', direction: 'ltr', color: '#FFF' }}>{t.hypTransId}</span> · CCode {t.ccode} · {t.outcome === 'approved' ? 'אושר' : t.outcome === 'non_capture' ? 'ללא חיוב' : 'נדחה'} · ₪{t.amount.toFixed(2)}{t.source === 'portal' ? ' · אושר ידנית מהפורטל' : ''}</li>
                ))}
              </ul>
            )}
            {it.reversals.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, fontSize: 12, color: '#60A5FA' }}>
                {it.reversals.map(r => (
                  <li key={r.reference}>{r.kind === 'void' ? 'ביטול' : 'זיכוי'} שבוצע בפורטל · אסמכתא <span style={{ fontFamily: 'monospace', direction: 'ltr' }}>{r.reference}</span> · ₪{r.amount.toFixed(2)} · {r.staffUser} · {time(r.createdAt)}</li>
                ))}
              </ul>
            )}
            {canRecover && onAction && it.actions.length > 0 && <RecoveryForm item={it} onSubmit={onAction} />}
          </article>
        )
      })}
    </section>
  )
}

const RESULT_MESSAGES: Record<string, string> = {
  recorded: '✅ נרשם', already_recorded: 'ℹ כבר נרשם קודם — לא נרשם שוב', already_flagged: 'ℹ כבר מסומן', reversed: '✅ הביטול / הזיכוי נרשם',
  reversal_recorded: '✅ נרשם (חלקי / חיוב נוסף)', amount_mismatch: '⚠ נרשם — הסכום שונה מסכום ההזמנה', finalized: '✅ ההזמנה נשלחה למטבח',
  already_finalized: 'ℹ ההזמנה כבר נשלחה למטבח', action_not_allowed: '❌ הפעולה אינה זמינה במצב הנוכחי', duplicate_ack_required: '❌ יש לאשר את הטיפול בחיוב הכפול',
  trans_id_conflict: '❌ מספר העסקה כבר משויך לתשלום אחר', reference_conflict: '❌ האסמכתא כבר נרשמה עם פרטים אחרים',
  amount_exceeds_charge: '❌ הסכום גבוה מהחיוב', transaction_not_found: '❌ העסקה לא נמצאה', invalid_amount: '❌ סכום לא תקין',
  invalid_hyp_trans_id: '❌ מספר עסקה לא תקין', invalid_reference: '❌ אסמכתא לא תקינה', invalid_note: '❌ נא להזין הערה',
}

export default function PaymentsTab({ branch, onUnauthorized }: { branch: string | null; onUnauthorized: () => void }) {
  const [items, setItems] = useState<ReconciliationItem[]>([])
  const [available, setAvailable] = useState(true)
  const [canRecover, setCanRecover] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const load = async () => {
      try {
        const res = await fetch(`/api/kitchen/payments${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        if (cancelled) return
        if (res.status === 401) { onUnauthorized(); return }
        const json = await res.json().catch(() => null)
        if (!res.ok || !json) { setError('טעינת התשלומים נכשלה — מנסה שוב…'); return }
        setAvailable(json.available !== false); setCanRecover(json.canRecover === true)
        setItems(Array.isArray(json.items) ? json.items : []); setError('')
      } catch {
        if (!cancelled) setError('טעינת התשלומים נכשלה — מנסה שוב…')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; controller.abort(); clearInterval(id) }
  }, [branch, onUnauthorized, reload])

  const onAction = useCallback<RecoverySubmit>(async (ref, payload) => {
    try {
      const res = await fetch(`/api/kitchen/payments/${encodeURIComponent(ref)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store', credentials: 'same-origin' })
      if (res.status === 401) { onUnauthorized(); return { ok: false, message: '' } }
      const json = await res.json().catch(() => null)
      const code = String(json?.result ?? json?.error ?? '')
      setReload(r => r + 1)
      return { ok: res.ok, message: RESULT_MESSAGES[code] ?? (res.ok ? '✅ בוצע' : `❌ הפעולה נדחתה (${code || res.status})`) }
    } catch {
      return { ok: false, message: '❌ אין חיבור — לא ידוע אם נשמר. רעננו את הרשימה לפני ניסיון נוסף.' }
    }
  }, [onUnauthorized])

  if (loading) return <div role="status" style={{ textAlign: 'center', padding: 40, color: '#6B7280' }}>טוען תשלומים…</div>
  return <PaymentsReconciliationList items={items} available={available} error={error} canRecover={canRecover} onAction={onAction} />
}
