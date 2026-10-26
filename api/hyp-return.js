// Hyp Pay success-redirect capture (HYP-32) — a plain Vercel Function OUTSIDE Next.js (Node.js runtime, CommonJS:
// the project's package.json has no "type": "module").
//
// Next.js re-serializes query strings before any app code runs (lib/hyp/hypCapture.ts). This function is the URL the Hyp
// portal redirects the customer to: it takes the raw request target (Node IncomingMessage.url) and slices off its query
// EXACTLY as received — no URL parsing, no decoding, no re-encoding — then answers 303 to the FIXED app route with the
// canonical base64url envelope:
//   /api/payments/hyp/return?r=<base64url(query bytes)>
// It trusts nothing, reads no env, has no secret, no DB and no Hyp call; every rule (parser, record_hyp_return,
// server-side VERIFY, finalize only on CCode=0) stays in the app route. It never logs the query.
// Must match lib/hyp/hypCapture.ts (HYP_CAPTURE_PARAM, HYP_CAPTURE_RAW_MAX, encodeCaptureEnvelope) — asserted by
// scripts/verify-hyp-capture.mjs.
'use strict'

const RETURN_ROUTE = '/api/payments/hyp/return'
const GENERIC_PAGE = '/order/payment'
const RAW_MAX = 4000
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/   // a request target is ASCII; anything else is refused, never mangled
const HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }

/** Pure core, exported for the tests: method + raw request target → redirect location. */
function captureLocation(method, url) {
  if (method !== 'GET') return { status: 405 }
  const target = typeof url === 'string' ? url : ''
  const q = target.indexOf('?')
  const raw = q < 0 ? '' : target.slice(q + 1).split('#')[0]
  if (!raw || raw.length > RAW_MAX || !PRINTABLE_ASCII.test(raw)) return { status: 303, location: GENERIC_PAGE }
  return { status: 303, location: `${RETURN_ROUTE}?r=${Buffer.from(raw, 'latin1').toString('base64url')}` }
}

function handler(req, res) {
  const r = captureLocation(req.method, req.url)
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v)
  if (r.status === 405) { res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end() }
  res.statusCode = 303
  res.setHeader('Location', r.location)
  return res.end()
}

module.exports = handler
module.exports.captureLocation = captureLocation
