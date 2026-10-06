// SERVER-ONLY kitchen authentication (FALAFEL-SN-06B; users moved to Supabase in FALAFEL-SN-08D15).
// - Users + scrypt password hashes live in the server-only table public.kitchen_users (RLS on, no anon /
//   authenticated access). This module never talks to the database: it receives a KitchenUserStore
//   (lib/kitchenUsers.ts provides the Supabase service-role one), so every rule here is unit-testable.
// - Sessions are HMAC-SHA256-signed tokens (KITCHEN_SESSION_SECRET, server env) in an HttpOnly cookie.
// - Built-in node:crypto only. No Next.js / Supabase imports.
// Never import this module from a client component: node:crypto cannot be bundled for the browser
// (build fails) and the runtime guard below throws.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

if (typeof window !== 'undefined') {
  throw new Error('lib/kitchenAuth is server-only')
}

/* ─── Types ─── */

export const KITCHEN_ROLES = ['admin', 'branch'] as const
export type KitchenRole = (typeof KITCHEN_ROLES)[number]

export interface KitchenUser {
  username: string
  role: KitchenRole
  branchId: string | null   // null for admin, required for branch
  label: string
}

/** SERVER-INTERNAL account row (public.kitchen_users). Never serialize it: use publicUser(). */
export interface KitchenUserRecord extends KitchenUser {
  isActive: boolean
  passwordHash: string
}

/** Where kitchen accounts come from. findByUsername gets a normalized username; returns inactive users too. */
export interface KitchenUserStore {
  /** null = no such (valid) user. Throws KitchenUserStoreError when the source is unavailable (fail closed). */
  findByUsername(username: string): Promise<KitchenUserRecord | null>
}

export interface KitchenSession extends KitchenUser {
  iat: number // seconds
  exp: number // seconds
}

export class KitchenConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KitchenConfigError'
  }
}

/** The user source could not be read (missing DB config / query failure). Message is a short code only. */
export class KitchenUserStoreError extends Error {
  constructor(public readonly kind: 'config' | 'query', code: string) {
    super(code)
    this.name = 'KitchenUserStoreError'
  }
}

/* ─── Constants ─── */

export const KITCHEN_SESSION_COOKIE = 'kitchen_session'
export const KITCHEN_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
const SESSION_VERSION = 'v1'
const MIN_SECRET_LENGTH = 32

// Verified production branch IDs (read-only DB verification, FALAFEL-SN-03B2).
export const KITCHEN_BRANCH_IDS: readonly string[] = [
  '8fed141d-0e7c-46c1-803b-88d3d811c1f8', // מישור אדומים
  '3ab15ad1-e835-492b-bae5-11b202ee2314', // מעבר מכמש
]

const USERNAME_REGEX = /^[a-z0-9_-]{2,32}$/
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const B64URL_REGEX = /^[A-Za-z0-9_-]+$/

/* ─── Password hashes: scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url> ─── */

export const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const
const SCRYPT_MAXMEM = 128 * 1024 * 1024

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; key: Buffer }

export function parsePasswordHash(hash: string): ParsedHash | null {
  if (typeof hash !== 'string') return null
  const parts = hash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [, nStr, rStr, pStr, saltStr, keyStr] = parts
  if (!/^\d+$/.test(nStr) || !/^\d+$/.test(rStr) || !/^\d+$/.test(pStr)) return null
  const N = Number(nStr), r = Number(rStr), p = Number(pStr)
  const isPow2 = (n: number) => n > 1 && (n & (n - 1)) === 0
  if (!isPow2(N) || N < 16384 || N > 1048576 || r < 8 || r > 32 || p < 1 || p > 4) return null
  if (!B64URL_REGEX.test(saltStr) || !B64URL_REGEX.test(keyStr)) return null
  const salt = Buffer.from(saltStr, 'base64url')
  const key = Buffer.from(keyStr, 'base64url')
  if (salt.length < 16 || key.length < 32 || key.length > 128) return null
  return { N, r, p, salt, key }
}

/** Produces a hash in the exact format parsePasswordHash accepts (same as scripts/hash-kitchen-password.mjs). */
export function hashPassword(password: string): string {
  const { N, r, p, keyLength, saltLength } = SCRYPT_DEFAULTS
  const salt = randomBytes(saltLength)
  const key = scryptSync(password, salt, keyLength, { N, r, p, maxmem: SCRYPT_MAXMEM })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export function verifyPassword(password: string, hash: string): boolean {
  const parsed = parsePasswordHash(hash)
  if (!parsed) return false
  const derived = scryptSync(password, parsed.salt, parsed.key.length, {
    N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAXMEM,
  })
  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key)
}

