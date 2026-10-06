// SERVER-ONLY kitchen account repository (FALAFEL-SN-08D15). Import only from route handlers (app/api/**).
// public.kitchen_users is read with the existing service-role client (lib/supabaseServer) — RLS is on and
// anon / authenticated have no access, so the browser can never read it. Password hashes stay inside the
// server: records returned here are server-internal; routes respond with publicUser() only.
// Fails closed: missing config / query errors throw KitchenUserStoreError (→ 500, never authorized).
// There is no other user source (no env fallback). Logs short codes only (never usernames, hashes, rows).

import { getServerSupabase, ServerConfigError } from './supabaseServer'
import {
  KitchenUserStoreError, kitchenUserFromRow, normalizeKitchenUsername, verifyKitchenRequest,
  type AuthResult, type KitchenUserRecord, type KitchenUserStore,
} from './kitchenAuth'

if (typeof window !== 'undefined') {
  throw new Error('lib/kitchenUsers is server-only')
}

export const KITCHEN_USER_TABLE = 'kitchen_users'
/** Explicit column list (no *). password_hash is read for login verification only. */
export const KITCHEN_USER_COLUMNS = 'username, password_hash, role, branch_id, label, is_active'

/**
 * The account for a username, active or not (null when absent, malformed, or the username is invalid).
 * SERVER-INTERNAL: the result contains the password hash — never return it to a client.
 */
export async function getKitchenUserByUsername(username: string): Promise<KitchenUserRecord | null> {
  const name = normalizeKitchenUsername(username)
  if (!name) return null
  let supabase
  try {
    supabase = getServerSupabase()
  } catch (e) {
    if (e instanceof ServerConfigError) throw new KitchenUserStoreError('config', 'kitchen_users_not_configured')
    throw e
  }
  const { data, error } = await supabase.from(KITCHEN_USER_TABLE).select(KITCHEN_USER_COLUMNS).eq('username', name).maybeSingle()
  if (error) {
    console.error('kitchen users: query failed', error.code) // code only
    throw new KitchenUserStoreError('query', 'kitchen_users_query_failed')
  }
  if (!data) return null
  const record = kitchenUserFromRow(data)
  if (!record || record.username !== name) {
    console.error('kitchen users: invalid row') // fail closed; no row contents in logs
    return null
  }
  return record
}

/** The account only if it exists, is valid and is_active = true. SERVER-INTERNAL (contains the hash). */
export async function getActiveKitchenUser(username: string): Promise<KitchenUserRecord | null> {
  const record = await getKitchenUserByUsername(username)
  return record && record.isActive ? record : null
}

/** The production store: Supabase service role, one authoritative source. */
export const supabaseKitchenUserStore: KitchenUserStore = { findByUsername: getKitchenUserByUsername }

/**
 * Kitchen session for a request: HMAC cookie + expiry, then the CURRENT kitchen_users row (exists, active,
 * same role and branch). Async — every caller must `await` it before touching data.
 */
export function getKitchenSession(req: Request): Promise<AuthResult> {
  return verifyKitchenRequest(req, { store: supabaseKitchenUserStore, env: process.env })
}
