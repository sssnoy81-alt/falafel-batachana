// Online-payment (Hyp Pay) pilot scope (HYP-07). Pure: reads only the env object it is given.
// Enforced by the server routes, never only by the UI. Fail closed: anything but the exact string 'true' is OFF.

import type { OrderType } from '../orderConfig'

export type EnvLike = Record<string, string | undefined>

/** HYP_PAYMENTS_ENABLED — default OFF; missing, empty, 'TRUE', '1', 'yes' … are all OFF. */
export const isHypPaymentsEnabled = (env: EnvLike): boolean => env.HYP_PAYMENTS_ENABLED === 'true'

/** Pilot: מישור אדומים only (Production branch id, lib/orderConfig DELIVERY_BRANCH_IDS). */
export const HYP_ALLOWED_BRANCH_IDS: readonly string[] = ['8fed141d-0e7c-46c1-803b-88d3d811c1f8']

/** Pilot: pickup only — no online delivery (lib/maalePayload refuses 'online') and therefore no online parcel. */
export const HYP_ALLOWED_ORDER_TYPES: readonly OrderType[] = ['pickup']

/**
 * HYP_PILOT_PHONES — REQUIRED controlled-pilot allowlist of customer phones (comma-separated, 05XXXXXXXX). ONLY these
 * phones may start an online payment. Fail closed (HYP-12C): unset / empty / whitespace-only = nobody, and a malformed
 * list (dash, +972, trailing comma, > 20 entries) = nobody. Opening to all customers: HYP_PAYMENTS_AUDIENCE below.
 */
export function hypPilotPhones(env: EnvLike): readonly string[] | null {
  const raw = (env.HYP_PILOT_PHONES ?? '').trim()
  if (!raw) return null
  const phones = raw.split(',').map(p => p.trim())
  if (phones.length > 20 || phones.some(p => !/^05\d{8}$/.test(p))) return null
  return phones
}

export function isHypPilotPhoneAllowed(env: EnvLike, normalizedPhone: string): boolean {
  const phones = hypPilotPhones(env)
  return phones !== null && phones.includes(normalizedPhone)
}

/**
 * HYP_PAYMENTS_AUDIENCE (HYP-46) — exactly 'all' opens online payment to every customer phone the authoritative order
 * parser accepts; anything else (unset, 'ALL', 'true', …) keeps the HYP_PILOT_PHONES allowlist. Phone scope only: the
 * branch / pickup restrictions, HYP_PAYMENTS_ENABLED and server-side VERIFY are unchanged.
 */
export const isHypOpenToAllPhones = (env: EnvLike): boolean => env.HYP_PAYMENTS_AUDIENCE === 'all'

/** The phone gate of POST /api/payments/hyp/start. */
export const isHypPhoneAllowed = (env: EnvLike, normalizedPhone: string): boolean =>
  isHypOpenToAllPhones(env) || isHypPilotPhoneAllowed(env, normalizedPhone)

/** Whether any customer can pass the phone gate (GET /api/payments/config shows the option only then). */
export const isHypAudienceConfigured = (env: EnvLike): boolean => isHypOpenToAllPhones(env) || hypPilotPhones(env) !== null

export const HYP_INTENT_TTL_SECONDS = 900          // payment_intents.expires_at = created_at + 15 min
export const HYP_PAYMENT_DESCRIPTION = 'Falafel BaTachana'
