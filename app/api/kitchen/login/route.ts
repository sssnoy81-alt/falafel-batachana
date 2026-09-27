import { NextRequest, NextResponse } from 'next/server'
import {
  KitchenConfigError, authenticate, checkSameOriginJson, loadKitchenConfig, publicUser,
  sessionCookieHeader, shouldUseSecureCookie, signSession,
} from '@/lib/kitchenAuth'

// POST /api/kitchen/login — { username, password } → HttpOnly session cookie.
// No DB access. Generic 401 (never reveals whether the username exists).

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

  let config
  try {
    config = loadKitchenConfig()
  } catch (e) {
    if (e instanceof KitchenConfigError) {
      console.error('kitchen login: server config error —', e.message) // message never contains values
      return json({ error: 'server_config' }, 500)
    }
    throw e
  }

  const user = authenticate(config.users, username, password)
  if (!user) {
    await failDelay()
    return json({ error: 'unauthorized' }, 401)
  }

  const token = signSession(user, config.secret)
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookieHeader(token, shouldUseSecureCookie(req.url)) })
}
