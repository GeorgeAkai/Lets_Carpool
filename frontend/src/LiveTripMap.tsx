import { useEffect, useRef, useState } from "react"
import { fetchRoute, loadGoogleMaps } from "./lib/googleMaps"

type Point = { lat: number; lng: number }

export interface LiveTripMapProps {
  /** The driver's latest shared position; null until they start sharing. */
  driver: Point | null
  pickup: Point & { label?: string }
  destination: Point & { label?: string }
  /** "approach": driver heading to the pickup. "enroute": passenger on board, heading to the destination. */
  phase: "approach" | "enroute"
  className?: string
}

// Redraw the route only when the car has moved this far or this long has
// passed, so a 5 s position poll doesn't turn into a 5 s Directions call.
const ROUTE_REFRESH_METERS = 60
const ROUTE_REFRESH_MS = 20_000
const GLIDE_MS = 4_500

function metersBetween(a: Point, b: Point): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function fmtEta(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60))
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// Top-down car, nose pointing up, drawn in a 24x40 box. The two window
// cut-outs wind the opposite way so they show the map through the body.
const CAR_PATH = "M12 1C18 1 21 5 21 10L21 31C21 36 18 39 12 39C6 39 3 36 3 31L3 10C3 5 6 1 12 1ZM7 12L8 17L16 17L17 12ZM8 28L9 32L15 32L16 28Z"

function bearing(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat))
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function carIcon(maps: typeof google.maps, rotation: number): google.maps.Symbol {
  return {
    path: CAR_PATH, fillColor: "#2563eb", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 1.5,
    scale: 0.9, rotation, anchor: new maps.Point(12, 20),
  }
}

function dot(maps: typeof google.maps, color: string, scale = 8): google.maps.Symbol {
  return { path: maps.SymbolPath.CIRCLE, scale, fillColor: color, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 3 }
}

/**
 * Compact live map for a single accepted ride: a car marker gliding toward the
 * pickup (passenger's "car approaching" view), then the route to the destination
 * once the passenger is picked up. Both the passenger and the driver can use it.
 */
