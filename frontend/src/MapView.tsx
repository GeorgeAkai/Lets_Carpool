import { useEffect, useRef, useState, useCallback } from "react"
import * as maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useTheme } from "@neondatabase/auth-ui"
import * as api from "./api"
import type { NearbyDriver, RouteSuggestion } from "./api"
import {
  MapPin, Navigation, Clock, Ruler, DollarSign, X, Car, Search, Crosshair, ChevronUp, ChevronDown,
} from "lucide-react"

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

// ── Theme-aware vector basemap ──────────────────────────────────────────────
// CARTO's hosted GL styles give a real vector basemap (rotatable/pitchable,
// unlike flat raster tiles) with a light + dark pair that tracks the app
// theme. Same API key convention as the raster tiles this replaced — Vite
// only exposes VITE_-prefixed vars to the client, which is expected for a
// browser map key restricted by domain in the CARTO dashboard.
const CARTO_API_KEY = import.meta.env.VITE_CARTO_API_KEY as string | undefined
const CARTO_KEY_PARAM = CARTO_API_KEY ? `?key=${CARTO_API_KEY}` : ""
const STYLE_URL_LIGHT = `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json${CARTO_KEY_PARAM}`
const STYLE_URL_DARK = `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json${CARTO_KEY_PARAM}`
const ACCENT_LIGHT = "#0284c7"
const ACCENT_DARK = "#38bdf8"

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
// A live-tracking car marker in the spirit of Uber's driver dot: an emoji badge
// with a small compass wedge that rotates to the driver's heading, plus a
// pulsing halo while it's actively "en route" toward the selected rider.
function makeCarEl(heading: number | null, opts: { tracking?: boolean; accent?: string } = {}): HTMLDivElement {
  const el = document.createElement("div")
  const rotate = heading ?? 0
  const accent = opts.accent ?? ACCENT_LIGHT
  el.className = `carpool-car-icon${opts.tracking ? " tracking" : ""}`
  el.style.setProperty("--carpool-accent", accent)
  el.innerHTML = `<div class="carpool-car-heading" style="transform:rotate(${rotate}deg)"></div>
    <div class="carpool-car-emoji">🚗</div>`
  return el
}

function makeUserEl(accent: string = ACCENT_LIGHT): HTMLDivElement {
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

const MONO: React.CSSProperties = { fontFamily: "'DM Mono', monospace" }
const SERIF: React.CSSProperties = { fontFamily: "'DM Serif Display', serif" }

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
  tripRoute?: TripRoute | null
  onClearRoute?: () => void
  drivingTo?: DrivingTarget | null
  onStopDriving?: () => void
}

