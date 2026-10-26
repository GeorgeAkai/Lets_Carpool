import { useEffect, useRef, useState, useCallback } from "react"
import * as maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import * as api from "./api"
import type { NearbyDriver, RouteSuggestion } from "./api"
import {
  MapPin, Navigation, X, Car, Search, Crosshair, ChevronUp, ChevronDown,
} from "lucide-react"

// Bundlers don't reliably auto-detect the `new Worker(new URL(...))` call
// inside maplibre-gl's own source (it 404s under Vite's dev optimizer and
// silently drops out of the Rollup production bundle too — tile parsing then
// never happens and the map paints blank). Resolving the worker file
// ourselves via Vite's `?url` import and pointing maplibre-gl at it explicitly
// sidesteps that bundler detection entirely, in both dev and prod.
maplibregl.setWorkerUrl(maplibreWorkerUrl)

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

// A driver's active "go pick up this rider" navigation target — the rider's
// pickup point is autodetected from their (now-revealed, post-acceptance)
// ride request, so the driver never has to type an address in.
export interface DrivingTarget {
  connectionId: string
  pickupLat: number
  pickupLng: number
  pickupLabel: string
  partnerName: string
}

interface OsrmResult {
  distanceMeters: number
  durationSeconds: number
  geometry: GeoJSON.LineString
}

const CAR_EMOJIS: Record<string, string> = {
  suv: "🚙", van: "🚐", minivan: "🚐", truck: "🚚", sedan: "🚗", other: "🚗",
}

// ── Dark vector basemap ─────────────────────────────────────────────────────
// CARTO's hosted Dark Matter GL style: a real vector basemap (rotatable and
// pitchable, unlike flat raster tiles) whose high-contrast street network and
// labels read well under the app's dark, Uber-style map chrome. The map stays
// dark regardless of the app's light/dark theme, since every overlay on it is
// styled for a dark canvas. Vite only exposes VITE_-prefixed vars to the
// client, which is expected for a browser map key restricted by domain.
const CARTO_API_KEY = import.meta.env.VITE_CARTO_API_KEY as string | undefined
const CARTO_KEY_PARAM = CARTO_API_KEY ? `?key=${CARTO_API_KEY}` : ""
const STYLE_URL = `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json${CARTO_KEY_PARAM}`
const ACCENT = "#38bdf8"

// ── Marker motion interpolation (pure, unit-testable) ──────────────────────────
// Smoothly glides a marker between successive polled positions instead of
// snapping, the way Uber/Google Maps animate a live driver dot. Coordinates
// here are plain [lat, lng] tuples — conversion to MapLibre's [lng, lat]
// order happens only at the point of calling a maplibre-gl API.

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

/** Compass bearing in degrees from one lat/lng point to another (0 = north, 90 = east). */
export function bearingDegrees(from: [number, number], to: [number, number]): number {
  const lat1 = (from[0] * Math.PI) / 180
  const lat2 = (to[0] * Math.PI) / 180
  const dLon = ((to[1] - from[1]) * Math.PI) / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Great-circle distance in meters between two lat/lng points (haversine). */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const lat1 = (a[0] * Math.PI) / 180
  const lat2 = (b[0] * Math.PI) / 180
  const dLat = lat2 - lat1
  const dLon = ((b[1] - a[1]) * Math.PI) / 180
  const sinDLat = Math.sin(dLat / 2)
  const sinDLon = Math.sin(dLon / 2)
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** [lat, lng] -> MapLibre's [lng, lat] ordering. */
function toLngLat(p: [number, number]): [number, number] {
  return [p[1], p[0]]
}

function boundsOf(points: [number, number][]): maplibregl.LngLatBoundsLike {
  const lngLats = points.map(toLngLat)
  const lngs = lngLats.map(p => p[0])
  const lats = lngLats.map(p => p[1])
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]]
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

// Synthetic marker id for the driver's own live position while "Start Driving"
// is active, so it can reuse the same lerp/heading animation machinery that
// nearby-driver dots use instead of a parallel implementation.
const DRIVING_SELF_KEY = "__driving_self__"

// Re-fetch the OSRM route to the rider only when the driver has moved enough
// (or enough time has passed) to make a fresh route worth the request — an
// Uber-style nav view doesn't need a new route on every single GPS tick.
const DRIVING_ROUTE_REFRESH_METERS = 40
const DRIVING_ROUTE_REFRESH_MS = 20000

// ── Marker DOM factories ─────────────────────────────────────────────────────
// A top-down SVG car (nose pointing north at 0deg) that rotates to the
// driver's heading, Uber-style, plus a pulsing halo while it's actively
// "en route" toward the selected rider. The rotating wrapper must stay the
// marker element's first child — stepMarkerAnimations() rotates that node.
const CAR_SVG = `<svg viewBox="0 0 24 40" width="22" height="36" aria-hidden="true">
  <rect x="2" y="1.5" width="20" height="37" rx="7" fill="var(--carpool-accent)" stroke="#0b1220" stroke-width="1.5"/>
  <path d="M5.5 10.5 Q12 7 18.5 10.5 L17.5 15 Q12 13.5 6.5 15 Z" fill="#0b1220" opacity=".85"/>
  <path d="M6.5 29 Q12 30.5 17.5 29 L18.5 33 Q12 35.5 5.5 33 Z" fill="#0b1220" opacity=".7"/>
  <rect x="6.5" y="16.5" width="11" height="11" rx="2.5" fill="#ffffff" opacity=".22"/>
  <rect x="3.5" y="3" width="4" height="2.2" rx="1" fill="#fef9c3"/>
  <rect x="16.5" y="3" width="4" height="2.2" rx="1" fill="#fef9c3"/>
</svg>`

