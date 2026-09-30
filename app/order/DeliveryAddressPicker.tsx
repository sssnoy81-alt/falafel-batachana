'use client'
// Google-assisted delivery address selector (FALAFEL-SN-08D8).
// Talks only to our own /api/places/* routes (the Google key stays on the server). The customer must pick a
// suggestion; the pick is verified server-side for the selected area, and re-verified again on order submit.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ADDRESS_REJECTION_MESSAGES, selectionLabel, withQuery, withSelection,
  type AddressPickerState, type SelectedDeliveryAddress,
} from '@/lib/deliveryAddressSelection'

interface Suggestion { placeId: string; text: string; mainText: string | null; secondaryText: string | null }

interface Props {
  state: AddressPickerState
  onChange: (next: AddressPickerState) => void
  /** Google search is not configured / unavailable → checkout switches to manual street + house entry. */
  onUnavailable: () => void
  colors: { green: string; gray: string; red: string; gold: string; border: string; bg: string; white: string }
  labelStyle: CSSProperties
  inputStyle: (ok: boolean) => CSSProperties
}

const post = async (path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

export default function DeliveryAddressPicker({ state, onChange, onUnavailable, colors: C, labelStyle, inputStyle }: Props) {
  // Results are tagged with the area + query they belong to, so stale results are never shown.
  const [results, setResults] = useState<{ key: string; items: Suggestion[] }>({ key: '', items: [] })
  const [message, setMessage] = useState('')
  const [searchDown, setSearchDown] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const sessionToken = useRef('')
  const unavailableRef = useRef(onUnavailable)
  useEffect(() => { unavailableRef.current = onUnavailable }, [onUnavailable])

  // One Google session per area; Place Details (selection) ends it.
  useEffect(() => { sessionToken.current = crypto.randomUUID() }, [state.city])

  // Debounced suggestions while typing (never after a valid selection, never without an area).
  useEffect(() => {
    const q = state.query.trim()
    if (state.selected || !state.city || q.length < 2) return
    const key = `${state.city}|${q}`
    const t = setTimeout(async () => {
      const { status, data } = await post('/api/places/autocomplete', { input: q, city: state.city, sessionToken: sessionToken.current })
        .catch(() => ({ status: 0, data: {} as Record<string, unknown> }))
      if (status === 503 && data.error === 'not_configured') { unavailableRef.current(); return }
      if (status !== 200) { setResults({ key, items: [] }); setSearchDown(true); return }
      setSearchDown(false)
      setResults({ key, items: Array.isArray(data.suggestions) ? (data.suggestions as Suggestion[]) : [] })
    }, 300)
    return () => clearTimeout(t)
  }, [state.query, state.city, state.selected])

  async function select(s: Suggestion) {
    setVerifying(true); setMessage(''); setResults({ key: '', items: [] })
    const { status, data } = await post('/api/places/details', { placeId: s.placeId, city: state.city, sessionToken: sessionToken.current })
      .catch(() => ({ status: 0, data: {} as Record<string, unknown> }))
    sessionToken.current = crypto.randomUUID()
    setVerifying(false)
    if (status === 200 && data.place) {
      onChange(withSelection(state, data.place as SelectedDeliveryAddress))
      return
    }
    if (status === 503 && data.error === 'not_configured') { onUnavailable(); return }
    const reason = typeof data.reason === 'string' && data.reason in ADDRESS_REJECTION_MESSAGES ? data.reason : 'unknown'
    setMessage(ADDRESS_REJECTION_MESSAGES[reason as keyof typeof ADDRESS_REJECTION_MESSAGES])
  }

  const selected = state.selected
  const suggestions = !selected && results.key === `${state.city}|${state.query.trim()}` ? results.items : []
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>כתובת למשלוח *</label>
      <input type="text" value={state.query} dir="rtl" maxLength={120} disabled={!state.city || verifying}
        placeholder={state.city ? 'התחל להקליד רחוב ומספר בית' : 'בחרו קודם יישוב'}
        onChange={e => { setMessage(''); onChange(withQuery(state, e.target.value)) }}
        style={inputStyle(!!selected)} />
      {suggestions.length > 0 && !selected && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, marginTop: 6, overflow: 'hidden' }}>
          {suggestions.map(s => (
            <button key={s.placeId} type="button" onClick={() => select(s)}
              style={{ display: 'block', width: '100%', textAlign: 'right', padding: '10px 12px', background: C.bg, color: C.white, border: 'none', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', fontFamily: 'Heebo, sans-serif' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{s.mainText ?? s.text}</div>
              {s.secondaryText && <div style={{ fontSize: 12, color: C.gray }}>{s.secondaryText}</div>}
            </button>
          ))}
        </div>
      )}
      {verifying && <div style={{ color: C.gray, fontSize: 13, marginTop: 6 }}>מאמתים את הכתובת...</div>}
      {selected && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: C.green, fontWeight: 700, fontSize: 15 }}>✅ הכתובת נמצאה</div>
          <div style={{ color: C.gray, fontSize: 13 }}>{selectionLabel(selected)}</div>
        </div>
      )}
      {message && <div style={{ color: C.red, fontSize: 13, marginTop: 6 }}>{message}</div>}
      {!selected && state.query.trim().length >= 2 && !verifying && !message && suggestions.length === 0 && !searchDown && (
        <div style={{ color: C.gray, fontSize: 12, marginTop: 6 }}>יש לבחור כתובת מהרשימה</div>
      )}
      {searchDown && (
        <div style={{ fontSize: 13, marginTop: 6, color: C.gray }}>
          החיפוש אינו זמין כרגע.{' '}
          <button type="button" onClick={onUnavailable}
            style={{ background: 'none', border: 'none', color: C.gold, cursor: 'pointer', padding: 0, fontFamily: 'Heebo, sans-serif', fontSize: 13, textDecoration: 'underline' }}>
            הזנת כתובת ידנית
          </button>
        </div>
      )}
    </div>
  )
}
