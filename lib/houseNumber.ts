// Customer-entered house number for a Google route-only selection (FALAFEL-SN-08D14D). Pure, client-safe.
// Used ONLY when Google verified the street but has no street_number for it. The same rule runs in the browser
// (UX) and on the server (authoritative, lib/orderAddress).

// 1–9999 without a leading zero, optionally one Hebrew letter suffix ("3", "12", "12א"; "12 א" is normalized).
const HOUSE_NUMBER = /^([1-9]\d{0,3}) ?([א-ת])?$/
const HINT_TOKEN = /^[1-9]\d{0,3}[א-ת]?$/

/** Normalized house number ("12א"), or null when not a plain house number. Max 5 chars (DB limit is 20). */
export function normalizeManualHouseNumber(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(HOUSE_NUMBER)
  return m ? m[1] + (m[2] ?? '') : null
}

/** UI PREFILL ONLY: the last "<number>[letter]" token of the typed search text ("הגעש 3" → "3"). Never trusted. */
export function extractHouseNumberHint(query: string): string {
  const tokens = query.split(/[\s,]+/).filter(Boolean)
  for (let i = tokens.length - 1; i >= 0; i--) if (HINT_TOKEN.test(tokens[i])) return tokens[i]
  return ''
}
