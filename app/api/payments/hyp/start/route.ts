import { handleHypStart } from '@/lib/hyp/hypPaymentService'
import { productionHypDeps } from '@/lib/hyp/hypDeps'

// POST /api/payments/hyp/start — online-payment checkout start (HYP-07). OFF unless HYP_PAYMENTS_ENABLED === 'true'
// (404 otherwise). Pilot scope enforced in lib/hyp/hypFlags: מישור אדומים, pickup only. Creates a payment intent from a
// server-built snapshot and returns the Hyp payment-page URL. Never creates an order (that happens only after VERIFY).

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  return handleHypStart(req, productionHypDeps())
}
