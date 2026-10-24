'use client'

// /order/payment/[token] — customer payment status after the Hyp payment page (HYP-08).
// Read-only: only GET /api/payments/intents/[token] (no-store). A refresh or a revisit never starts a payment.
// Bounded polling (lib/hyp/hypStatusUi nextPollDelayMs), cancelled on navigation; an aborted request is ignored.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { HYP_PENDING_PAYMENT_KEY } from '@/lib/hyp/hypCheckoutUi'
import { STATE_VIEW, nextPollDelayMs, parsePublicStatus, trackingSessionFor, type HypPublicStatus } from '@/lib/hyp/hypStatusUi'
import { PaymentStatusView, type PaymentStatusViewProps } from '../PaymentStatusView'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PILOT_BRANCH_ID = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'   // lib/hyp/hypFlags HYP_ALLOWED_BRANCH_IDS

export default function PaymentStatusPage() {
  const params = useParams<{ token: string }>()
  const router = useRouter()
  const token = typeof params?.token === 'string' ? params.token.toLowerCase() : ''
  const [status, setStatus] = useState<HypPublicStatus | null>(null)
  const [phase, setPhase] = useState<PaymentStatusViewProps['phase']>(UUID_RE.test(token) ? 'loading' : 'not_found')
  const [run, setRun] = useState(0)   // bump to restart a stopped poll
  const startedAt = useRef(0)

  useEffect(() => {
    if (!UUID_RE.test(token)) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const controller = new AbortController()
    startedAt.current = Date.now()

    const tick = async () => {
      let parsed: HypPublicStatus | null = null
      try {
        const res = await fetch(`/api/payments/intents/${encodeURIComponent(token)}`, { cache: 'no-store', signal: controller.signal })
        if (cancelled) return
        if (res.status === 404 || res.status === 400) { setPhase('not_found'); return }
        if (res.ok) parsed = parsePublicStatus(await res.json().catch(() => null))
      } catch {
        if (cancelled) return
      }
      if (cancelled) return
      if (parsed) {
        setStatus(parsed); setPhase('ready')
        if (STATE_VIEW[parsed.state].terminal) {
          try { localStorage.removeItem(HYP_PENDING_PAYMENT_KEY) } catch { /* storage unavailable */ }
        }
      } else {
        setPhase(p => (p === 'ready' ? 'ready' : 'error'))   // keep showing the last known state on a transient error
      }
      const delay = nextPollDelayMs(parsed?.state ?? null, Date.now() - startedAt.current)
      if (delay === null) {
        if (!parsed || !STATE_VIEW[parsed.state].terminal) setPhase('stopped')   // time limit: offer a manual re-check
        return
      }
      timer = setTimeout(tick, delay)
    }
    tick()
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer) }
  }, [token, run])

  const onTrack = useCallback(() => {
    if (!status?.order) return
    try { localStorage.setItem('falafel_session', JSON.stringify(trackingSessionFor(status.order, PILOT_BRANCH_ID, Date.now()))) } catch { /* ignore */ }
    router.push('/order')
  }, [status, router])

  return <PaymentStatusView status={status} phase={phase} onTrack={onTrack} onRefresh={() => { setPhase('loading'); setRun(r => r + 1) }} />
}
