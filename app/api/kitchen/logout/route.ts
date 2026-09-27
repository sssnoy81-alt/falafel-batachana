import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson, clearSessionCookieHeader, shouldUseSecureCookie } from '@/lib/kitchenAuth'

// POST /api/kitchen/logout — clears the kitchen session cookie. No DB access.
// Same-origin JSON required (the client sends an empty JSON body `{}`).

export async function POST(req: NextRequest) {
  if (!checkSameOriginJson(req))
    return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

  return NextResponse.json({ success: true }, {
    headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookieHeader(shouldUseSecureCookie(req.url)) },
  })
}
