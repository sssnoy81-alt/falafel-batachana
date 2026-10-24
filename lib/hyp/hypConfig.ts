// SERVER-ONLY Hyp Pay terminal configuration (HYP-06). Pure: reads only the env object it is given, never logs,
// never returns a credential inside an error. Enabling online payments is NOT decided here (HYP-07 flag).
//
// Env (server-only, never NEXT_PUBLIC_*):
//   HYP_TERMINAL       terminal number ("Masof")
//   HYP_API_KEY        API key ("KEY")
//   HYP_PASSP          API password ("PassP")
//   HYP_TERMINAL_KIND  'test' | 'live' — must agree with the documented test-terminal prefix 00100
// A live terminal is refused unless VERCEL_ENV === 'production' (Preview shares the Production database).

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypConfig is server-only')
}

export type EnvLike = Record<string, string | undefined>
export type HypTerminalKind = 'test' | 'live'

export interface HypConfig {
  readonly terminal: string
  readonly apiKey: string
  readonly passP: string
  readonly terminalKind: HypTerminalKind
}

export type HypConfigErrorCode =
  | 'missing_credentials'              // one or more of the four variables is empty (names only are reported)
  | 'public_exposure'                  // a NEXT_PUBLIC_* variable names HYP or carries a HYP credential
  | 'invalid_terminal'
  | 'invalid_credential_format'
  | 'invalid_terminal_kind'
  | 'terminal_kind_mismatch'           // kind 'test' without the 00100 prefix, or 'live' with it
  | 'live_terminal_outside_production' // live terminal in Preview / development / local

export type HypConfigResult =
  | { ok: true; config: HypConfig }
  | { ok: false; error: HypConfigErrorCode; missing?: string[] }

/** Documented: "Test terminal numbers … always start with 00100" (developers.hyp.co.il, Safe Testing & Environments). */
export const HYP_TEST_TERMINAL_PREFIX = '00100'
// ASSUMPTION: the documented examples are 10 digits (0010345518); 6–12 digits accepted, digits only.
const TERMINAL_RE = /^[0-9]{6,12}$/
// Printable ASCII without spaces (credentials travel in a query string, URL-encoded by the client).
const CREDENTIAL_RE = /^[\x21-\x7e]{4,200}$/

export function resolveHypConfig(env: EnvLike): HypConfigResult {
  const terminal = (env.HYP_TERMINAL ?? '').trim()
  const apiKey = (env.HYP_API_KEY ?? '').trim()
  const passP = (env.HYP_PASSP ?? '').trim()
  const kind = (env.HYP_TERMINAL_KIND ?? '').trim()

  const missing = ([['HYP_TERMINAL', terminal], ['HYP_API_KEY', apiKey], ['HYP_PASSP', passP], ['HYP_TERMINAL_KIND', kind]] as const)
    .filter(([, v]) => !v).map(([name]) => name)
  if (missing.length) return { ok: false, error: 'missing_credentials', missing }

  // A credential in a NEXT_PUBLIC_ variable would be inlined into the browser bundle.
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue
    const v = (value ?? '').trim()
    if (/HYP/i.test(name) || (v && (v === apiKey || v === passP))) return { ok: false, error: 'public_exposure' }
  }

  if (!TERMINAL_RE.test(terminal)) return { ok: false, error: 'invalid_terminal' }
  if (!CREDENTIAL_RE.test(apiKey) || !CREDENTIAL_RE.test(passP)) return { ok: false, error: 'invalid_credential_format' }
  if (kind !== 'test' && kind !== 'live') return { ok: false, error: 'invalid_terminal_kind' }
  if ((kind === 'test') !== terminal.startsWith(HYP_TEST_TERMINAL_PREFIX)) return { ok: false, error: 'terminal_kind_mismatch' }
  if (kind === 'live' && env.VERCEL_ENV !== 'production') return { ok: false, error: 'live_terminal_outside_production' }

  return { ok: true, config: Object.freeze({ terminal, apiKey, passP, terminalKind: kind }) }
}
