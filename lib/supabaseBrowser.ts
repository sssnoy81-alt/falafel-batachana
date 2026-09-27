// Browser (public) Supabase client — PUBLIC config only (FALAFEL-SN-06E).
// Uses NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY (the public anon/publishable key), which
// Next.js inlines at build time. Never put a service/secret key here. No hardcoded keys: rotating the
// public key later only requires changing the env value and redeploying.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

export function getBrowserSupabase(): SupabaseClient {
  if (cached) return cached
  // Literal property access is required for Next.js build-time inlining of NEXT_PUBLIC_* values.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Public Supabase config missing (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)')
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return cached
}
