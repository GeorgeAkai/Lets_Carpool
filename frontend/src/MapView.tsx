import { useEffect, useRef, useState, useCallback } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import * as api from "./api"
import type { NearbyDriver, RouteSuggestion } from "./api"

// Fix Leaflet default marker icon paths broken by bundlers
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
})

const CAR_EMOJIS: Record<string, string> = {
  suv: "🚙",
  van: "🚐",
  minivan: "🚐",
  truck: "🚚",
  sedan: "🚗",
  other: "🚗",
}

function makeCarIcon(carType: string | null, heading: number | null) {
  const emoji = CAR_EMOJIS[carType ?? ""] ?? "🚗"
  const rotate = heading != null ? `transform: rotate(${heading}deg);` : ""
  return L.divIcon({
    html: `<div style="font-size:28px;line-height:1;${rotate};filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));animation:carPulse 2s ease-in-out infinite">${emoji}</div>`,
    className: "",
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  })
}

function makeUserIcon() {
  return L.divIcon({
    html: `<div style="width:14px;height:14px;border-radius:50%;background:#6366f1;border:3px solid #fff;box-shadow:0 0 0 3px #6366f180;animation:userPulse 2s ease-in-out infinite"></div>`,
    className: "",
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  })
}

const MONO: React.CSSProperties = { fontFamily: "'DM Mono', monospace" }
const SERIF: React.CSSProperties = { fontFamily: "'DM Serif Display', serif" }

interface Props {
  userCoords: { lat: number; lng: number } | null
  currentUserId: string
}

