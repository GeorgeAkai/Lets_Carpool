import { useEffect, useRef, useState, useCallback } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import * as api from "./api"
import type { NearbyDriver, RouteSuggestion } from "./api"
import { MapPin, Navigation, Clock, Ruler, DollarSign, X } from "lucide-react"

// Fix Leaflet default marker icon paths broken by bundlers
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
})

export interface TripRoute {
  pickupLat: number
  pickupLng: number
  pickupLabel: string
  destLat: number
  destLng: number
  destLabel: string
  partnerName: string
  date: string
}

interface OsrmResult {
  distanceMeters: number
  durationSeconds: number
  geometry: GeoJSON.LineString
}

const CAR_EMOJIS: Record<string, string> = {
  suv: "🚙", van: "🚐", minivan: "🚐", truck: "🚚", sedan: "🚗", other: "🚗",
}

// ── Marker motion interpolation (pure, unit-testable) ──────────────────────────
// Smoothly glides a Leaflet marker between successive polled positions instead of
// snapping, the way Uber/Google Maps animate a live driver dot.

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpLatLng(a: [number, number], b: [number, number], t: number): [number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
}

/** Interpolates an angle in degrees along the shortest rotational path (e.g. 350deg -> 10deg goes +20, not -340). */
export function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180
  return (a + diff * t + 360) % 360
}

interface MarkerAnimation {
  from: [number, number]
  to: [number, number]
  fromHeading: number
  toHeading: number
  start: number
  duration: number
}

// Slightly under the driver-list poll interval so a car is always gliding toward
// its latest known position rather than snapping then sitting idle.
const MARKER_ANIM_DURATION_MS = 9200

function makeCarIcon(heading: number | null) {
  const rotate = `transform: rotate(${heading ?? 0}deg);`
  return L.divIcon({
    html: `<div style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;${rotate}">
      <svg width="26" height="26" viewBox="0 0 30 30" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,.4))">
        <path d="M15 2 L25 25 L15 19.5 L5 25 Z" fill="#2848c8" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>`,
    className: "", iconSize: [30, 30], iconAnchor: [15, 15],
  })
}

function makeUserIcon() {
  return L.divIcon({
    html: `<div style="width:14px;height:14px;border-radius:50%;background:#2848c8;border:3px solid #fff;box-shadow:0 0 0 3px #2848c880;animation:userPulse 2s ease-in-out infinite"></div>`,
    className: "", iconSize: [14, 14], iconAnchor: [7, 7],
  })
}

function makePickupIcon() {
  return L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center">
      <div style="width:16px;height:16px;border-radius:50%;background:#22c55e;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45)"></div>
      <div style="width:2px;height:10px;background:#22c55e;margin-top:-1px"></div>
    </div>`,
    className: "", iconSize: [16, 26], iconAnchor: [8, 8],
  })
}

function makeDestIcon() {
  return L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center">
      <div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#ef4444;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45);transform:rotate(-45deg)"></div>
    </div>`,
    className: "", iconSize: [22, 22], iconAnchor: [11, 22],
  })
}

