export type LatLng = { lat: number; lng: number }

export function metersBetween(a: LatLng, b: LatLng): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Snap a GPS point onto the nearest spot of a route polyline so the car follows
 * the road instead of drifting through buildings. Points further than `maxMeters`
 * from the route (a detour, wrong turn, stale route) are returned untouched.
 */
export function snapToPath(path: LatLng[], p: LatLng, maxMeters = 35): LatLng {
  if (path.length < 2) return p
  // Local flat projection in metres around p — plenty accurate at this scale.
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((p.lat * Math.PI) / 180)
  const toXY = (q: LatLng) => ({ x: (q.lng - p.lng) * mPerDegLng, y: (q.lat - p.lat) * mPerDegLat })
  let best: { d: number; x: number; y: number } | null = null
  let prev = toXY(path[0])
  for (let i = 1; i < path.length; i++) {
    const cur = toXY(path[i])
    const dx = cur.x - prev.x, dy = cur.y - prev.y
    const len2 = dx * dx + dy * dy
    // Closest point on the segment to the origin (where p sits).
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(prev.x * dx + prev.y * dy) / len2))
    const x = prev.x + t * dx, y = prev.y + t * dy
    const d = Math.hypot(x, y)
    if (!best || d < best.d) best = { d, x, y }
    prev = cur
  }
  if (!best || best.d > maxMeters) return p
  return { lat: p.lat + best.y / mPerDegLat, lng: p.lng + best.x / mPerDegLng }
}