export function MapView({ userCoords, tripRoute, onClearRoute, drivingTo, onStopDriving }: Props) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const accentColor = isDark ? ACCENT_DARK : ACCENT_LIGHT

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

  const mode: "browse" | "trip" | "driving" = drivingTo ? "driving" : tripRoute ? "trip" : "browse"

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const center: [number, number] = userCoords ? [userCoords.lng, userCoords.lat] : [-122.4194, 37.7749]
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: isDark ? STYLE_URL_DARK : STYLE_URL_LIGHT,
      center, zoom: 14, pitch: 45,
      attributionControl: false,
    })
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right")
    map.on("load", () => { mapReadyRef.current = true; setMapReady(true) })
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; mapReadyRef.current = false; setMapReady(false) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Swap basemap style when the app's light/dark mode changes ──────────────
  // Sources/layers we add (the route line) don't survive setStyle, so they're
  // re-added by the "route" effect below once the new style finishes loading.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    map.setStyle(isDark ? STYLE_URL_DARK : STYLE_URL_LIGHT)
  }, [isDark])

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
        m.getElement().addEventListener("click", () => setSelected(d))
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
    <div className="space-y-4">
      {/* ══════════════════════════ Desktop header + mode cards (xl and up) — above the map ══════════════════════════ */}
      <div className="hidden xl:block xl:space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">
              {mode === "driving" ? "Driving to pickup" : mode === "trip" ? "Trip Route" : "Live Map"}
            </h1>
            <p className="text-muted-foreground mt-1">
              {mode === "driving" ? `Heading to ${drivingTo?.partnerName}` : mode === "trip" ? `${tripRoute?.partnerName} · ${tripRoute?.date}` : "See nearby drivers in real time."}
            </p>
          </div>
          {mode === "driving" ? (
            <button onClick={onStopDriving} className="flex items-center gap-2 px-4 py-2 rounded-2xl border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <X className="size-4" /> End
            </button>
          ) : mode === "trip" ? (
            <button onClick={onClearRoute} className="flex items-center gap-2 px-4 py-2 rounded-2xl border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <X className="size-4" /> Back to Map
            </button>
          ) : (
            <button onClick={toggleSharing} className={`px-4 py-2 rounded-2xl text-sm font-semibold transition-colors ${sharing ? "bg-green-600 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}>
              {sharing ? "📡 Sharing location" : "Share my location"}
            </button>
          )}
        </div>

        {mode === "driving" && drivingTo && (
          <div className="rounded-3xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0"><Car className="size-4 text-primary" /></div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-medium">PICKING UP</p>
                <p className="text-sm font-semibold text-foreground truncate">{drivingTo.partnerName} · {drivingTo.pickupLabel}</p>
              </div>
            </div>
            {drivingGeoError && <p className="text-sm text-destructive text-center">Couldn't access your location. Enable location access to navigate.</p>}
            {!drivingGeoError && drivingLoadingRoute && !drivingRoute && <p className="text-sm text-muted-foreground animate-pulse text-center">Calculating route…</p>}
            {drivingRoute && (
              <div className="grid grid-cols-2 gap-3">
                {[{ Icon: Clock, label: "ETA", value: formatDuration(drivingRoute.durationSeconds) }, { Icon: Ruler, label: "Distance", value: formatDistance(drivingRoute.distanceMeters) }].map(({ Icon, label, value }) => (
                  <div key={label} className="bg-muted rounded-2xl p-3 text-center">
                    <Icon className="size-4 text-primary mx-auto mb-1" />
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
                    <p style={MONO} className="text-base font-semibold text-foreground mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
            )}
            <button onClick={onStopDriving} className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">I've arrived</button>
          </div>
        )}

        {mode === "trip" && tripRoute && (
          <div className="rounded-3xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-stretch gap-3">
              <div className="flex flex-col items-center gap-0">
                <div className="size-3 rounded-full bg-green-500 mt-0.5 shrink-0" />
                <div className="w-0.5 flex-1 bg-border my-1" />
                <div className="size-3 rounded-full bg-red-500 mb-0.5 shrink-0" />
              </div>
              <div className="flex flex-col justify-between gap-2 min-w-0">
                <div><p className="text-xs text-muted-foreground font-medium">PICKUP</p><p className="text-sm font-semibold text-foreground truncate">{tripRoute.pickupLabel}</p></div>
                <div><p className="text-xs text-muted-foreground font-medium">DESTINATION</p><p className="text-sm font-semibold text-foreground truncate">{tripRoute.destLabel}</p></div>
              </div>
            </div>
            {loadingRoute && <p className="text-sm text-muted-foreground animate-pulse text-center">Calculating route…</p>}
            {osrmResult && (
              <div className="grid grid-cols-3 gap-3">
                {[{ Icon: Clock, label: "Est. time", value: formatDuration(osrmResult.durationSeconds) }, { Icon: Ruler, label: "Distance", value: formatDistance(osrmResult.distanceMeters) }, { Icon: DollarSign, label: "Fare / person", value: fareEstimate != null ? `$${(fareEstimate / 100).toFixed(2)}` : "—" }].map(({ Icon, label, value }) => (
                  <div key={label} className="bg-muted rounded-2xl p-3 text-center">
                    <Icon className="size-4 text-primary mx-auto mb-1" />
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
                    <p style={MONO} className="text-base font-semibold text-foreground mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-green-500 inline-block" />Pickup</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-red-500 inline-block" />Destination</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5 bg-primary rounded" />Route</span>
            </div>
          </div>
        )}
      </div>

      {/* ══════════════════════════ Map box: full-viewport on mobile, boxed card on desktop ══════════════════════════ */}
      {/* This single wrapper is the positioned ancestor for the canvas plus every overlay (mobile pill/sheet, desktop refresh/recenter buttons) — its own position/size is what actually differs by breakpoint. */}
      <div className={`fixed inset-0 z-0 xl:relative xl:inset-auto xl:z-auto xl:rounded-3xl xl:overflow-hidden xl:border xl:border-border xl:shadow-lg ${mode !== "browse" ? "xl:h-[380px]" : "xl:h-[420px]"}`}>
        <div ref={containerRef} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />

        {/* Desktop floating buttons over the boxed map */}
        <div className="hidden xl:contents">
          {mode === "browse" && (
            <button onClick={fetchDrivers} className="absolute top-3 right-3 z-[5] bg-card border border-border rounded-xl px-3 py-1.5 text-xs font-medium shadow hover:bg-muted transition-colors">
              Refresh
            </button>
          )}
          {mode === "trip" && loadingRoute && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-sm z-[5]">
              <div className="bg-card rounded-2xl px-5 py-3 shadow-lg text-sm text-muted-foreground animate-pulse flex items-center gap-2">
                <Navigation className="size-4 text-primary animate-spin" /> Finding best route…
              </div>
            </div>
          )}
          <button onClick={recenter} aria-label="Re-center map" className="absolute bottom-3 right-3 z-[5] size-9 rounded-full bg-card border border-border shadow flex items-center justify-center hover:bg-muted transition-colors">
            <Crosshair className="size-4 text-foreground" />
          </button>
        </div>

        {/* ══════════════════════════ Mobile immersive chrome (< xl) ══════════════════════════ */}
        <div className="xl:hidden">
          {/* Floating top pill */}
        <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/80 text-white backdrop-blur-md shadow-lg">
            {mode === "driving" ? <Car className="size-4" /> : mode === "trip" ? <Navigation className="size-4" /> : <MapPin className="size-4" />}
            <span className="text-sm font-medium">
              {mode === "driving" ? `Heading to ${drivingTo?.partnerName}` : mode === "trip" ? "Trip Route" : "Live Map"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(mode === "trip" || mode === "driving") && (
              <button
                onClick={mode === "trip" ? onClearRoute : onStopDriving}
                aria-label="Close"
                className="size-10 rounded-full bg-slate-900/80 text-white backdrop-blur-md shadow-lg flex items-center justify-center"
              >
                <X className="size-4" />
              </button>
            )}
            <button
              onClick={recenter}
              aria-label="Re-center map"
              className="size-10 rounded-full bg-slate-900/80 text-white backdrop-blur-md shadow-lg flex items-center justify-center"
            >
              <Crosshair className="size-4" />
            </button>
          </div>
        </div>

        {/* Bottom sheet drawer */}
        <div
          className={`absolute left-0 right-0 bottom-0 z-10 rounded-t-3xl border-t border-white/10 bg-slate-900/90 text-white backdrop-blur-md shadow-[0_-8px_30px_rgba(0,0,0,.3)] transition-[max-height] duration-300 overflow-hidden ${sheetExpanded ? "max-h-[70vh]" : "max-h-[220px]"}`}
        >
          <button
            onClick={() => setSheetExpanded(v => !v)}
            className="w-full flex flex-col items-center pt-2.5 pb-1"
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
                        {nearbyCount} driver{nearbyCount !== 1 ? "s" : ""} nearby
                      </span>
                      {sheetExpanded ? <ChevronDown className="size-4 text-white/60" /> : <ChevronUp className="size-4 text-white/60" />}
                    </button>

                    {sheetExpanded && (
                      <div className="space-y-2 pt-2">
                        <button
                          onClick={toggleSharing}
                          className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${sharing ? "bg-green-500 text-white" : "bg-white text-slate-900"}`}
                        >
                          {sharing ? "📡 Sharing your location" : "Share my location as a driver"}
                        </button>
                        {drivers.map(d => (
                          <button key={d.user_id} onClick={() => setSelected(d)} className={`w-full text-left rounded-2xl p-3.5 flex items-center gap-3 transition-colors ${selected?.user_id === d.user_id ? "bg-white/15" : "bg-white/5 hover:bg-white/10"}`}>
                            <span className="text-xl">{CAR_EMOJIS[d.car_type ?? ""] ?? "🚗"}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold">{d.display_name}</p>
                              <p className="text-xs text-white/60">{d.vehicle ?? d.car_type ?? "Driver"}</p>
                            </div>
                            <span style={MONO} className="text-xs text-white/60 shrink-0">{d.distance_meters}m</span>
                          </button>
                        ))}
                        {drivers.length === 0 && <p className="text-xs text-white/50 text-center py-3">No drivers nearby right now.</p>}
                        {selected && nearbyRoute && (
                          <div className="grid grid-cols-3 gap-2 pt-1">
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
                  </>
                )}
              </>
            )}

            {mode === "trip" && tripRoute && (
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] text-white/50 font-medium uppercase tracking-wide">Pickup</p>
                  <p className="text-sm font-semibold truncate">{tripRoute.pickupLabel}</p>
                </div>
                <div>
                  <p className="text-[10px] text-white/50 font-medium uppercase tracking-wide">Destination</p>
                  <p className="text-sm font-semibold truncate">{tripRoute.destLabel}</p>
                </div>
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
                <p className="text-sm font-semibold truncate">{drivingTo.partnerName} · {drivingTo.pickupLabel}</p>
                {drivingGeoError && <p className="text-sm text-red-300">Couldn't access your location.</p>}
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
      </div>

      {/* ══════════════════════════ Desktop below-map lists (xl and up) ══════════════════════════ */}
      <div className="hidden xl:block xl:space-y-4">
        {mode === "browse" && selected && (
          <div className="bg-card border border-border rounded-3xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Nearby driver</p>
                <h3 className="text-lg font-semibold">{selected.display_name}</h3>
                <p className="text-sm text-muted-foreground">{selected.vehicle ?? selected.car_type ?? "Unknown vehicle"} · {selected.distance_meters}m away</p>
              </div>
              <button onClick={() => { setSelected(null); setRouteLine(null) }} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
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

        {mode === "browse" && drivers.length > 0 && (
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

        {mode === "browse" && drivers.length === 0 && !userCoords && (
          <div className="text-center py-12 text-muted-foreground">
            <MapPin className="size-10 mx-auto mb-3 opacity-20" />
            <p className="font-medium">Location not available</p>
            <p className="text-sm mt-1">Enable location access to see nearby drivers.</p>
          </div>
        )}

        {mode === "browse" && drivers.length === 0 && userCoords && (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-4xl mb-3">🚗</p>
            <p className="font-medium">No drivers nearby right now</p>
            <p className="text-sm mt-1">Drivers appear when they share their location.</p>
          </div>
        )}
      </div>

      <style>{`
        @keyframes userPulse { 0%,100%{box-shadow:0 0 0 3px ${accentColor}80} 50%{box-shadow:0 0 0 6px ${accentColor}40} }

        /* Car marker: emoji badge + rotating heading wedge, Uber-style */
        .carpool-car-icon { position:relative; width:38px; height:38px; }
        .carpool-car-icon::before {
          content:""; position:absolute; inset:0; border-radius:50%; background:var(--carpool-accent); opacity:0;
        }
        .carpool-car-icon.tracking::before { animation: carpoolTrackPulse 1.6s ease-out infinite; }
        .carpool-car-heading { position:absolute; inset:0; transform-origin:50% 50%; }
        .carpool-car-heading::after {
          content:""; position:absolute; top:-2px; left:50%; margin-left:-5px;
          width:0; height:0; border-left:5px solid transparent; border-right:5px solid transparent;
          border-bottom:9px solid var(--carpool-accent); filter:drop-shadow(0 1px 1px rgba(0,0,0,.4));
        }
        .carpool-car-emoji {
          position:absolute; inset:0; margin:auto; width:30px; height:30px; font-size:18px; line-height:1;
          display:flex; align-items:center; justify-content:center; border-radius:50%; background:#fff;
          box-shadow:0 2px 8px rgba(0,0,0,.35), 0 0 0 2px var(--carpool-accent);
        }
        .carpool-car-icon.tracking .carpool-car-emoji { box-shadow:0 2px 10px rgba(0,0,0,.4), 0 0 0 3px var(--carpool-accent); }
        .dark .carpool-car-emoji { background:#111a2e; }
        @keyframes carpoolTrackPulse {
          0% { opacity:.35; transform:scale(1); }
          100% { opacity:0; transform:scale(2.6); }
        }

        /* Minimize the MapLibre attribution control to a small floating icon */
        .maplibregl-ctrl-attrib { background: rgba(15,23,42,.55) !important; border-radius: 8px; }
        .maplibregl-ctrl-attrib a { color: #cbd5e1 !important; }
        .maplibregl-popup-content { background:#fff; color:#0f172a; border-radius:10px; font-size:12px; padding:8px 10px; }
        .dark .maplibregl-popup-content { background:#111a2e; color:#e2e8f0; }
        .dark .maplibregl-popup-tip { border-top-color:#111a2e !important; border-bottom-color:#111a2e !important; }
      `}</style>
    </div>
  )
}
