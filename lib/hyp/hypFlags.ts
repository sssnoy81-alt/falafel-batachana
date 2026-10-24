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
 * HYP_PILOT_PHONES — optional controlled-pilot allowlist of customer phones (comma-separated, 05XXXXXXXX). When set,
 * ONLY these phones may start an online payment (e.g. the owner's own phone during the test-terminal run, so no real
 * customer can "pay" on a test terminal). Unset / empty = no phone restriction. A malformed list blocks everyone.
 */
export function isHypPilotPhoneAllowed(env: EnvLike, normalizedPhone: string): boolean {
  const raw = (env.HYP_PILOT_PHONES ?? '').trim()
  if (!raw) return true
  const phones = raw.split(',').map(p => p.trim())
  if (phones.length > 20 || phones.some(p => !/^05\d{8}$/.test(p))) return false
  return phones.includes(normalizedPhone)
}

export const HYP_INTENT_TTL_SECONDS = 900          // payment_intents.expires_at = created_at + 15 min
export const HYP_PAYMENT_DESCRIPTION = 'Falafel BaTachana'