export function LiveTripMap({ driver, pickup, destination, phase, className = "" }: LiveTripMapProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const carRef = useRef<google.maps.Marker | null>(null)
  const lineRef = useRef<google.maps.Polyline | null>(null)
  const pinsRef = useRef<google.maps.Marker[]>([])
  const glideRef = useRef<number | null>(null)
  const lastRouteRef = useRef<{ at: number; from: Point; phase: string } | null>(null)
  const [ready, setReady] = useState<"loading" | "ok" | "unavailable">("loading")
  const [eta, setEta] = useState<{ seconds: number; meters: number } | null>(null)

  // Create the map once.
  useEffect(() => {
    let cancelled = false
    loadGoogleMaps().then(maps => {
      if (cancelled) return
      if (!maps || !elRef.current) { setReady("unavailable"); return }
      mapRef.current = new maps.Map(elRef.current, {
        center: pickup, zoom: 14, disableDefaultUI: true, zoomControl: true, clickableIcons: false,
        gestureHandling: "cooperative",
      })
      setReady("ok")
    })
    return () => {
      cancelled = true
      if (glideRef.current) cancelAnimationFrame(glideRef.current)
      carRef.current?.setMap(null)
      lineRef.current?.setMap(null)
      pinsRef.current.forEach(m => m.setMap(null))
      carRef.current = null; lineRef.current = null; pinsRef.current = []; mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pickup / destination pins.
  useEffect(() => {
    const map = mapRef.current
    if (ready !== "ok" || !map) return
    const maps = google.maps
    pinsRef.current.forEach(m => m.setMap(null))
    pinsRef.current = [
      new maps.Marker({ map, position: pickup, title: pickup.label ?? "Pickup", icon: dot(maps, "#22c55e"), zIndex: 1 }),
      new maps.Marker({ map, position: destination, title: destination.label ?? "Destination", icon: dot(maps, "#ef4444"), zIndex: 1 }),
    ]
  }, [ready, pickup.lat, pickup.lng, destination.lat, destination.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  // The car glides to each new position rather than jumping.
  useEffect(() => {
    const map = mapRef.current
    if (ready !== "ok" || !map || !driver) return
    const maps = google.maps
    if (!carRef.current) {
      carRef.current = new maps.Marker({
        map, position: driver, title: "Driver", zIndex: 10,
        icon: carIcon(maps, 0),
      })
      return
    }
    const car = carRef.current
    const from = car.getPosition()
    if (!from) { car.setPosition(driver); return }
    const start = performance.now()
    const a = { lat: from.lat(), lng: from.lng() }
    // Turn the car to face the way it's moving (ignore GPS jitter under ~5 m).
    if (metersBetween(a, driver) > 5) car.setIcon(carIcon(maps, bearing(a, driver)))
    if (glideRef.current) cancelAnimationFrame(glideRef.current)
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS)
      car.setPosition({ lat: a.lat + (driver.lat - a.lat) * t, lng: a.lng + (driver.lng - a.lng) * t })
      if (t < 1) glideRef.current = requestAnimationFrame(step)
    }
    glideRef.current = requestAnimationFrame(step)
  }, [ready, driver?.lat, driver?.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  // Route: driver → pickup while approaching, pickup/driver → destination once on board.
  useEffect(() => {
    const map = mapRef.current
    if (ready !== "ok" || !map) return
    const origin: Point | null = phase === "enroute" ? (driver ?? pickup) : driver
    const target = phase === "enroute" ? destination : pickup
    if (!origin) {
      map.setCenter(pickup)
      return
    }
    const last = lastRouteRef.current
    if (last && last.phase === phase && Date.now() - last.at < ROUTE_REFRESH_MS && metersBetween(last.from, origin) < ROUTE_REFRESH_METERS) return
    lastRouteRef.current = { at: Date.now(), from: origin, phase }
    let cancelled = false
    fetchRoute(origin.lat, origin.lng, target.lat, target.lng).then(route => {
      if (cancelled || !route) return
      const path = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
      if (!lineRef.current) {
        lineRef.current = new google.maps.Polyline({ map, strokeColor: "#2563eb", strokeOpacity: 0.9, strokeWeight: 5 })
      }
      lineRef.current.setPath(path)
      setEta({ seconds: route.durationSeconds, meters: route.distanceMeters })
      const bounds = new google.maps.LatLngBounds()
      path.forEach(p => bounds.extend(p))
      map.fitBounds(bounds, 56)
    })
    return () => { cancelled = true }
  }, [ready, phase, driver?.lat, driver?.lng, pickup.lat, pickup.lng, destination.lat, destination.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  if (ready === "unavailable") {
    return (
      <div role="status" className={`rounded-[20px] border border-border bg-muted text-sm text-muted-foreground flex items-center justify-center text-center p-6 ${className}`}>
        The live map isn't available right now — you'll still get updates here as your {phase === "enroute" ? "ride progresses" : "driver approaches"}.
      </div>
    )
  }

  return (
    <div className={`relative overflow-hidden rounded-[20px] border border-border bg-muted ${className}`}>
      <div ref={elRef} role="img" aria-label={phase === "enroute" ? "Map of your route to the destination" : "Map of your driver approaching the pickup"} className="h-64 w-full" />
      {ready === "loading" && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground animate-pulse">Loading map…</p>}
      {ready === "ok" && (
        <div className="absolute left-3 bottom-3 rounded-full bg-card/95 border border-border px-3 py-1.5 text-xs font-semibold shadow">
          {phase === "enroute" ? "Heading to destination" : driver ? "Driver approaching" : "Waiting for your driver to start sharing"}
          {eta && (driver || phase === "enroute") && ` · ${fmtEta(eta.seconds)} · ${(eta.meters / 1000).toFixed(1)} km`}
        </div>
      )}
    </div>
  )
}