export function MapView({ userCoords, currentUserId }: Props) {
  const mapRef = useRef<L.Map | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const markersRef = useRef<Record<string, L.Marker>>({})
  const userMarkerRef = useRef<L.Marker | null>(null)
  const routeLayerRef = useRef<L.Polyline | null>(null)

  const [drivers, setDrivers] = useState<NearbyDriver[]>([])
  const [selected, setSelected] = useState<NearbyDriver | null>(null)
  const [route, setRoute] = useState<RouteSuggestion | null>(null)
  const [loadingRoute, setLoadingRoute] = useState(false)
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
    if (!map || !userCoords) return
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([userCoords.lat, userCoords.lng])
    } else {
      userMarkerRef.current = L.marker([userCoords.lat, userCoords.lng], { icon: makeUserIcon(), zIndexOffset: 1000 })
        .addTo(map)
        .bindPopup("You are here")
      map.setView([userCoords.lat, userCoords.lng], 13)
    }
  }, [userCoords])

  // ── Fetch nearby drivers ────────────────────────────────────────────────────
  const fetchDrivers = useCallback(async () => {
    if (!userCoords) return
    try {
      const nearby = await api.getNearbyDrivers(userCoords.lat, userCoords.lng, 15000)
      setDrivers(nearby)
    } catch { /* ignore */ }
  }, [userCoords])

  useEffect(() => {
    fetchDrivers()
    const id = setInterval(fetchDrivers, 10000)
    return () => clearInterval(id)
  }, [fetchDrivers])

  // ── Update driver markers ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const seen = new Set<string>()
    for (const d of drivers) {
      seen.add(d.user_id)
      const marker = markersRef.current[d.user_id]
      const icon = makeCarIcon(d.car_type, d.heading)
      if (marker) {
        marker.setLatLng([d.latitude, d.longitude])
        marker.setIcon(icon)
      } else {
        const m = L.marker([d.latitude, d.longitude], { icon })
          .addTo(map)
          .bindPopup(`<b>${d.display_name}</b><br>${d.vehicle ?? d.car_type ?? "Driver"}<br>${d.distance_meters}m away`)
          .on("click", () => setSelected(d))
        markersRef.current[d.user_id] = m
      }
    }
    // Remove stale markers
    for (const uid of Object.keys(markersRef.current)) {
      if (!seen.has(uid)) {
        markersRef.current[uid].remove()
        delete markersRef.current[uid]
      }
    }
  }, [drivers])

  // ── Route to selected driver ────────────────────────────────────────────────
  useEffect(() => {
    if (!selected || !userCoords || !mapRef.current) return
    setLoadingRoute(true)
    setRoute(null)
    if (routeLayerRef.current) { routeLayerRef.current.remove(); routeLayerRef.current = null }
    api.suggestRoute(userCoords.lat, userCoords.lng, selected.latitude, selected.longitude)
      .then(r => {
        setRoute(r)
        // Draw straight-line route (no OSRM needed)
        const line = L.polyline(
          [[userCoords.lat, userCoords.lng], [selected.latitude, selected.longitude]],
          { color: "#6366f1", weight: 3, dashArray: "8 6", opacity: 0.8 },
        ).addTo(mapRef.current!)
        routeLayerRef.current = line
        mapRef.current!.fitBounds(line.getBounds(), { padding: [40, 40] })
      })
      .catch(() => {})
      .finally(() => setLoadingRoute(false))
  }, [selected, userCoords])

  // ── Share my location as a driver ───────────────────────────────────────────
  const toggleSharing = useCallback(() => {
    if (sharing) {
      if (watchId != null) navigator.geolocation.clearWatch(watchId)
      setWatchId(null)
      setSharing(false)
      return
    }
    if (!navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      pos => {
        api.updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.heading ?? undefined, pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined)
          .catch(() => {})
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 },
    )
    setWatchId(id)
    setSharing(true)
  }, [sharing, watchId])

  useEffect(() => () => { if (watchId != null) navigator.geolocation.clearWatch(watchId) }, [watchId])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Live Map</h1>
          <p className="text-muted-foreground mt-1">See nearby drivers in real time.</p>
        </div>
        <button
          onClick={toggleSharing}
          className={`px-4 py-2 rounded-2xl text-sm font-semibold transition-colors ${sharing ? "bg-green-600 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
        >
          {sharing ? "📡 Sharing location" : "Share my location"}
        </button>
      </div>

      {/* Map container */}
      <div className="relative rounded-3xl overflow-hidden border border-border shadow-lg" style={{ height: 420 }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {/* Refresh overlay */}
        <button
          onClick={fetchDrivers}
          className="absolute top-3 right-3 z-[1000] bg-card border border-border rounded-xl px-3 py-1.5 text-xs font-medium shadow hover:bg-muted transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Selected driver card */}
      {selected && (
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
          {route && (
            <div className="grid grid-cols-3 gap-3">
              {[
                ["Distance", `${route.distance_km} km`],
                ["Est. time", `${route.duration_minutes} min`],
                ["Your fare", `$${(route.fare_suggestion_cents / 100).toFixed(2)}`],
              ].map(([label, value]) => (
                <div key={label} className="bg-muted rounded-2xl p-3 text-center">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p style={MONO} className="text-base font-semibold text-foreground mt-1">{value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Driver list */}
      {drivers.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{drivers.length} driver{drivers.length !== 1 ? "s" : ""} nearby</p>
          {drivers.map(d => (
            <button
              key={d.user_id}
              onClick={() => setSelected(d)}
              className={`w-full text-left bg-card border rounded-2xl p-4 flex items-center gap-4 hover:shadow-md transition-all ${selected?.user_id === d.user_id ? "border-primary/40 bg-primary/5" : "border-border"}`}
            >
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

      {drivers.length === 0 && !userCoords && (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-4xl mb-3">📍</p>
          <p className="font-medium">Location not available</p>
          <p className="text-sm mt-1">Enable location access to see nearby drivers.</p>
        </div>
      )}

      {drivers.length === 0 && userCoords && (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-4xl mb-3">🚗</p>
          <p className="font-medium">No drivers nearby right now</p>
          <p className="text-sm mt-1">Drivers appear when they share their location.</p>
        </div>
      )}

      <style>{`
        @keyframes carPulse { 0%,100%{transform:scale(1) rotate(var(--r,0deg))} 50%{transform:scale(1.12) rotate(var(--r,0deg))} }
        @keyframes userPulse { 0%,100%{box-shadow:0 0 0 3px #6366f180} 50%{box-shadow:0 0 0 6px #6366f140} }
      `}</style>
    </div>
  )
}