// Used when the username is unknown, so the response time does not reveal which usernames exist.
const DUMMY_HASH = hashPassword(randomBytes(24).toString('base64url'))

/* ─── kitchen_users rows (strict; malformed rows fail closed) ─── */

/** Login / lookup normalization (unchanged from the env era): trimmed, lower-case, ^[a-z0-9_-]{2,32}$. */
export function normalizeKitchenUsername(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const name = v.trim().toLowerCase()
  return USERNAME_REGEX.test(name) ? name : null
}

/**
 * Maps a public.kitchen_users row (username, password_hash, role, branch_id, label, is_active) to a record.
 * Returns null for ANY malformed row (bad username, hash format, role, branch, label, flag) — such an account
 * can neither log in nor keep a session (fail closed). Mirrors the DB CHECK constraints.
 */
export function kitchenUserFromRow(row: unknown): KitchenUserRecord | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const o = row as Record<string, unknown>
  if (typeof o.username !== 'string' || !USERNAME_REGEX.test(o.username)) return null
  if (typeof o.password_hash !== 'string' || !parsePasswordHash(o.password_hash)) return null
  if (typeof o.role !== 'string' || !(KITCHEN_ROLES as readonly string[]).includes(o.role)) return null
  if (typeof o.label !== 'string' || o.label.trim().length === 0 || o.label.length > 60) return null
  if (typeof o.is_active !== 'boolean') return null
  const role = o.role as KitchenRole
  let branchId: string | null = null
  if (role === 'admin') {
    if (o.branch_id !== null) return null
  } else {
    if (typeof o.branch_id !== 'string' || !UUID_REGEX.test(o.branch_id) || !KITCHEN_BRANCH_IDS.includes(o.branch_id)) return null
    branchId = o.branch_id
  }
  return { username: o.username, role, branchId, label: o.label.trim(), isActive: o.is_active, passwordHash: o.password_hash }
}

const toKitchenUser = (r: KitchenUserRecord): KitchenUser =>
  ({ username: r.username, role: r.role, branchId: r.branchId, label: r.label })

export function getSessionSecret(raw: string | undefined): string {
  if (!raw) throw new KitchenConfigError('KITCHEN_SESSION_SECRET is not set')
  if (raw.length < MIN_SECRET_LENGTH) throw new KitchenConfigError('KITCHEN_SESSION_SECRET is too short')
  return raw
}

/** Session signing secret from the server env. Throws KitchenConfigError (never includes the value). */
export const loadSessionSecret = (env: Record<string, string | undefined> = process.env): string =>
  getSessionSecret(env.KITCHEN_SESSION_SECRET)

/* ─── Credentials ─── */

/**
 * Password login against the store. Unknown, inactive, malformed and wrong-password logins are all
 * indistinguishable (null, and a scrypt verification runs in every case). Throws KitchenUserStoreError
 * when the store is unavailable — callers must fail closed (never fall back to another user source).
 */
export async function authenticateKitchenUser(store: KitchenUserStore, username: unknown, password: unknown): Promise<KitchenUser | null> {
  const name = normalizeKitchenUsername(username)
  if (!name || typeof password !== 'string' || password.length < 1 || password.length > 200) {
    verifyPassword(typeof password === 'string' ? password : '', DUMMY_HASH) // keep timing uniform
    return null
  }
  const record = await store.findByUsername(name)
  const usable = record && record.isActive && record.username === name ? record : null
  const ok = verifyPassword(password, usable ? usable.passwordHash : DUMMY_HASH)
  if (!usable || !ok) return null
  return toKitchenUser(usable)
}

/* ─── Sessions: v1.<payload b64url>.<hmac b64url> ─── */

const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest()

