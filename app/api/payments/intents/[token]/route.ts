import { handleIntentStatus } from '@/lib/hyp/hypPaymentService'
import { productionHypDeps } from '@/lib/hyp/hypDeps'

// GET /api/payments/intents/[token] — customer payment status (HYP-07). The random public token is the capability.
// Returns a sanitized state only, plus order / daily number and the existing tracking reference once finalized.
// Never names, phones, amounts, internal intent ids or HYP transaction data.

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleIntentStatus(req, token, productionHypDeps())
}
