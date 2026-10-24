// Fixed-window in-memory rate limiter for the public payment routes (HYP-07). Pure, clock injected.
// LIMITATION (documented): per serverless instance only. The hard bound on charges is in the database
// (one open intent per phone + branch, checkout_key idempotency); this only blunts request floods.

export interface RateLimiter {
  /** true when the request is allowed (and counted). */
  hit(key: string): boolean
}

export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 5000): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    hit(key: string): boolean {
      const t = now()
      const w = windows.get(key)
      if (!w || t - w.start >= windowMs) {
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k)
          if (windows.size >= maxKeys) return false   // saturated: fail closed
        }
        windows.set(key, { start: t, count: 1 })
        return true
      }
      if (w.count >= limit) return false
      w.count++
      return true
    },
  }
}

/** Client address as set by the Vercel edge (x-real-ip, else the first x-forwarded-for hop). */
export function clientKey(req: Request): string {
  const real = (req.headers.get('x-real-ip') ?? '').trim()
  const fwd = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  const ip = real || fwd
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : 'unknown'
}
