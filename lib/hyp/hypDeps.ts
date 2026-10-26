// SERVER-ONLY production wiring for the payment routes (HYP-07): process.env, the Supabase service client, the real
// opening hours, module-level rate limiters and a code-only logger. Tests use lib/hyp/hypPaymentService directly.

import { isShopOpen } from '../hours'
import { resolveGoogleDeliveryAddress } from '../orderAddress'
import { attachDeliveryGeo } from '../orderGeo'
import { supabaseHypDb } from './hypDb'
import type { HypDeps } from './hypPaymentService'
import { createRateLimiter } from './hypRateLimit'

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypDeps is server-only')
}

const limits = {
  start: createRateLimiter(10, 60_000),          // per client address
  startPhone: createRateLimiter(5, 10 * 60_000), // per customer phone (never logged)
  ret: createRateLimiter(30, 60_000),
  status: createRateLimiter(60, 60_000),
}

export function productionHypDeps(): HypDeps {
  return {
    env: process.env,
    db: supabaseHypDb,
    isShopOpen: () => isShopOpen(),
    limits,
    log: (event, code) => console.error(`payments: ${event}${code ? ` ${code}` : ''}`),
    // HYP-DELIVERY-02: the same delivery steps as POST /api/orders (server Google verification + geocoding)
    resolveAddress: order => resolveGoogleDeliveryAddress(order),
    attachGeo: (order, built) => attachDeliveryGeo(order, built),
  }
}