export function signSession(user: KitchenUser, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = {
    u: user.username, role: user.role, branchId: user.branchId, label: user.label,
    iat: nowSeconds, exp: nowSeconds + KITCHEN_SESSION_TTL_SECONDS,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = sign(secret, `${SESSION_VERSION}.${body}`).toString('base64url')
  return `${SESSION_VERSION}.${body}.${sig}`
}

export function verifySession(token: string | null | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): KitchenSession | null {
  if (typeof token !== 'string' || token.length > 2048) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null
  const [, body, sigStr] = parts
  if (!B64URL_REGEX.test(body) || !B64URL_REGEX.test(sigStr)) return null

  const expected = sign(secret, `${SESSION_VERSION}.${body}`)
  const given = Buffer.from(sigStr, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let p: Record<string, unknown>
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    p = v
  } catch {
    return null
  }
  if (typeof p.u !== 'string' || !USERNAME_REGEX.test(p.u)) return null
  if (typeof p.role !== 'string' || !(KITCHEN_ROLES as readonly string[]).includes(p.role)) return null
  if (typeof p.label !== 'string' || p.label.length === 0 || p.label.length > 60) return null
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return null
  const iat = p.iat as number, exp = p.exp as number
  if (exp <= nowSeconds || iat > nowSeconds + 60 || exp - iat > KITCHEN_SESSION_TTL_SECONDS) return null
  const role = p.role as KitchenRole
  if (role === 'admin') {
    if (p.branchId !== null) return null
  } else if (typeof p.branchId !== 'string' || !KITCHEN_BRANCH_IDS.includes(p.branchId)) {
    return null
  }
  return { username: p.u, role, branchId: (p.branchId as string | null), label: p.label, iat, exp }
}

/* ─── Cookies ─── */

export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

/**
 * Secure cookies everywhere except plain-http localhost during development.
 * Production (NODE_ENV=production, e.g. Vercel) is ALWAYS Secure.
 */
export function shouldUseSecureCookie(requestUrl: string, nodeEnv = process.env.NODE_ENV): boolean {
  if (nodeEnv === 'production') return true
  try {
    const u = new URL(requestUrl)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    return !(local && u.protocol === 'http:')
  } catch {
    return true
  }
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return [
    `${KITCHEN_SESSION_COOKIE}=${token}`, 'Path=/', `Max-Age=${KITCHEN_SESSION_TTL_SECONDS}`,
    'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function clearSessionCookieHeader(secure: boolean): string {
  return [
    `${KITCHEN_SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/* ─── Request helpers (standard Request; works with NextRequest) ─── */

export type AuthResult =
  | { ok: true; session: KitchenSession }
  | { ok: false; status: 401 | 500; error: 'unauthorized' | 'server_config' | 'server_error' }

/**
 * Verifies the cookie (signature + expiry) AND that the user still exists in the store, is active, and has
 * the same role / branch as the session. Removed, deactivated or re-scoped users are revoked immediately.
 * Order: secret (500) → cookie (401, no DB hit) → store lookup (500 if unavailable, never authorizes).
 * Routes use getKitchenSession() from lib/kitchenUsers (this with the Supabase store) and MUST await it.
 */
export async function verifyKitchenRequest(
  req: Request, deps: { store: KitchenUserStore; env?: Record<string, string | undefined> },
): Promise<AuthResult> {
  let secret: string
  try {
    secret = loadSessionSecret(deps.env ?? process.env)
  } catch (e) {
    if (e instanceof KitchenConfigError) return { ok: false, status: 500, error: 'server_config' }
    throw e
  }
  const session = verifySession(readCookie(req.headers.get('cookie'), KITCHEN_SESSION_COOKIE), secret)
  if (!session) return { ok: false, status: 401, error: 'unauthorized' }
  let current: KitchenUserRecord | null
  try {
    current = await deps.store.findByUsername(session.username)
  } catch (e) {
    if (e instanceof KitchenUserStoreError) return { ok: false, status: 500, error: e.kind === 'config' ? 'server_config' : 'server_error' }
    throw e
  }
  if (!current || !current.isActive || current.username !== session.username
    || current.role !== session.role || current.branchId !== session.branchId)
    return { ok: false, status: 401, error: 'unauthorized' } // removed / disabled / changed user → session revoked
  return { ok: true, session }
}

/**
 * CSRF protection for state-changing requests (in addition to SameSite=Strict):
 * - Origin header must be present and equal to the request's own origin
 * - Sec-Fetch-Site (when sent) must be same-origin
 * - body must be declared as JSON
 */
export function checkSameOriginJson(req: Request): boolean {
  let requestOrigin: string
  try {
    requestOrigin = new URL(req.url).origin
  } catch {
    return false
  }
  const origin = req.headers.get('origin')
  if (!origin || origin !== requestOrigin) return false
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  const contentType = (req.headers.get('content-type') || '').toLowerCase()
  return contentType.split(';')[0].trim() === 'application/json'
}

export const publicUser = (u: KitchenUser) =>
  ({ username: u.username, role: u.role, branchId: u.branchId, label: u.label })
