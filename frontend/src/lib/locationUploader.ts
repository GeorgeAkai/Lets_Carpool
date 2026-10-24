import { metersBetween } from './geo'

export interface Fix { lat: number; lng: number; heading?: number; speedKmh?: number }

const MIN_INTERVAL_MS = 2500
const MIN_MOVE_METERS = 5
const HEARTBEAT_MS = 15_000

/**
 * Throttles the driver's GPS stream into the backend. GPS can fire every second;
 * uploading each one piles up requests (slow on serverless) and arrive out of
 * order. This sends at most one update per interval, skips tiny moves, never
 * runs two requests at once, and always sends the newest fix rather than a
 * backlog of stale ones.
 */
export function createLocationUploader(
  send: (f: Fix) => Promise<unknown>,
  now: () => number = () => Date.now(),
) {
  let lastSent: { f: Fix; at: number } | null = null
  let inFlight = false
  let pending: Fix | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    if (inFlight || !pending) return
    const f = pending
    pending = null
    inFlight = true
    lastSent = { f, at: now() }
    send(f).catch(() => {}).finally(() => {
      inFlight = false
      if (pending) schedule()
    })
  }

  const schedule = () => {
    if (timer) return
    const wait = lastSent ? Math.max(0, MIN_INTERVAL_MS - (now() - lastSent.at)) : 0
    if (wait === 0 && !inFlight) flush()
    else timer = setTimeout(flush, wait || 50)
  }

  return {
    push(f: Fix) {
      if (lastSent) {
        const moved = metersBetween(lastSent.f, f)
        if (moved < MIN_MOVE_METERS && now() - lastSent.at < HEARTBEAT_MS) return
      }
      pending = f // latest wins
      schedule()
    },
    stop() { if (timer) clearTimeout(timer); timer = null; pending = null },
  }
}
