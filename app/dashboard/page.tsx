import { redirect } from 'next/navigation'

// Legacy /dashboard retired (FALAFEL-SN-06E). It used a browser-side privileged Supabase key.
// The secure kitchen board lives at /dashboard/orders.
export default function LegacyDashboardRedirect() {
  redirect('/dashboard/orders')
}
