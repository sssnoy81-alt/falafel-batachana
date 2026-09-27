// SERVER-ONLY ready-push logic (FALAFEL-SN-06D), shared by the kitchen status route and /api/push/send.
// Status and wording always come from the database, never from the caller.
// The core (sendReadyPushWith) takes injectable dependencies so it can be tested without DB / network.

import webpush, { type PushSubscription } from 'web-push'
import { getServerSupabase, ServerConfigError } from './supabaseServer'

export type ReadyPushOutcome = 'sent' | 'not_found' | 'not_ready' | 'no_subscription' | 'expired' | 'failed'
export interface ReadyPushResult { outcome: ReadyPushOutcome; sent: number }

export interface ReadyPushDeps {
  loadOrder(orderId: string): Promise<{ status: string; type: string | null; daily_number: number | null } | null>
  loadSubscriptions(orderId: string): Promise<unknown[]>
  deleteSubscriptions(orderId: string): Promise<void>
  send(subscription: unknown, payload: string): Promise<void>
}

export function buildReadyMessage(type: string | null, dailyNumber: number | null, orderId: string) {
  const num = dailyNumber ? String(dailyNumber).padStart(4, '0') : orderId.slice(-4).toUpperCase()
  if (type === 'delivery') return { title: '🛵 ההזמנה שלך בדרך!', body: `🛵 הזמנה #${num} מוכנה ויוצאת למשלוח` }
  // pickup + legacy NULL type
  return { title: '🔔 ההזמנה שלך מוכנה!', body: `🔔 הזמנה #${num} מוכנה לאיסוף` }
}

/** Core: only sends when the order's DB status is 'ready'. Removes subscriptions the push service reports as gone. */
export async function sendReadyPushWith(deps: ReadyPushDeps, orderId: string): Promise<ReadyPushResult> {
  const order = await deps.loadOrder(orderId)
  if (!order) return { outcome: 'not_found', sent: 0 }
  if (order.status !== 'ready') return { outcome: 'not_ready', sent: 0 }

  const subs = await deps.loadSubscriptions(orderId)
  if (subs.length === 0) return { outcome: 'no_subscription', sent: 0 }

  const payload = JSON.stringify(buildReadyMessage(order.type, order.daily_number, orderId))
  let sent = 0
  let expired = false
  for (const s of subs) {
    try {
      await deps.send(s, payload)
      sent++
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode === 404 || statusCode === 410) expired = true
      else console.error('push: delivery failed', statusCode ?? 'unknown')
    }
  }
  if (expired && sent === 0) {
    await deps.deleteSubscriptions(orderId)
    return { outcome: 'expired', sent: 0 }
  }
  return { outcome: sent > 0 ? 'sent' : 'failed', sent }
}

function configureWebPush() {
  const vapidSubject = process.env.VAPID_EMAIL || process.env.VAPID_SUBJECT || 'mailto:falafel.b001@gmail.com'
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) throw new ServerConfigError('Missing VAPID keys (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)')
  webpush.setVapidDetails(vapidSubject, publicKey, privateKey)
}

/** Real dependencies: server-only Supabase + web-push. Throws ServerConfigError on missing env; other DB errors throw. */
export async function sendReadyPush(orderId: string): Promise<ReadyPushResult> {
  configureWebPush()
  const supabase = getServerSupabase()
  return sendReadyPushWith({
    async loadOrder(id) {
      const { data, error } = await supabase.from('orders').select('status, type, daily_number').eq('id', id).maybeSingle()
      if (error) throw new Error(`push: order lookup failed ${error.code}`)
      return data as { status: string; type: string | null; daily_number: number | null } | null
    },
    async loadSubscriptions(id) {
      const { data, error } = await supabase.from('push_subscriptions').select('subscription').eq('order_id', id).limit(5)
      if (error) throw new Error(`push: subscription lookup failed ${error.code}`)
      return (data ?? []).map(r => r.subscription)
    },
    async deleteSubscriptions(id) {
      const { error } = await supabase.from('push_subscriptions').delete().eq('order_id', id)
      if (error) console.error('push: expired-subscription cleanup failed', error.code)
    },
    async send(subscription, payload) {
      await webpush.sendNotification(subscription as PushSubscription, payload)
    },
  }, orderId)
}
