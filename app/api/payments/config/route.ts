import { handlePaymentsConfig } from '@/lib/hyp/hypPaymentService'

// GET /api/payments/config — public, read-only (HYP-08). Whether the checkout may show the online-payment option and
// for which branch / order type. { hypPayments: null } unless HYP_PAYMENTS_ENABLED === 'true' AND the terminal
// configuration is valid. Never exposes credentials, terminal details or the reason it is off. Read per request.

export const dynamic = 'force-dynamic'

export async function GET() {
  return handlePaymentsConfig(process.env)
}
