// SERVER-ONLY Supabase client. Import only from route handlers (app/api/**).
// - The privileged key comes from a NON-public env var, so Next.js never inlines it into browser bundles.
// - No hardcoded key. No fallback to the anon key: if the key is missing, callers fail loudly.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerConfigError'
  }
}

let cached: SupabaseClient | null = null

export function getServerSupabase(): SupabaseClient {
  if (cached) return cached
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  // SUPABASE_SERVICE_KEY is preferred; SUPABASE_SERVICE_ROLE_KEY is accepted because existing code already referenced it.
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new ServerConfigError('Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new ServerConfigError('Missing SUPABASE_SERVICE_KEY (server-only). Refusing to fall back to the anon key.')
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return cached
}
