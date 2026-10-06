'use client'
// Developer-only diagnostic UI for the Google Places address POC (FALAFEL-SN-08D7).
// Talks only to our own /api/dev/places/* routes; the Google key never reaches the browser.

import { useEffect, useRef, useState } from 'react'

interface Suggestion { placeId: string; text: string; mainText: string | null; secondaryText: string | null; types: string[] }
interface Place {
  placeId: string; formattedAddress: string | null; lat: number | null; lng: number | null
  street: string | null; houseNumber: string | null; locality: string | null; types: string[]; cityMatchesSelectedArea: boolean
}

const newToken = () => crypto.randomUUID()
const post = async (path: string, body: unknown) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `http_${res.status}`)
  return data
}

const box: React.CSSProperties = { border: '1px solid #ccc', borderRadius: 8, padding: 12, marginTop: 12 }

export default function AddressPocClient({ areas }: { areas: string[] }) {
  const [city, setCity] = useState(areas[0] ?? '')
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [place, setPlace] = useState<Place | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const sessionToken = useRef<string>('')
  const skipNext = useRef(false)

  const resetSession = () => { sessionToken.current = newToken() }
  useEffect(() => { resetSession() }, [])

  // Debounced autocomplete — only while the developer is typing (never after a selection).
  useEffect(() => {
    if (skipNext.current) { skipNext.current = false; return }
    const q = input.trim()
    if (q.length < 2) { setSuggestions([]); return }
    const t = setTimeout(async () => {
      setError('')
      try {
        const data = await post('/api/dev/places/autocomplete', { input: q, city, sessionToken: sessionToken.current })
        setSuggestions(data.suggestions ?? [])
      } catch (e) { setSuggestions([]); setError(e instanceof Error ? e.message : 'error') }
    }, 300)
    return () => clearTimeout(t)
  }, [input, city])

  async function select(s: Suggestion) {
    setLoading(true); setError('')
    try {
      const data = await post('/api/dev/places/details', { placeId: s.placeId, city, sessionToken: sessionToken.current })
      setPlace(data.place)
      skipNext.current = true
      setInput(s.text)
      setSuggestions([])
    } catch (e) { setError(e instanceof Error ? e.message : 'error') }
    finally { setLoading(false); resetSession() } // Place Details ends the session
  }

  return (
    <main dir="rtl" style={{ maxWidth: 640, margin: '24px auto', padding: 16, fontFamily: 'system-ui, sans-serif', background: '#fff', color: '#111' }}>
      <h1 style={{ fontSize: 20 }}>Address POC — Google Places (dev only)</h1>
      <p style={{ fontSize: 13, color: '#666' }}>Diagnostic page. Not part of the order flow. Nothing is saved.</p>

      <label>יישוב משלוח{' '}
        <select value={city} onChange={e => { setCity(e.target.value); setPlace(null); setSuggestions([]); resetSession() }}>
          {areas.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>

      <div style={{ marginTop: 12 }}>
        <input value={input} onChange={e => { setInput(e.target.value); setPlace(null) }} placeholder="רחוב ומספר בית, למשל: הגעש 6"
          style={{ width: '100%', padding: 10, fontSize: 16, boxSizing: 'border-box' }} />
      </div>

      {suggestions.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0', border: '1px solid #ccc', borderRadius: 8 }}>
          {suggestions.map(s => (
            <li key={s.placeId}>
              <button type="button" onClick={() => select(s)} disabled={loading}
                style={{ width: '100%', textAlign: 'right', padding: 10, border: 'none', borderBottom: '1px solid #eee', background: '#fafafa', cursor: 'pointer' }}>
                <div style={{ fontWeight: 600 }}>{s.mainText ?? s.text}</div>
                <div style={{ fontSize: 12, color: '#666' }}>{s.secondaryText ?? ''} · {s.types.join(', ')}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <div style={{ ...box, borderColor: '#e33', color: '#b00' }}>error: {error}</div>}

      {place && (
        <div style={box}>
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <tbody>
              {([
                ['formatted address', place.formattedAddress],
                ['place_id', place.placeId],
                ['latitude', place.lat],
                ['longitude', place.lng],
                ['street (route)', place.street],
                ['house number (street_number)', place.houseNumber],
                ['locality', place.locality],
                ['types', place.types.join(', ')],
                ['city matches selected area', place.cityMatchesSelectedArea ? `✅ yes (${city})` : `❌ no (selected: ${city})`],
              ] as const).map(([k, v]) => (
                <tr key={k}><td style={{ padding: 4, color: '#666', whiteSpace: 'nowrap' }}>{k}</td><td style={{ padding: 4, direction: 'ltr', textAlign: 'left' }}>{v === null ? '—' : String(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