function makeCarEl(heading: number | null, opts: { tracking?: boolean; accent?: string } = {}): HTMLDivElement {
  const el = document.createElement("div")
  const rotate = heading ?? 0
  el.className = `carpool-car-icon${opts.tracking ? " tracking" : ""}`
  el.style.setProperty("--carpool-accent", opts.accent ?? ACCENT)
  el.innerHTML = `<div class="carpool-car-body" style="transform:rotate(${rotate}deg)">${CAR_SVG}</div>`
  return el
}

function makeUserEl(accent: string = ACCENT): HTMLDivElement {
  const el = document.createElement("div")
  el.innerHTML = `<div style="width:14px;height:14px;border-radius:50%;background:${accent};border:3px solid #fff;box-shadow:0 0 0 3px ${accent}80;animation:userPulse 2s ease-in-out infinite"></div>`
  return el.firstElementChild as HTMLDivElement
}

function makePickupEl(): HTMLDivElement {
  const el = document.createElement("div")
  el.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center">
    <div style="width:16px;height:16px;border-radius:50%;background:#22c55e;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45)"></div>
    <div style="width:2px;height:10px;background:#22c55e;margin-top:-1px"></div>
  </div>`
  return el.firstElementChild as HTMLDivElement
}

function makeDestEl(): HTMLDivElement {
  const el = document.createElement("div")
  el.innerHTML = `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#ef4444;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45);transform:rotate(-45deg)"></div>`
  return el.firstElementChild as HTMLDivElement
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

const MONO: React.CSSProperties = { fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontVariantNumeric: 'tabular-nums' }

// ── Lightweight "Where to?" search (Nominatim) ──────────────────────────────
interface NominatimResult {
  place_id: number
  display_name: string
  name: string
  lat: string
  lon: string
}

interface Props {
  userCoords: { lat: number; lng: number } | null
  currentUserId: string
  userMode: "driver" | "rider"
  tripRoute?: TripRoute | null
  onClearRoute?: () => void
  drivingTo?: DrivingTarget | null
  onStopDriving?: () => void
}

export function MapView({ userCoords, userMode, tripRoute, onClearRoute, drivingTo, onStopDriving }: Props) {
  const accentColor = ACCENT

  const mapRef = useRef<maplibregl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapReadyRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  const markersRef = useRef<Record<string, maplibregl.Marker>>({})
  const markerHeadingsRef = useRef<Record<string, number>>({})
  const animsRef = useRef<Record<string, MarkerAnimation>>({})
  const rafIdRef = useRef<number | null>(null)
  const userMarkerRef = useRef<maplibregl.Marker | null>(null)
  const pickupMarkerRef = useRef<maplibregl.Marker | null>(null)
  const destMarkerRef = useRef<maplibregl.Marker | null>(null)
  const searchMarkerRef = useRef<maplibregl.Marker | null>(null)

  const [drivers, setDrivers] = useState<NearbyDriver[]>([])
  const [selected, setSelected] = useState<NearbyDriver | null>(null)
  const [nearbyRoute, setNearbyRoute] = useState<RouteSuggestion | null>(null)
  const [loadingRoute, setLoadingRoute] = useState(false)
  const [osrmResult, setOsrmResult] = useState<OsrmResult | null>(null)
  const [sharing, setSharing] = useState(false)
  const [watchId, setWatchId] = useState<number | null>(null)

  // ── "Start Driving" navigation-to-rider mode ────────────────────────────────
  const drivingPickupMarkerRef = useRef<maplibregl.Marker | null>(null)
  const drivingLastRouteFetchRef = useRef<{ pos: [number, number]; time: number } | null>(null)
  const drivingFitOnceRef = useRef(false)
  const [drivingSample, setDrivingSample] = useState<{ pos: [number, number]; heading: number } | null>(null)
  const [drivingRoute, setDrivingRoute] = useState<OsrmResult | null>(null)
  const [drivingLoadingRoute, setDrivingLoadingRoute] = useState(false)
  const [drivingGeoError, setDrivingGeoError] = useState(false)

  // ── Mobile immersive chrome ──────────────────────────────────────────────────
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [searchText, setSearchText] = useState("")
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([])
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Bottom sheet drag gesture ───────────────────────────────────────────────
  // Tracks the sheet's live height in px while a pointer drag is in progress
  // (null when settled, letting the CSS max-height transition take back over).
  // A drag that never moves past a small threshold is treated as a tap, so the
  // existing "tap the handle to expand/collapse" behavior still works.
  const [sheetDragPx, setSheetDragPx] = useState<number | null>(null)
  const dragStateRef = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null)

  const sheetHeightBounds = useCallback(() => ({
    collapsed: 220,
    expanded: typeof window !== "undefined" ? window.innerHeight * 0.7 : 600,
  }), [])

  const onSheetHandlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const { collapsed, expanded } = sheetHeightBounds()
    dragStateRef.current = { startY: e.clientY, startHeight: sheetExpanded ? expanded : collapsed, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [sheetExpanded, sheetHeightBounds])

  const onSheetHandlePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragStateRef.current
    if (!drag) return
    const deltaY = e.clientY - drag.startY
    if (Math.abs(deltaY) > 4) drag.moved = true
    const { collapsed, expanded } = sheetHeightBounds()
    setSheetDragPx(Math.min(expanded, Math.max(collapsed, drag.startHeight - deltaY)))
  }, [sheetHeightBounds])

  const onSheetHandlePointerUp = useCallback(() => {
    const drag = dragStateRef.current
    dragStateRef.current = null
    if (!drag) return
    if (!drag.moved) {
      setSheetExpanded(v => !v)
    } else {
      const { collapsed, expanded } = sheetHeightBounds()
      setSheetDragPx(current => {
        const settled = current ?? drag.startHeight
        setSheetExpanded(settled > (collapsed + expanded) / 2)
        return null
      })
      return
    }
    setSheetDragPx(null)
  }, [sheetHeightBounds])

  const mode: "browse" | "trip" | "driving" = drivingTo ? "driving" : tripRoute ? "trip" : "browse"

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const center: [number, number] = userCoords ? [userCoords.lng, userCoords.lat] : [-122.4194, 37.7749]
    // No +/- zoom buttons: pinch/scroll zoom, drag pan and two-finger
    // pitch/rotate are all on by default. The OSM/CARTO credit is legally
    // required, so it stays — but only as a collapsed "i" button, not a bar.
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center, zoom: 14, pitch: 45,
      attributionControl: false,
    })
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-left")
    map.on("load", () => {
      mapReadyRef.current = true; setMapReady(true)
      containerRef.current?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show")
    })
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; mapReadyRef.current = false; setMapReady(false) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Shared route line source/layer (used by trip-route + driving modes) ────
  const ensureRouteLayer = useCallback((map: maplibregl.Map) => {
    if (map.getSource("carpool-route")) return
    map.addSource("carpool-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
    map.addLayer({
      id: "carpool-route-line", type: "line", source: "carpool-route",
      paint: { "line-color": accentColor, "line-width": 5, "line-opacity": 0.9 },
      layout: { "line-cap": "round", "line-join": "round" },
    })
  }, [accentColor])

  const setRouteLine = useCallback((geometry: GeoJSON.LineString | null, dashed = false) => {
    const map = mapRef.current
    if (!map) return
    ensureRouteLayer(map)
    const src = map.getSource("carpool-route") as maplibregl.GeoJSONSource | undefined
    src?.setData(geometry ? { type: "Feature", properties: {}, geometry } : { type: "FeatureCollection", features: [] })
    if (map.getLayer("carpool-route-line")) {
      map.setPaintProperty("carpool-route-line", "line-dasharray", dashed ? [2, 2] : [1, 0])
      map.setPaintProperty("carpool-route-line", "line-color", accentColor)
    }
  }, [ensureRouteLayer, accentColor])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const setup = () => ensureRouteLayer(map)
    if (mapReady) setup()
    map.on("styledata", setup)
    return () => { map.off("styledata", setup) }
  }, [mapReady, ensureRouteLayer])

  // ── User marker (browse mode only) ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !userCoords || mode !== "browse") return
    if (userMarkerRef.current) {
      userMarkerRef.current.setLngLat(toLngLat([userCoords.lat, userCoords.lng]))
    } else {
      userMarkerRef.current = new maplibregl.Marker({ element: makeUserEl(accentColor) })
        .setLngLat(toLngLat([userCoords.lat, userCoords.lng]))
        .addTo(map)
      map.flyTo({ center: toLngLat([userCoords.lat, userCoords.lng]), zoom: 14 })
    }
  }, [userCoords, mode, accentColor, mapReady])

  useEffect(() => {
    if (mode !== "browse") { userMarkerRef.current?.remove(); userMarkerRef.current = null }
  }, [mode])

  // ── Trip route mode ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    pickupMarkerRef.current?.remove(); pickupMarkerRef.current = null
    destMarkerRef.current?.remove(); destMarkerRef.current = null

    if (mode !== "trip" || !tripRoute) {
      if (mode !== "trip") { setRouteLine(null); setOsrmResult(null) }
      return
    }

    const { pickupLat, pickupLng, pickupLabel, destLat, destLng, destLabel } = tripRoute

    pickupMarkerRef.current = new maplibregl.Marker({ element: makePickupEl() })
      .setLngLat(toLngLat([pickupLat, pickupLng]))
      .setPopup(new maplibregl.Popup({ closeButton: false }).setHTML(`<b>Pickup</b><br>${pickupLabel}`))
      .addTo(map)
    destMarkerRef.current = new maplibregl.Marker({ element: makeDestEl() })
      .setLngLat(toLngLat([destLat, destLng]))
      .setPopup(new maplibregl.Popup({ closeButton: false }).setHTML(`<b>Destination</b><br>${destLabel}`))
      .addTo(map)

    map.fitBounds(boundsOf([[pickupLat, pickupLng], [destLat, destLng]]), { padding: 80 })

    setLoadingRoute(true)
    setOsrmResult(null)
    fetchOSRMRoute(pickupLat, pickupLng, destLat, destLng).then(result => {
      if (!mapRef.current) return
      if (result) {
        setRouteLine(result.geometry, false)
        const coords = result.geometry.coordinates as [number, number][]
        if (coords.length > 0) {
          const lngs = coords.map(c => c[0]); const lats = coords.map(c => c[1])
          mapRef.current.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 80 })
        }
        setOsrmResult(result)
      } else {
        setRouteLine({ type: "LineString", coordinates: [toLngLat([pickupLat, pickupLng]), toLngLat([destLat, destLng])] }, true)
      }
    }).finally(() => setLoadingRoute(false))
  }, [tripRoute, mode, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch nearby drivers (browse mode only) ─────────────────────────────────
  const fetchDrivers = useCallback(async () => {
    if (!userCoords || mode !== "browse") return
    try {
      const nearby = await api.getNearbyDrivers(userCoords.lat, userCoords.lng, 15000)
      setDrivers(nearby)
    } catch { /* ignore */ }
  }, [userCoords, mode])

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
      const pos = lerpLatLng(anim.from, anim.to, t)
      marker.setLngLat(toLngLat(pos))
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

  // ── Update driver markers (browse mode only) ────────────────────────────────
  // The selected driver's heading is overridden to point straight at the rider
  // (Uber-style "driver en route to you"), rather than its raw GPS heading.
  const trackingRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || mode !== "browse") return
    const seen = new Set<string>()
    const now = performance.now()
    for (const d of drivers) {
      seen.add(d.user_id)
      const marker = markersRef.current[d.user_id]
      const tracking = selected?.user_id === d.user_id
      const targetHeading = tracking && userCoords
        ? bearingDegrees([d.latitude, d.longitude], [userCoords.lat, userCoords.lng])
        : (d.heading ?? markerHeadingsRef.current[d.user_id] ?? 0)
      if (marker) {
        const prevAnim = animsRef.current[d.user_id]
        const t = prevAnim ? Math.min(1, (now - prevAnim.start) / prevAnim.duration) : 1
        const currentPos: [number, number] = prevAnim ? lerpLatLng(prevAnim.from, prevAnim.to, t) : (() => { const p = marker.getLngLat(); return [p.lat, p.lng] })()
        const currentHeading = prevAnim ? lerpAngle(prevAnim.fromHeading, prevAnim.toHeading, t) : (markerHeadingsRef.current[d.user_id] ?? targetHeading)
        animsRef.current[d.user_id] = {
          from: currentPos, to: [d.latitude, d.longitude],
          fromHeading: currentHeading, toHeading: targetHeading,
          start: now, duration: MARKER_ANIM_DURATION_MS,
        }
        if (trackingRef.current[d.user_id] !== tracking) {
          trackingRef.current[d.user_id] = tracking
          const newEl = makeCarEl(currentHeading, { tracking, accent: accentColor })
          marker.getElement().replaceWith(newEl)
          marker.setPopup(new maplibregl.Popup({ closeButton: false }).setHTML(`<b>${d.display_name}</b><br>${d.vehicle ?? d.car_type ?? "Driver"}<br>${d.distance_meters}m away`))
        }
      } else {
        trackingRef.current[d.user_id] = tracking
        markerHeadingsRef.current[d.user_id] = targetHeading
        const m = new maplibregl.Marker({ element: makeCarEl(targetHeading, { tracking, accent: accentColor }) })
          .setLngLat(toLngLat([d.latitude, d.longitude]))
          .setPopup(new maplibregl.Popup({ closeButton: false }).setHTML(`<b>${d.display_name}</b><br>${d.vehicle ?? d.car_type ?? "Driver"}<br>${d.distance_meters}m away`))
          .addTo(map)
        m.getElement().addEventListener("click", () => { setSelected(d); setSheetExpanded(true) })
        markersRef.current[d.user_id] = m
      }
    }
    for (const uid of Object.keys(markersRef.current)) {
      if (!seen.has(uid)) {
        markersRef.current[uid].remove()
        delete markersRef.current[uid]
        delete animsRef.current[uid]
        delete markerHeadingsRef.current[uid]
        delete trackingRef.current[uid]
      }
    }
    if (rafIdRef.current == null && Object.keys(animsRef.current).length > 0) {
      rafIdRef.current = requestAnimationFrame(stepMarkerAnimations)
    }
  }, [drivers, mode, stepMarkerAnimations, selected, userCoords, accentColor, mapReady])

  // Clear driver markers when leaving browse mode
  useEffect(() => {
    if (mode === "browse") return
    Object.values(markersRef.current).forEach(m => m.remove())
    markersRef.current = {}; animsRef.current = {}; markerHeadingsRef.current = {}; trackingRef.current = {}
  }, [mode])

  // ── Route to selected nearby driver ────────────────────────────────────────
  useEffect(() => {
    if (!selected || !userCoords || !mapRef.current || mode !== "browse") return
    setLoadingRoute(true)
    setNearbyRoute(null)
    api.suggestRoute(userCoords.lat, userCoords.lng, selected.latitude, selected.longitude)
      .then(r => {
        setNearbyRoute(r)
        setRouteLine({ type: "LineString", coordinates: [toLngLat([userCoords.lat, userCoords.lng]), toLngLat([selected.latitude, selected.longitude])] }, true)
        mapRef.current!.fitBounds(boundsOf([[userCoords.lat, userCoords.lng], [selected.latitude, selected.longitude]]), { padding: 60 })
      })
      .catch(() => {})
      .finally(() => setLoadingRoute(false))
    return () => setRouteLine(null)
  }, [selected, userCoords, mode]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── "Start Driving" mode: watch the driver's own live position ─────────────
  // Autodetects the driver's real GPS position (the rider's pickup point is
  // already known from their accepted ride request, so no address entry is
  // needed on either side) and streams it, Uber-nav style.
  useEffect(() => {
    if (!drivingTo) { setDrivingSample(null); setDrivingGeoError(false); return }
    if (!navigator.geolocation) { setDrivingGeoError(true); return }
    let lastPos: [number, number] | null = null
    const id = navigator.geolocation.watchPosition(
      pos => {
        const next: [number, number] = [pos.coords.latitude, pos.coords.longitude]
        const heading = pos.coords.heading
          ?? (lastPos ? bearingDegrees(lastPos, next) : bearingDegrees(next, [drivingTo.pickupLat, drivingTo.pickupLng]))
        lastPos = next
        setDrivingSample({ pos: next, heading })
        api.updateLocation(next[0], next[1], heading, pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined).catch(() => {})
      },
      () => setDrivingGeoError(true),
      { enableHighAccuracy: true, maximumAge: 5000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [drivingTo])

  // ── "Start Driving" mode: animate the self marker + follow it on the map ───
  // Reuses the same markersRef/animsRef/stepMarkerAnimations machinery that
  // nearby-driver dots use (keyed under a synthetic id) instead of a parallel
  // animation loop.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || mode !== "driving" || !drivingSample) return
    const { pos, heading } = drivingSample
    const now = performance.now()
    const marker = markersRef.current[DRIVING_SELF_KEY]
    if (marker) {
      const prevAnim = animsRef.current[DRIVING_SELF_KEY]
      const t = prevAnim ? Math.min(1, (now - prevAnim.start) / prevAnim.duration) : 1
      const currentPos: [number, number] = prevAnim ? lerpLatLng(prevAnim.from, prevAnim.to, t) : (() => { const p = marker.getLngLat(); return [p.lat, p.lng] })()
      const currentHeading = prevAnim ? lerpAngle(prevAnim.fromHeading, prevAnim.toHeading, t) : (markerHeadingsRef.current[DRIVING_SELF_KEY] ?? heading)
      animsRef.current[DRIVING_SELF_KEY] = {
        from: currentPos, to: pos, fromHeading: currentHeading, toHeading: heading,
        start: now, duration: MARKER_ANIM_DURATION_MS,
      }
    } else {
      markerHeadingsRef.current[DRIVING_SELF_KEY] = heading
      const m = new maplibregl.Marker({ element: makeCarEl(heading, { tracking: true, accent: accentColor }) })
        .setLngLat(toLngLat(pos))
        .setPopup(new maplibregl.Popup({ closeButton: false }).setText("You"))
        .addTo(map)
      markersRef.current[DRIVING_SELF_KEY] = m
      map.flyTo({ center: toLngLat(pos), zoom: 16 })
    }
    if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(stepMarkerAnimations)
    map.panTo(toLngLat(pos), { duration: 800 })
  }, [drivingSample, mode, accentColor, stepMarkerAnimations, mapReady])

  // ── "Start Driving" mode: pickup marker + route to the rider ───────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    if (mode !== "driving" || !drivingTo) {
      drivingPickupMarkerRef.current?.remove(); drivingPickupMarkerRef.current = null
      drivingLastRouteFetchRef.current = null
      drivingFitOnceRef.current = false
      if (mode !== "driving") setDrivingRoute(null)
      return
    }

    if (!drivingPickupMarkerRef.current) {
      drivingPickupMarkerRef.current = new maplibregl.Marker({ element: makePickupEl() })
        .setLngLat(toLngLat([drivingTo.pickupLat, drivingTo.pickupLng]))
        .setPopup(new maplibregl.Popup({ closeButton: false }).setHTML(`<b>${drivingTo.partnerName}</b><br>${drivingTo.pickupLabel}`))
        .addTo(map)
    }

    if (!drivingSample) return
    const last = drivingLastRouteFetchRef.current
    const moved = last ? distanceMeters(last.pos, drivingSample.pos) : Infinity
    const elapsed = last ? performance.now() - last.time : Infinity
    if (moved < DRIVING_ROUTE_REFRESH_METERS && elapsed < DRIVING_ROUTE_REFRESH_MS) return

    drivingLastRouteFetchRef.current = { pos: drivingSample.pos, time: performance.now() }
    setDrivingLoadingRoute(true)
    fetchOSRMRoute(drivingSample.pos[0], drivingSample.pos[1], drivingTo.pickupLat, drivingTo.pickupLng).then(result => {
      if (!mapRef.current || mode !== "driving") return
      if (result) {
        setRouteLine(result.geometry, false)
        setDrivingRoute(result)
      } else {
        setRouteLine({ type: "LineString", coordinates: [toLngLat(drivingSample.pos), toLngLat([drivingTo.pickupLat, drivingTo.pickupLng])] }, true)
        setDrivingRoute(null)
      }
    }).finally(() => setDrivingLoadingRoute(false))
  }, [drivingTo, drivingSample, mode, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // First fix while driving: fit both the driver and the rider on screen.
  useEffect(() => {
    const map = mapRef.current
    if (!map || mode !== "driving" || !drivingTo || !drivingSample || drivingFitOnceRef.current) return
    drivingFitOnceRef.current = true
    map.fitBounds(boundsOf([drivingSample.pos, [drivingTo.pickupLat, drivingTo.pickupLng]]), { padding: 80 })
  }, [mode, drivingTo, drivingSample])

  // Clean up the self marker once driving mode ends.
  useEffect(() => {
    if (mode === "driving") return
    const marker = markersRef.current[DRIVING_SELF_KEY]
    if (marker) {
      marker.remove()
      delete markersRef.current[DRIVING_SELF_KEY]
      delete animsRef.current[DRIVING_SELF_KEY]
      delete markerHeadingsRef.current[DRIVING_SELF_KEY]
    }
  }, [mode])

  // ── "Where to?" search (Nominatim) ──────────────────────────────────────────
  const runSearch = useCallback((q: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!q.trim()) { setSearchResults([]); return }
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`, { headers: { "Accept-Language": "en" } })
        setSearchResults(await res.json())
      } catch { /* ignore */ }
    }, 350)
  }, [])

  const selectSearchResult = useCallback((r: NominatimResult) => {
    const map = mapRef.current
    setSearchText(r.display_name.split(",")[0])
    setSearchResults([])
    const lat = parseFloat(r.lat), lng = parseFloat(r.lon)
    if (!map) return
    searchMarkerRef.current?.remove()
    searchMarkerRef.current = new maplibregl.Marker({ element: makeDestEl() }).setLngLat([lng, lat]).addTo(map)
    map.flyTo({ center: [lng, lat], zoom: 15 })
    setSheetExpanded(false)
  }, [])

  // ── Recenter on the driver's live position ──────────────────────────────────
  const recenter = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    if (mode === "driving" && drivingSample) map.flyTo({ center: toLngLat(drivingSample.pos), zoom: 16 })
    else if (userCoords) map.flyTo({ center: toLngLat([userCoords.lat, userCoords.lng]), zoom: 14 })
  }, [mode, drivingSample, userCoords])

  // ── Fare estimate from OSRM result ──────────────────────────────────────────
  const fareEstimate = osrmResult
    ? (osrmResult.distanceMeters / 1000 / (28 * 1.60934) * 3.5 / 2 * 100)
    : null

  const nearbyCount = drivers.length

  return (
    <div>
      {/* Full-bleed map canvas on every screen size — no card, border or
          rounding. Mobile: fills the viewport above the bottom nav. Desktop:
          fills the content column below the top bar. Everything else floats
          over it. */}
      <div className="fixed inset-x-0 top-0 bottom-16 z-0 xl:relative xl:inset-auto xl:bottom-auto xl:h-[calc(100dvh-6.5rem)] xl:overflow-hidden bg-[#0e1626]">
        <div ref={containerRef} className="absolute inset-0 w-full h-full z-0" />

        {/* ── Floating header ── */}
        <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between gap-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/75 text-white backdrop-blur-md shadow-lg min-w-0">
            {mode === "driving" ? <Car className="size-4 shrink-0" /> : mode === "trip" ? <Navigation className="size-4 shrink-0" /> : <MapPin className="size-4 shrink-0" />}
            <span className="text-sm font-medium truncate">
              {mode === "driving" ? `Heading to ${drivingTo?.partnerName}` : mode === "trip" ? `Trip with ${tripRoute?.partnerName}` : "Live Map"}
            </span>
          </div>
          <div className="pointer-events-auto flex items-center gap-2 shrink-0">
            {(mode === "trip" || mode === "driving") && (
              <button
                onClick={mode === "trip" ? onClearRoute : onStopDriving}
                aria-label={mode === "trip" ? "Close trip route" : "End navigation"}
                className="size-10 rounded-full bg-slate-900/75 text-white backdrop-blur-md shadow-lg flex items-center justify-center hover:bg-slate-900"
              >
                <X className="size-4" />
              </button>
            )}
            <button
              onClick={recenter}
              aria-label="Re-center map"
              title="Re-center"
              className="size-10 rounded-full bg-slate-900/75 text-white backdrop-blur-md shadow-lg flex items-center justify-center hover:bg-slate-900"
            >
              <Crosshair className="size-4" />
            </button>
          </div>
        </div>

        {mode === "trip" && loadingRoute && (
          <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
            <div className="bg-slate-900/85 text-white rounded-2xl px-5 py-3 shadow-lg text-sm animate-pulse flex items-center gap-2 backdrop-blur-md">
              <Navigation className="size-4 animate-spin" /> Finding best route…
            </div>
          </div>
        )}

        {/* ── Bottom sheet drawer (a floating card on desktop) ── */}
        <div
          className={`absolute left-0 right-0 bottom-0 z-10 rounded-t-3xl border-t border-white/10 bg-slate-900/90 text-white backdrop-blur-md shadow-[0_-8px_30px_rgba(0,0,0,.3)] overflow-hidden xl:left-4 xl:right-auto xl:bottom-4 xl:w-[400px] xl:rounded-3xl xl:border ${sheetDragPx == null ? "transition-[max-height] duration-300" : ""} ${sheetExpanded ? "max-h-[70vh]" : "max-h-[220px]"}`}
          style={sheetDragPx != null ? { maxHeight: sheetDragPx } : undefined}
        >
          <button
            onPointerDown={onSheetHandlePointerDown}
            onPointerMove={onSheetHandlePointerMove}
            onPointerUp={onSheetHandlePointerUp}
            onPointerCancel={onSheetHandlePointerUp}
            className="w-full flex flex-col items-center pt-2.5 pb-1 touch-none cursor-grab active:cursor-grabbing"
            aria-label={sheetExpanded ? "Collapse" : "Expand"}
          >
            <span className="block w-9 h-1 rounded-full bg-white/25" />
          </button>

          <div className="px-5 pb-6 space-y-3 overflow-y-auto" style={{ maxHeight: sheetExpanded ? "calc(70vh - 28px)" : undefined }}>
            {mode === "browse" && (
              <>
                <div className="relative">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-white/50" />
                  <input
                    value={searchText}
                    onChange={e => { setSearchText(e.target.value); runSearch(e.target.value) }}
                    onFocus={() => setSheetExpanded(true)}
                    placeholder="Where to?"
                    aria-label="Where to?"
                    className="w-full pl-10 pr-4 py-3 rounded-2xl bg-white/10 text-white placeholder:text-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-white/30"
                  />
                </div>

                {searchResults.length > 0 ? (
                  <ul className="space-y-1">
                    {searchResults.map(r => (
                      <li key={r.place_id}>
                        <button onClick={() => selectSearchResult(r)} className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/10 flex items-start gap-2.5">
                          <MapPin className="size-3.5 text-white/50 shrink-0 mt-0.5" />
                          <span className="text-sm truncate">{r.display_name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <button onClick={() => setSheetExpanded(v => !v)} className="w-full flex items-center justify-between px-1 py-1">
                      <span className="flex items-center gap-2 text-sm text-white/80">
                        <span className="relative flex size-2.5">
                          <span className="absolute inset-0 rounded-full bg-green-400 animate-ping opacity-60" />
                          <span className="relative rounded-full size-2.5 bg-green-400" />
                        </span>
                        {userCoords ? `${nearbyCount} driver${nearbyCount !== 1 ? "s" : ""} nearby` : "Enable location to see nearby drivers"}
                      </span>
                      {sheetExpanded ? <ChevronDown className="size-4 text-white/60" /> : <ChevronUp className="size-4 text-white/60" />}
                    </button>

                    {sheetExpanded && (
                      <div className="space-y-2 pt-2">
                        {userMode === "driver" && (
                          <button
                            onClick={toggleSharing}
                            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${sharing ? "bg-green-500 text-white" : "bg-white text-slate-900"}`}
                          >
                            {sharing ? "📡 Sharing your location" : "Share my location as a driver"}
                          </button>
                        )}
                        {selected && (
                          <div className="rounded-2xl bg-white/10 p-3.5 space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[10px] text-white/50 font-medium uppercase tracking-wide">Selected driver</p>
                                <p className="text-sm font-semibold truncate">{selected.display_name} · {selected.vehicle ?? selected.car_type ?? "Driver"}</p>
                              </div>
                              <button onClick={() => { setSelected(null); setNearbyRoute(null) }} aria-label="Clear selected driver" className="p-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10"><X className="size-4" /></button>
                            </div>
                            {loadingRoute && !nearbyRoute && <p className="text-xs text-white/60 animate-pulse">Calculating route…</p>}
                            {nearbyRoute && (
                              <div className="grid grid-cols-3 gap-2">
                                {[["Distance", `${nearbyRoute.distance_km} km`], ["ETA", `${nearbyRoute.duration_minutes} min`], ["Fare", `$${(nearbyRoute.fare_suggestion_cents / 100).toFixed(2)}`]].map(([label, value]) => (
                                  <div key={label} className="bg-white/10 rounded-xl p-2 text-center">
                                    <p className="text-[10px] text-white/50">{label}</p>
                                    <p style={MONO} className="text-sm font-semibold mt-0.5">{value}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {drivers.map(d => (
                          <button key={d.user_id} onClick={() => setSelected(d)} className={`w-full text-left rounded-2xl p-3.5 flex items-center gap-3 transition-colors ${selected?.user_id === d.user_id ? "bg-white/15 ring-1 ring-sky-400/60" : "bg-white/5 hover:bg-white/10"}`}>
                            <span className="text-xl">{CAR_EMOJIS[d.car_type ?? ""] ?? "🚗"}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold">{d.display_name}</p>
                              <p className="text-xs text-white/60">{d.vehicle ?? d.car_type ?? "Driver"}</p>
                            </div>
                            <span style={MONO} className="text-xs text-white/60 shrink-0">{formatDistance(d.distance_meters)}</span>
                          </button>
                        ))}
                        {drivers.length === 0 && (
                          <p className="text-xs text-white/50 text-center py-3">
                            {userCoords ? "No drivers nearby right now. Drivers appear when they share their location." : "Location access is off, so nearby drivers can't be shown."}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {mode === "trip" && tripRoute && (
              <div className="space-y-3">
                <div className="flex items-stretch gap-3">
                  <div className="flex flex-col items-center pt-1 pb-1">
                    <span className="size-2.5 rounded-full bg-green-400" />
                    <span className="w-px flex-1 bg-white/20 my-1" />
                    <span className="size-2.5 rounded-full bg-red-400" />
                  </div>
                  <div className="min-w-0 space-y-2">
                    <div>
                      <p className="text-[10px] text-white/50 font-medium uppercase tracking-wide">Pickup</p>
                      <p className="text-sm font-semibold truncate">{tripRoute.pickupLabel}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-white/50 font-medium uppercase tracking-wide">Destination</p>
                      <p className="text-sm font-semibold truncate">{tripRoute.destLabel}</p>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-white/50">{tripRoute.partnerName} · {tripRoute.date}</p>
                {loadingRoute && <p className="text-sm text-white/60 animate-pulse">Calculating route…</p>}
                {osrmResult && (
                  <div className="grid grid-cols-3 gap-2">
                    {[["Time", formatDuration(osrmResult.durationSeconds)], ["Distance", formatDistance(osrmResult.distanceMeters)], ["Fare/person", fareEstimate != null ? `$${(fareEstimate / 100).toFixed(2)}` : "—"]].map(([label, value]) => (
                      <div key={label} className="bg-white/10 rounded-xl p-2 text-center">
                        <p className="text-[10px] text-white/50">{label}</p>
                        <p style={MONO} className="text-sm font-semibold mt-0.5">{value}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {mode === "driving" && drivingTo && (
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] text-white/50 font-medium uppercase tracking-wide">Picking up</p>
                  <p className="text-sm font-semibold truncate">{drivingTo.partnerName} · {drivingTo.pickupLabel}</p>
                </div>
                {drivingGeoError && <p className="text-sm text-red-300">Couldn't access your location. Enable location access to navigate.</p>}
                {!drivingGeoError && drivingLoadingRoute && !drivingRoute && <p className="text-sm text-white/60 animate-pulse">Calculating route…</p>}
                {drivingRoute && (
                  <div className="grid grid-cols-2 gap-2">
                    {[["ETA", formatDuration(drivingRoute.durationSeconds)], ["Distance", formatDistance(drivingRoute.distanceMeters)]].map(([label, value]) => (
                      <div key={label} className="bg-white/10 rounded-xl p-2 text-center">
                        <p className="text-[10px] text-white/50">{label}</p>
                        <p style={MONO} className="text-sm font-semibold mt-0.5">{value}</p>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={onStopDriving} className="w-full py-2.5 rounded-xl bg-white text-slate-900 text-sm font-semibold">I've arrived</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes userPulse { 0%,100%{box-shadow:0 0 0 3px ${accentColor}80} 50%{box-shadow:0 0 0 6px ${accentColor}40} }

        /* Car marker: top-down SVG car rotated to the driver's heading, Uber-style */
        .carpool-car-icon { position:relative; width:40px; height:40px; cursor:pointer; }
        .carpool-car-icon::before {
          content:""; position:absolute; inset:2px; border-radius:50%; background:var(--carpool-accent); opacity:0;
        }
        .carpool-car-icon.tracking::before { animation: carpoolTrackPulse 1.6s ease-out infinite; }
        .carpool-car-body {
          position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          transform-origin:50% 50%; filter:drop-shadow(0 2px 4px rgba(0,0,0,.55));
        }
        @keyframes carpoolTrackPulse {
          0% { opacity:.35; transform:scale(1); }
          100% { opacity:0; transform:scale(2.4); }
        }

        /* Minimize the MapLibre attribution control to a small floating icon */
        .maplibregl-ctrl-attrib { background: rgba(15,23,42,.55) !important; border-radius: 8px; }
        .maplibregl-ctrl-attrib a { color: #cbd5e1 !important; }
        .maplibregl-ctrl-top-left { top: 64px; }
        .maplibregl-popup-content { background:#111a2e; color:#e2e8f0; border-radius:10px; font-size:12px; padding:8px 10px; }
        .maplibregl-popup-tip { border-top-color:#111a2e !important; border-bottom-color:#111a2e !important; }
      `}</style>
    </div>
  )
}