async function fetchOSRMRoute(pickupLat: number, pickupLng: number, destLat: number, destLng: number): Promise<OsrmResult | null> {
  try {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${pickupLng},${pickupLat};${destLng},${destLat}?overview=full&geometries=geojson`,
      { headers: { Accept: "application/json" } },
    )
    const data = await res.json()
    if (data.code === "Ok" && data.routes?.length) {
      return {
        distanceMeters: data.routes[0].legs[0].distance,
        durationSeconds: data.routes[0].legs[0].duration,
        geometry: data.routes[0].geometry,
      }
    }
  } catch { /* fall through to null */ }
  return null
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

const MONO: React.CSSProperties = { fontFamily: "'DM Mono', monospace" }
const SERIF: React.CSSProperties = { fontFamily: "'DM Serif Display', serif" }

interface Props {
  userCoords: { lat: number; lng: number } | null
  currentUserId: string
  tripRoute?: TripRoute | null
  onClearRoute?: () => void
}

export function MapView({ userCoords, currentUserId, tripRoute, onClearRoute }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const markersRef = useRef<Record<string, L.Marker>>({})
  const markerHeadingsRef = useRef<Record<string, number>>({})
  const animsRef = useRef<Record<string, MarkerAnimation>>({})
  const rafIdRef = useRef<number | null>(null)
  const userMarkerRef = useRef<L.Marker | null>(null)
  const routeLayerRef = useRef<L.Layer | null>(null)
  const pickupMarkerRef = useRef<L.Marker | null>(null)
  const destMarkerRef = useRef<L.Marker | null>(null)

  const [drivers, setDrivers] = useState<NearbyDriver[]>([])
  const [selected, setSelected] = useState<NearbyDriver | null>(null)
  const [nearbyRoute, setNearbyRoute] = useState<RouteSuggestion | null>(null)
  const [loadingRoute, setLoadingRoute] = useState(false)
  const [osrmResult, setOsrmResult] = useState<OsrmResult | null>(null)
  const [sharing, setSharing] = useState(false)
  const [watchId, setWatchId] = useState<number | null>(null)

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const center: L.LatLngTuple = userCoords ? [userCoords.lat, userCoords.lng] : [37.7749, -122.4194]
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true }).setView(center, 13)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── User marker ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !userCoords || tripRoute) return
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([userCoords.lat, userCoords.lng])
    } else {
      userMarkerRef.current = L.marker([userCoords.lat, userCoords.lng], { icon: makeUserIcon(), zIndexOffset: 1000 })
        .addTo(map).bindPopup("You are here")
      map.setView([userCoords.lat, userCoords.lng], 13)
    }
  }, [userCoords, tripRoute])

  // ── Trip route mode ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Clear previous trip route artifacts
    if (routeLayerRef.current) { routeLayerRef.current.remove(); routeLayerRef.current = null }
    if (pickupMarkerRef.current) { pickupMarkerRef.current.remove(); pickupMarkerRef.current = null }
    if (destMarkerRef.current) { destMarkerRef.current.remove(); destMarkerRef.current = null }

    if (!tripRoute) {
      setOsrmResult(null)
      return
    }

    // Hide user marker and driver markers when showing a trip route
    userMarkerRef.current?.remove()
    Object.values(markersRef.current).forEach(m => m.remove())

    const { pickupLat, pickupLng, pickupLabel, destLat, destLng, destLabel } = tripRoute

    // Add pickup and destination markers
    pickupMarkerRef.current = L.marker([pickupLat, pickupLng], { icon: makePickupIcon(), zIndexOffset: 900 })
      .addTo(map).bindPopup(`<b>Pickup</b><br>${pickupLabel}`)
    destMarkerRef.current = L.marker([destLat, destLng], { icon: makeDestIcon(), zIndexOffset: 900 })
      .addTo(map).bindPopup(`<b>Destination</b><br>${destLabel}`)

    // Fit to show both markers while route loads
    const bounds = L.latLngBounds([[pickupLat, pickupLng], [destLat, destLng]])
    map.fitBounds(bounds, { padding: [60, 60] })

    setLoadingRoute(true)
    setOsrmResult(null)

    fetchOSRMRoute(pickupLat, pickupLng, destLat, destLng).then(result => {
      if (!mapRef.current) return
      if (result) {
        // Draw the road route
        const geoLayer = L.geoJSON(result.geometry as GeoJSON.GeoJsonObject, {
          style: { color: "#2848c8", weight: 5, opacity: 0.9, lineCap: "round", lineJoin: "round" },
        }).addTo(mapRef.current)
        routeLayerRef.current = geoLayer
        mapRef.current.fitBounds(geoLayer.getBounds(), { padding: [60, 60] })
        setOsrmResult(result)
      } else {
        // Fallback: straight-line dashed route
        const line = L.polyline([[pickupLat, pickupLng], [destLat, destLng]], {
          color: "#2848c8", weight: 4, dashArray: "10 8", opacity: 0.7,
        }).addTo(mapRef.current)
        routeLayerRef.current = line
      }
    }).finally(() => setLoadingRoute(false))
  }, [tripRoute]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore driver markers when trip route is cleared
  useEffect(() => {
    if (!tripRoute && mapRef.current && userCoords) {
      // Re-add user marker
      if (!userMarkerRef.current) {
        userMarkerRef.current = L.marker([userCoords.lat, userCoords.lng], { icon: makeUserIcon(), zIndexOffset: 1000 })
          .addTo(mapRef.current).bindPopup("You are here")
      } else {
        userMarkerRef.current.addTo(mapRef.current)
      }
    }
  }, [tripRoute, userCoords])

  // ── Fetch nearby drivers (only in normal mode) ──────────────────────────────
  const fetchDrivers = useCallback(async () => {
    if (!userCoords || tripRoute) return
    try {
      const nearby = await api.getNearbyDrivers(userCoords.lat, userCoords.lng, 15000)
      setDrivers(nearby)
    } catch { /* ignore */ }
  }, [userCoords, tripRoute])

  useEffect(() => {
    fetchDrivers()
    const id = setInterval(fetchDrivers, 10000)
    return () => clearInterval(id)
  }, [fetchDrivers])

  // ── Animate driver markers toward their latest polled position ─────────────────
  const stepMarkerAnimations = useCallback(() => {
    const now = performance.now()
    let stillActive = false
    for (const uid of Object.keys(animsRef.current)) {
      const marker = markersRef.current[uid]
      const anim = animsRef.current[uid]
      if (!marker || !anim) { delete animsRef.current[uid]; continue }
      const t = Math.min(1, (now - anim.start) / anim.duration)
      const [lat, lng] = lerpLatLng(anim.from, anim.to, t)
      marker.setLatLng([lat, lng])
      const heading = lerpAngle(anim.fromHeading, anim.toHeading, t)
      markerHeadingsRef.current[uid] = heading
      const el = marker.getElement()
      const inner = el?.firstElementChild as HTMLElement | null
      if (inner) inner.style.transform = `rotate(${heading}deg)`
      if (t < 1) stillActive = true
      else delete animsRef.current[uid]
    }
    rafIdRef.current = stillActive ? requestAnimationFrame(stepMarkerAnimations) : null
  }, [])

  useEffect(() => () => {
    if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current)
  }, [])

  // ── Update driver markers ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || tripRoute) return
    const seen = new Set<string>()
    const now = performance.now()
    for (const d of drivers) {
      seen.add(d.user_id)
      const marker = markersRef.current[d.user_id]
      const targetHeading = d.heading ?? markerHeadingsRef.current[d.user_id] ?? 0
      if (marker) {
        const prevAnim = animsRef.current[d.user_id]
        const t = prevAnim ? Math.min(1, (now - prevAnim.start) / prevAnim.duration) : 1
        const currentPos: [number, number] = prevAnim ? lerpLatLng(prevAnim.from, prevAnim.to, t) : (() => { const p = marker.getLatLng(); return [p.lat, p.lng] })()
        const currentHeading = prevAnim ? lerpAngle(prevAnim.fromHeading, prevAnim.toHeading, t) : (markerHeadingsRef.current[d.user_id] ?? targetHeading)
        animsRef.current[d.user_id] = {
          from: currentPos, to: [d.latitude, d.longitude],
          fromHeading: currentHeading, toHeading: targetHeading,
          start: now, duration: MARKER_ANIM_DURATION_MS,
        }
        marker.setPopupContent(`<b>${d.display_name}</b><br>${d.vehicle ?? d.car_type ?? "Driver"}<br>${d.distance_meters}m away`)
      } else {
        markerHeadingsRef.current[d.user_id] = targetHeading
        const m = L.marker([d.latitude, d.longitude], { icon: makeCarIcon(targetHeading) })
          .addTo(map)
          .bindPopup(`<b>${d.display_name}</b><br>${d.vehicle ?? d.car_type ?? "Driver"}<br>${d.distance_meters}m away`)
          .on("click", () => setSelected(d))
        markersRef.current[d.user_id] = m
      }
    }
    for (const uid of Object.keys(markersRef.current)) {
      if (!seen.has(uid)) {
        markersRef.current[uid].remove()
        delete markersRef.current[uid]
        delete animsRef.current[uid]
        delete markerHeadingsRef.current[uid]
      }
    }
    if (rafIdRef.current == null && Object.keys(animsRef.current).length > 0) {
      rafIdRef.current = requestAnimationFrame(stepMarkerAnimations)
    }
  }, [drivers, tripRoute, stepMarkerAnimations])

  // ── Route to selected nearby driver ────────────────────────────────────────
  useEffect(() => {
    if (!selected || !userCoords || !mapRef.current || tripRoute) return
    setLoadingRoute(true)
    setNearbyRoute(null)
    if (routeLayerRef.current) { routeLayerRef.current.remove(); routeLayerRef.current = null }
    api.suggestRoute(userCoords.lat, userCoords.lng, selected.latitude, selected.longitude)
      .then(r => {
        setNearbyRoute(r)
        const line = L.polyline(
          [[userCoords.lat, userCoords.lng], [selected.latitude, selected.longitude]],
          { color: "#2848c8", weight: 3, dashArray: "8 6", opacity: 0.8 },
        ).addTo(mapRef.current!)
        routeLayerRef.current = line
        mapRef.current!.fitBounds(line.getBounds(), { padding: [40, 40] })
      })
      .catch(() => {})
      .finally(() => setLoadingRoute(false))
  }, [selected, userCoords, tripRoute])

  // ── Share my location as a driver ───────────────────────────────────────────
  const toggleSharing = useCallback(() => {
    if (sharing) {
      if (watchId != null) navigator.geolocation.clearWatch(watchId)
      setWatchId(null); setSharing(false); return
    }
    if (!navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      pos => api.updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.heading ?? undefined, pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined).catch(() => {}),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 },
    )
    setWatchId(id); setSharing(true)
  }, [sharing, watchId])

  useEffect(() => () => { if (watchId != null) navigator.geolocation.clearWatch(watchId) }, [watchId])

  // ── Fare estimate from OSRM result ──────────────────────────────────────────
  const fareEstimate = osrmResult
    ? (osrmResult.distanceMeters / 1000 / (28 * 1.60934) * 3.5 / 2 * 100)
    : null

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">
            {tripRoute ? "Trip Route" : "Live Map"}
          </h1>
          <p className="text-muted-foreground mt-1">
            {tripRoute ? `${tripRoute.partnerName} · ${tripRoute.date}` : "See nearby drivers in real time."}
          </p>
        </div>
        {tripRoute ? (
          <button
            onClick={onClearRoute}
            className="flex items-center gap-2 px-4 py-2 rounded-2xl border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="size-4" /> Back to Map
          </button>
        ) : (
          <button
            onClick={toggleSharing}
            className={`px-4 py-2 rounded-2xl text-sm font-semibold transition-colors ${sharing ? "bg-green-600 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
          >
            {sharing ? "📡 Sharing location" : "Share my location"}
          </button>
        )}
      </div>

      {/* Trip route overview card (shown above map when route active) */}
      {tripRoute && (
        <div className="rounded-3xl border border-border bg-card p-5 space-y-4">
          {/* Pickup → destination */}
          <div className="flex items-stretch gap-3">
            <div className="flex flex-col items-center gap-0">
              <div className="size-3 rounded-full bg-green-500 mt-0.5 shrink-0" />
              <div className="w-0.5 flex-1 bg-border my-1" />
              <div className="size-3 rounded-full bg-red-500 mb-0.5 shrink-0" />
            </div>
            <div className="flex flex-col justify-between gap-2 min-w-0">
              <div>
                <p className="text-xs text-muted-foreground font-medium">PICKUP</p>
                <p className="text-sm font-semibold text-foreground truncate">{tripRoute.pickupLabel}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">DESTINATION</p>
                <p className="text-sm font-semibold text-foreground truncate">{tripRoute.destLabel}</p>
              </div>
            </div>
          </div>

          {/* Stats row */}
          {loadingRoute && (
            <p className="text-sm text-muted-foreground animate-pulse text-center">Calculating route…</p>
          )}
          {osrmResult && (
            <div className="grid grid-cols-3 gap-3">
              {[
                { Icon: Clock, label: "Est. time", value: formatDuration(osrmResult.durationSeconds) },
                { Icon: Ruler, label: "Distance", value: formatDistance(osrmResult.distanceMeters) },
                { Icon: DollarSign, label: "Fare / person", value: fareEstimate != null ? `$${(fareEstimate / 100).toFixed(2)}` : "—" },
              ].map(({ Icon, label, value }) => (
                <div key={label} className="bg-muted rounded-2xl p-3 text-center">
                  <Icon className="size-4 text-primary mx-auto mb-1" />
                  <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
                  <p style={MONO} className="text-base font-semibold text-foreground mt-0.5">{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center gap-5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-green-500 inline-block" />Pickup</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-red-500 inline-block" />Destination</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5 bg-primary rounded" />Route</span>
          </div>
        </div>
      )}

      {/* Map container */}
      <div className="relative rounded-3xl overflow-hidden border border-border shadow-lg" style={{ height: tripRoute ? 380 : 420 }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {!tripRoute && (
          <button
            onClick={fetchDrivers}
            className="absolute top-3 right-3 z-[1000] bg-card border border-border rounded-xl px-3 py-1.5 text-xs font-medium shadow hover:bg-muted transition-colors"
          >
            Refresh
          </button>
        )}
        {tripRoute && loadingRoute && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-sm z-[1000]">
            <div className="bg-card rounded-2xl px-5 py-3 shadow-lg text-sm text-muted-foreground animate-pulse flex items-center gap-2">
              <Navigation className="size-4 text-primary animate-spin" />
              Finding best route…
            </div>
          </div>
        )}
      </div>

      {/* Nearby driver selected card (normal mode) */}
      {!tripRoute && selected && (
        <div className="bg-card border border-border rounded-3xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Nearby driver</p>
              <h3 className="text-lg font-semibold">{selected.display_name}</h3>
              <p className="text-sm text-muted-foreground">{selected.vehicle ?? selected.car_type ?? "Unknown vehicle"} · {selected.distance_meters}m away</p>
            </div>
            <button onClick={() => { setSelected(null); routeLayerRef.current?.remove(); routeLayerRef.current = null }} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
          </div>
          {loadingRoute && <p className="text-sm text-muted-foreground animate-pulse">Calculating route…</p>}
          {nearbyRoute && (
            <div className="grid grid-cols-3 gap-3">
              {[["Distance", `${nearbyRoute.distance_km} km`], ["Est. time", `${nearbyRoute.duration_minutes} min`], ["Your fare", `$${(nearbyRoute.fare_suggestion_cents / 100).toFixed(2)}`]].map(([label, value]) => (
                <div key={label} className="bg-muted rounded-2xl p-3 text-center">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p style={MONO} className="text-base font-semibold text-foreground mt-1">{value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Driver list (normal mode) */}
      {!tripRoute && drivers.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{drivers.length} driver{drivers.length !== 1 ? "s" : ""} nearby</p>
          {drivers.map(d => (
            <button key={d.user_id} onClick={() => setSelected(d)} className={`w-full text-left bg-card border rounded-2xl p-4 flex items-center gap-4 hover:shadow-md transition-all ${selected?.user_id === d.user_id ? "border-primary/40 bg-primary/5" : "border-border"}`}>
              <span className="text-2xl">{CAR_EMOJIS[d.car_type ?? ""] ?? "🚗"}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">{d.display_name}</p>
                <p className="text-xs text-muted-foreground">{d.vehicle ?? d.car_type ?? "Driver"}</p>
              </div>
              <span style={MONO} className="text-xs text-muted-foreground shrink-0">{d.distance_meters}m</span>
            </button>
          ))}
        </div>
      )}

      {!tripRoute && drivers.length === 0 && !userCoords && (
        <div className="text-center py-12 text-muted-foreground">
          <MapPin className="size-10 mx-auto mb-3 opacity-20" />
          <p className="font-medium">Location not available</p>
          <p className="text-sm mt-1">Enable location access to see nearby drivers.</p>
        </div>
      )}

      {!tripRoute && drivers.length === 0 && userCoords && (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-4xl mb-3">🚗</p>
          <p className="font-medium">No drivers nearby right now</p>
          <p className="text-sm mt-1">Drivers appear when they share their location.</p>
        </div>
      )}

      <style>{`
        @keyframes userPulse { 0%,100%{box-shadow:0 0 0 3px #2848c880} 50%{box-shadow:0 0 0 6px #2848c840} }
      `}</style>
    </div>
  )
}
