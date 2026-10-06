import { NextRequest, NextResponse } from 'next/server'
import {
  KitchenConfigError, KitchenUserStoreError, authenticateKitchenUser, checkSameOriginJson, loadSessionSecret, publicUser,
  sessionCookieHeader, shouldUseSecureCookie, signSession,
} from '@/lib/kitchenAuth'
import { supabaseKitchenUserStore } from '@/lib/kitchenUsers'

// POST /api/kitchen/login — { username, password } → HttpOnly session cookie.
// Users come from public.kitchen_users (server-only, service role). Generic 401 for unknown / inactive /
// wrong-password (never reveals whether the username exists). DB / config problems → 500, never a login.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } })

const failDelay = () => new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 300)))

export async function POST(req: NextRequest) {
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const { username, password } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string'
    || username.length < 1 || username.length > 64 || password.length < 1 || password.length > 200)
    return json({ error: 'invalid_request' }, 400)

  let secret: string
  try {
    secret = loadSessionSecret()
  } catch (e) {
    if (e instanceof KitchenConfigError) {
      console.error('kitchen login: server config error —', e.message) // message never contains values
      return json({ error: 'server_config' }, 500)
    }
    throw e
  }

  let user
  try {
    user = await authenticateKitchenUser(supabaseKitchenUserStore, username, password)
  } catch (e) {
    if (e instanceof KitchenUserStoreError) {
      console.error('kitchen login: user store unavailable —', e.message) // short code only
      return json({ error: e.kind === 'config' ? 'server_config' : 'server_error' }, 500)
    }
    throw e
  }
  if (!user) {
    await failDelay()
    return json({ error: 'unauthorized' }, 401)
  }

  const token = signSession(user, secret)
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookieHeader(token, shouldUseSecureCookie(req.url)) })
}
