import { handleHypReturn } from '@/lib/hyp/hypPaymentService'
import { productionHypDeps } from '@/lib/hyp/hypDeps'

// GET /api/payments/hyp/return — the terminal's success-page URL (configured in the Hyp portal) (HYP-07).
// Stores the raw return, verifies it server-to-server, records the verified outcome and finalizes only a confirmed
// capture; then 303 to the fixed status page. The browser's parameters are never proof of payment.

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return handleHypReturn(req, productionHypDeps())
}
