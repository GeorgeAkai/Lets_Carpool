import { useEffect, useRef, useState, useCallback } from "react"
import * as api from "./api"
import type { NearbyDriver, RouteSuggestion } from "./api"
import { createLocationUploader } from "./lib/locationUploader"
import { snapToPath } from "./lib/geo"
import type { LatLng } from "./lib/geo"
import { loadGoogleMaps, searchPlaces, fetchRoute } from "./lib/googleMaps"
import type { LineString, PlaceResult, RouteGeometry } from "./lib/googleMaps"
import {
  MapPin, Navigation, X, Car, Search, Crosshair, ChevronUp, ChevronDown, Sun, Moon,
} from "lucide-react"
import { useTheme } from "next-themes"

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

// A driver's active "go pick up this passenger" navigation target — the passenger's
// pickup point is autodetected from their (now-revealed, post-acceptance)
// ride request, so the driver never has to type an address in.
export interface DrivingTarget {
  connectionId: string
  pickupLat: number
  pickupLng: number
  pickupLabel: string
  partnerName: string
  // Which leg is being navigated; the coordinates above are that leg's target.
  kind?: "pickup" | "destination"
}

type OsrmResult = RouteGeometry

const CAR_EMOJIS: Record<string, string> = {
  suv: "🚙", van: "🚐", minivan: "🚐", truck: "🚚", sedan: "🚗", other: "🚗",
}

// ── Google basemap: dark or light ───────────────────────────────────────────
// Google Maps is the primary basemap. It follows the app theme until the user
// flips it with the sun/moon button on the map. The floating panels carry
// their own dark backgrounds, so they read fine over either basemap.
const LIGHT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
]

const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1d2433" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9aa7bd" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1d2433" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#3a4560" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c3650" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1d2433" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3b4a6e" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0f1626" }] },
]
const ACCENT = "#38bdf8"
// Sky blue vanishes on a light basemap, so routes and the user dot go deeper.
const ACCENT_LIGHT = "#2563eb"
const MAP_THEME_KEY = "carpool_map_theme"

function storedMapTheme(): "light" | "dark" | null {
  try {
    const v = localStorage.getItem(MAP_THEME_KEY)
    return v === "light" || v === "dark" ? v : null
  } catch { return null }
}

// ── Marker motion interpolation (pure, unit-testable) ──────────────────────────
// Smoothly glides a marker between successive polled positions instead of
// snapping, the way Uber/Google Maps animate a live driver dot. Coordinates
// here are plain [lat, lng] tuples — conversion to GeoJSON's [lng, lat]
// order happens only where route geometry is read or written.

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

/** [lat, lng] -> GeoJSON's [lng, lat] ordering. */
function toLngLat(p: [number, number]): [number, number] {
  return [p[1], p[0]]
}

function toLatLngLiteral(p: [number, number]): google.maps.LatLngLiteral {
  return { lat: p[0], lng: p[1] }
}

function fitPoints(map: google.maps.Map, points: [number, number][], padding: number) {
  const bounds = new google.maps.LatLngBounds()
  points.forEach(p => bounds.extend(toLatLngLiteral(p)))
  map.fitBounds(bounds, padding)
}

/** Smoothly recenters (and zooms) the map. */
function flyTo(map: google.maps.Map, p: [number, number], zoom: number) {
  map.panTo(toLatLngLiteral(p))
  map.setZoom(zoom)
}

// A Google OverlayView that hosts an arbitrary DOM element at a lat/lng, so the
// animated car / pin markers keep their existing DOM+CSS look. Built lazily
// because `google.maps.OverlayView` only exists once the API has loaded.
interface DomMarker {
  setElement(el: HTMLElement): void
  getElement(): HTMLElement
  setLatLng(p: [number, number]): void
  getLatLng(): [number, number]
  /** Click shows an info window with a bold title and optional lines (text only). */
  setPopup(title: string, ...lines: string[]): void
  onClick(cb: () => void): void
  remove(): void
}
type DomMarkerCtor = new (map: google.maps.Map, el: HTMLElement, pos: [number, number]) => DomMarker

let domMarkerCtor: DomMarkerCtor | null = null
function getDomMarkerCtor(): DomMarkerCtor {
  if (domMarkerCtor) return domMarkerCtor
  class Impl extends google.maps.OverlayView implements DomMarker {
    private wrap = document.createElement("div")
    private info: google.maps.InfoWindow | null = null
    private clickCb: (() => void) | null = null
    constructor(private gmap: google.maps.Map, private el: HTMLElement, private pos: [number, number]) {
      super()
      this.wrap.style.cssText = "position:absolute;transform:translate(-50%,-50%);cursor:pointer"
      this.wrap.appendChild(el)
      this.wrap.addEventListener("click", () => {
        this.clickCb?.()
        if (this.info) { this.info.setPosition(toLatLngLiteral(this.pos)); this.info.open({ map: this.gmap }) }
      })
      this.setMap(gmap)
    }
    onAdd() { this.getPanes()?.overlayMouseTarget.appendChild(this.wrap) }
    draw() {
      const pt = this.getProjection()?.fromLatLngToDivPixel(new google.maps.LatLng(this.pos[0], this.pos[1]))
      if (pt) { this.wrap.style.left = `${pt.x}px`; this.wrap.style.top = `${pt.y}px` }
    }
    onRemove() { this.wrap.remove() }
    setElement(el: HTMLElement) { this.wrap.replaceChildren(el); this.el = el }
    getElement() { return this.el }
    setLatLng(p: [number, number]) { this.pos = p; this.draw() }
    getLatLng() { return this.pos }
    setPopup(title: string, ...lines: string[]) {
      const box = document.createElement("div")
      box.style.cssText = "font-size:12px;color:#0f172a"
      const b = document.createElement("b"); b.textContent = title; box.appendChild(b)
      lines.forEach(l => { box.appendChild(document.createElement("br")); box.appendChild(document.createTextNode(l)) })
      this.info ??= new google.maps.InfoWindow({ disableAutoPan: false })
      this.info.setContent(box)
    }
    onClick(cb: () => void) { this.clickCb = cb }
    remove() { this.info?.close(); this.setMap(null) }
  }
  domMarkerCtor = Impl
  return Impl
}

function newMarker(map: google.maps.Map, el: HTMLElement, pos: [number, number]): DomMarker {
  return new (getDomMarkerCtor())(map, el, pos)
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
// Own-position marker: glide for as long as the last fix interval (≈ the GPS rate), bounded.
const SELF_ANIM_MIN_MS = 600
const SELF_ANIM_MAX_MS = 2500
const CAMERA_FOLLOW_MS = 1500

// Synthetic marker id for the driver's own live position while "Start Driving"
// is active, so it can reuse the same lerp/heading animation machinery that
// nearby-driver dots use instead of a parallel implementation.
const DRIVING_SELF_KEY = "__driving_self__"

// Re-fetch the OSRM route to the passenger only when the driver has moved enough
// (or enough time has passed) to make a fresh route worth the request — an
// Uber-style nav view doesn't need a new route on every single GPS tick.
const DRIVING_ROUTE_REFRESH_METERS = 40
const DRIVING_ROUTE_REFRESH_MS = 20000

// ── Marker DOM factories ─────────────────────────────────────────────────────
// A top-down SVG car (nose pointing north at 0deg) that rotates to the
// driver's heading, Uber-style, plus a pulsing halo while it's actively
// "en route" toward the selected passenger. The rotating wrapper must stay the
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

// ── Lightweight "Where to?" search (Google geocoding) ──────────────────────────────
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
  const { resolvedTheme } = useTheme()
  const [mapThemeChoice, setMapThemeChoice] = useState<"light" | "dark" | null>(storedMapTheme)
  const mapTheme = mapThemeChoice ?? (resolvedTheme === "light" ? "light" : "dark")
  const accentColor = mapTheme === "light" ? ACCENT_LIGHT : ACCENT
  const toggleMapTheme = () => {
    const next = mapTheme === "light" ? "dark" : "light"
    setMapThemeChoice(next)
    try { localStorage.setItem(MAP_THEME_KEY, next) } catch { /* private mode */ }
  }

  const mapRef = useRef<google.maps.Map | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapReadyRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  const [mapUnavailable, setMapUnavailable] = useState(false)
  const routeLineRef = useRef<google.maps.Polyline | null>(null)
  const markersRef = useRef<Record<string, DomMarker>>({})
  const markerHeadingsRef = useRef<Record<string, number>>({})
  const animsRef = useRef<Record<string, MarkerAnimation>>({})
  const stopShareUploadRef = useRef<(() => void) | null>(null)
  const drivingPathRef = useRef<LatLng[] | null>(null)
  const lastSampleAtRef = useRef<number | null>(null)
  const lastCameraAtRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)
  const userMarkerRef = useRef<DomMarker | null>(null)
  const pickupMarkerRef = useRef<DomMarker | null>(null)
  const destMarkerRef = useRef<DomMarker | null>(null)
  const searchMarkerRef = useRef<DomMarker | null>(null)

  const [drivers, setDrivers] = useState<NearbyDriver[]>([])
  const [selected, setSelected] = useState<NearbyDriver | null>(null)
  const [nearbyRoute, setNearbyRoute] = useState<RouteSuggestion | null>(null)
  const [loadingRoute, setLoadingRoute] = useState(false)
  const [osrmResult, setOsrmResult] = useState<OsrmResult | null>(null)
  const [sharing, setSharing] = useState(false)
  const [watchId, setWatchId] = useState<number | null>(null)

  // ── "Start Driving" navigation-to-passenger mode ────────────────────────────────
  const drivingPickupMarkerRef = useRef<DomMarker | null>(null)
  const drivingLastRouteFetchRef = useRef<{ pos: [number, number]; time: number } | null>(null)
  const drivingFitOnceRef = useRef(false)
  const [drivingSample, setDrivingSample] = useState<{ pos: [number, number]; heading: number } | null>(null)
  const [drivingRoute, setDrivingRoute] = useState<OsrmResult | null>(null)
  const [drivingLoadingRoute, setDrivingLoadingRoute] = useState(false)
  const [drivingGeoError, setDrivingGeoError] = useState(false)

  // ── Mobile immersive chrome ──────────────────────────────────────────────────
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [searchText, setSearchText] = useState("")
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([])
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

  useEffect(() => {
    mapRef.current?.setOptions({ styles: mapTheme === "light" ? LIGHT_MAP_STYLES : DARK_MAP_STYLES })
    routeLineRef.current?.setOptions({ strokeColor: accentColor })
  }, [mapTheme, accentColor, mapReady])

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    loadGoogleMaps().then(maps => {
      if (cancelled || !containerRef.current || mapRef.current) return
      if (!maps) { setMapUnavailable(true); return }
      const map = new maps.Map(containerRef.current, {
        center: userCoords ? toLatLngLiteral([userCoords.lat, userCoords.lng]) : { lat: 37.7749, lng: -122.4194 },
        zoom: 14,
        styles: mapTheme === "light" ? LIGHT_MAP_STYLES : DARK_MAP_STYLES,
        disableDefaultUI: true,
        zoomControl: false,
        clickableIcons: false,
        gestureHandling: "greedy",
      })
      routeLineRef.current = new maps.Polyline({ map, strokeColor: accentColor, strokeWeight: 5, strokeOpacity: 0.9, clickable: false })
      mapRef.current = map
      mapReadyRef.current = true
      setMapReady(true)
    })
    return () => {
      cancelled = true
      routeLineRef.current?.setMap(null); routeLineRef.current = null
      Object.values(markersRef.current).forEach(m => m.remove()); markersRef.current = {}
      mapRef.current = null; mapReadyRef.current = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Shared route line (used by trip-route + driving modes) ─────────────────
  const setRouteLine = useCallback((geometry: LineString | null, dashed = false) => {
    const line = routeLineRef.current
    if (!line) return
    line.setPath(geometry ? geometry.coordinates.map(([lng, lat]) => ({ lat, lng })) : [])
    line.setOptions({
      strokeColor: accentColor,
      strokeOpacity: dashed ? 0 : 0.9,
      icons: dashed
        ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: accentColor, scale: 3 }, offset: "0", repeat: "12px" }]
        : [],
    })
  }, [accentColor])

  // ── User marker (browse mode only) ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !userCoords || mode !== "browse") return
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([userCoords.lat, userCoords.lng])
    } else {
      userMarkerRef.current = newMarker(map, makeUserEl(accentColor), [userCoords.lat, userCoords.lng])
      flyTo(map, [userCoords.lat, userCoords.lng], 14)
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

    pickupMarkerRef.current = newMarker(map, makePickupEl(), [pickupLat, pickupLng])
    pickupMarkerRef.current.setPopup("Pickup", pickupLabel)
    destMarkerRef.current = newMarker(map, makeDestEl(), [destLat, destLng])
    destMarkerRef.current.setPopup("Destination", destLabel)

    fitPoints(map, [[pickupLat, pickupLng], [destLat, destLng]], 80)

    setLoadingRoute(true)
    setOsrmResult(null)
    fetchRoute(pickupLat, pickupLng, destLat, destLng).then(result => {
      if (!mapRef.current) return
      if (result) {
        setRouteLine(result.geometry, false)
        const coords = result.geometry.coordinates as [number, number][]
        if (coords.length > 0) {
          fitPoints(mapRef.current, coords.map(([lng, lat]) => [lat, lng] as [number, number]), 80)
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
    const id = setInterval(() => { if (!document.hidden) fetchDrivers() }, 10000)
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
      marker.setLatLng(pos)
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
  // The selected driver's heading is overridden to point straight at the passenger
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
        const currentPos: [number, number] = prevAnim ? lerpLatLng(prevAnim.from, prevAnim.to, t) : marker.getLatLng()
        const currentHeading = prevAnim ? lerpAngle(prevAnim.fromHeading, prevAnim.toHeading, t) : (markerHeadingsRef.current[d.user_id] ?? targetHeading)
        animsRef.current[d.user_id] = {
          from: currentPos, to: [d.latitude, d.longitude],
          fromHeading: currentHeading, toHeading: targetHeading,
          start: now, duration: MARKER_ANIM_DURATION_MS,
        }
        if (trackingRef.current[d.user_id] !== tracking) {
          trackingRef.current[d.user_id] = tracking
          const newEl = makeCarEl(currentHeading, { tracking, accent: accentColor })
          marker.setElement(newEl)
        }
      } else {
        trackingRef.current[d.user_id] = tracking
        markerHeadingsRef.current[d.user_id] = targetHeading
        const m = newMarker(map, makeCarEl(targetHeading, { tracking, accent: accentColor }), [d.latitude, d.longitude])
        m.setPopup(d.display_name, d.vehicle ?? d.car_type ?? "Driver", `${d.distance_meters}m away`)
        m.onClick(() => { setSelected(d); setSheetExpanded(true) })
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
        fitPoints(mapRef.current!, [[userCoords.lat, userCoords.lng], [selected.latitude, selected.longitude]], 60)
      })
      .catch(() => {})
      .finally(() => setLoadingRoute(false))
    return () => setRouteLine(null)
  }, [selected, userCoords, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Share my location as a driver ───────────────────────────────────────────
  const toggleSharing = useCallback(() => {
    if (sharing) {
      if (watchId != null) navigator.geolocation.clearWatch(watchId)
      stopShareUploadRef.current?.()
      setWatchId(null); setSharing(false); return
    }
    if (!navigator.geolocation) return
    const uploader = createLocationUploader(f => api.updateLocation(f.lat, f.lng, f.heading, f.speedKmh))
    const id = navigator.geolocation.watchPosition(
      pos => uploader.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, heading: pos.coords.heading ?? undefined, speedKmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000 },
    )
    stopShareUploadRef.current = uploader.stop
    setWatchId(id); setSharing(true)
  }, [sharing, watchId])

  useEffect(() => () => { if (watchId != null) navigator.geolocation.clearWatch(watchId) }, [watchId])

  // ── "Start Driving" mode: watch the driver's own live position ─────────────
  // Autodetects the driver's real GPS position (the passenger's pickup point is
  // already known from their accepted ride request, so no address entry is
  // needed on either side) and streams it, Uber-nav style.
  useEffect(() => {
    if (!drivingTo) { setDrivingSample(null); setDrivingGeoError(false); drivingPathRef.current = null; lastSampleAtRef.current = null; return }
    if (!navigator.geolocation) { setDrivingGeoError(true); return }
    let lastPos: [number, number] | null = null
    const uploader = createLocationUploader(f => api.updateLocation(f.lat, f.lng, f.heading, f.speedKmh))
    const id = navigator.geolocation.watchPosition(
      pos => {
        // Keep the car on the road: snap to the current route when we're close to it.
        const raw = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        const path = drivingPathRef.current
        const snapped = path ? snapToPath(path, raw) : raw
        const next: [number, number] = [snapped.lat, snapped.lng]
        const heading = pos.coords.heading
          ?? (lastPos ? bearingDegrees(lastPos, next) : bearingDegrees(next, [drivingTo.pickupLat, drivingTo.pickupLng]))
        lastPos = next
        setDrivingSample({ pos: next, heading })
        uploader.push({ lat: next[0], lng: next[1], heading, speedKmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined })
      },
      () => setDrivingGeoError(true),
      { enableHighAccuracy: true, maximumAge: 1000 },
    )
    return () => { navigator.geolocation.clearWatch(id); uploader.stop() }
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
      const currentPos: [number, number] = prevAnim ? lerpLatLng(prevAnim.from, prevAnim.to, t) : marker.getLatLng()
      const currentHeading = prevAnim ? lerpAngle(prevAnim.fromHeading, prevAnim.toHeading, t) : (markerHeadingsRef.current[DRIVING_SELF_KEY] ?? heading)
      animsRef.current[DRIVING_SELF_KEY] = {
        from: currentPos, to: pos, fromHeading: currentHeading, toHeading: heading,
        start: now,
        duration: Math.min(SELF_ANIM_MAX_MS, Math.max(SELF_ANIM_MIN_MS, lastSampleAtRef.current ? now - lastSampleAtRef.current : 1000)),
      }
    } else {
      markerHeadingsRef.current[DRIVING_SELF_KEY] = heading
      const m = newMarker(map, makeCarEl(heading, { tracking: true, accent: accentColor }), pos)
      m.setPopup("You")
      markersRef.current[DRIVING_SELF_KEY] = m
      flyTo(map, pos, 16)
    }
    lastSampleAtRef.current = now
    if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(stepMarkerAnimations)
    // Re-centring on every fix restarts the map's pan animation and judders; do it at a gentler cadence.
    if (now - lastCameraAtRef.current >= CAMERA_FOLLOW_MS) { lastCameraAtRef.current = now; map.panTo(toLatLngLiteral(pos)) }
  }, [drivingSample, mode, accentColor, stepMarkerAnimations, mapReady])

  // ── "Start Driving" mode: pickup marker + route to the passenger ───────────────
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
      drivingPickupMarkerRef.current = newMarker(map, makePickupEl(), [drivingTo.pickupLat, drivingTo.pickupLng])
      drivingPickupMarkerRef.current.setPopup(drivingTo.partnerName, drivingTo.pickupLabel)
    }

    if (!drivingSample) return
    const last = drivingLastRouteFetchRef.current
    const moved = last ? distanceMeters(last.pos, drivingSample.pos) : Infinity
    const elapsed = last ? performance.now() - last.time : Infinity
    if (moved < DRIVING_ROUTE_REFRESH_METERS && elapsed < DRIVING_ROUTE_REFRESH_MS) return

    drivingLastRouteFetchRef.current = { pos: drivingSample.pos, time: performance.now() }
    setDrivingLoadingRoute(true)
    fetchRoute(drivingSample.pos[0], drivingSample.pos[1], drivingTo.pickupLat, drivingTo.pickupLng).then(result => {
      if (!mapRef.current || mode !== "driving") return
      if (result) {
        setRouteLine(result.geometry, false)
        drivingPathRef.current = result.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
        setDrivingRoute(result)
      } else {
        setRouteLine({ type: "LineString", coordinates: [toLngLat(drivingSample.pos), toLngLat([drivingTo.pickupLat, drivingTo.pickupLng])] }, true)
        setDrivingRoute(null)
      }
    }).finally(() => setDrivingLoadingRoute(false))
  }, [drivingTo, drivingSample, mode, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // First fix while driving: fit both the driver and the passenger on screen.
  useEffect(() => {
    const map = mapRef.current
    if (!map || mode !== "driving" || !drivingTo || !drivingSample || drivingFitOnceRef.current) return
    drivingFitOnceRef.current = true
    fitPoints(map, [drivingSample.pos, [drivingTo.pickupLat, drivingTo.pickupLng]], 80)
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

  // ── "Where to?" search (Google geocoding, Nominatim fallback) ───────────────
  const runSearch = useCallback((q: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!q.trim()) { setSearchResults([]); return }
    searchDebounceRef.current = setTimeout(async () => {
      try {
        setSearchResults(await searchPlaces(q, userCoords))
      } catch { /* ignore */ }
    }, 350)
  }, [userCoords])

  const selectSearchResult = useCallback((r: PlaceResult) => {
    const map = mapRef.current
    setSearchText(r.label.split(",")[0])
    setSearchResults([])
    if (!map) return
    searchMarkerRef.current?.remove()
    searchMarkerRef.current = newMarker(map, makeDestEl(), [r.lat, r.lng])
    flyTo(map, [r.lat, r.lng], 15)
    setSheetExpanded(false)
  }, [])

  // ── Recenter on the driver's live position ──────────────────────────────────
  const recenter = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    if (mode === "driving" && drivingSample) flyTo(map, drivingSample.pos, 16)
    else if (userCoords) flyTo(map, [userCoords.lat, userCoords.lng], 14)
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
      <div className={`fixed inset-x-0 top-0 bottom-16 z-0 xl:relative xl:inset-auto xl:bottom-auto xl:h-[calc(100dvh-6.5rem)] xl:overflow-hidden ${mapTheme === "light" ? "bg-[#e8eaed]" : "bg-[#0e1626]"}`}>
        <div ref={containerRef} className="absolute inset-0 w-full h-full z-0" />
        {mapUnavailable && (
          <div className="absolute inset-0 z-[1] flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
            The map couldn't be loaded. Check that MAP_API_KEY is set on the backend and the Maps JavaScript API is enabled for it.
          </div>
        )}

        {/* ── Floating header ── */}
        <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between gap-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/75 text-white backdrop-blur-md shadow-lg min-w-0">
            {mode === "driving" ? <Car className="size-4 shrink-0" /> : mode === "trip" ? <Navigation className="size-4 shrink-0" /> : <MapPin className="size-4 shrink-0" />}
            <span className="text-sm font-medium truncate">
              {mode === "driving" ? (drivingTo?.kind === "destination" ? `Driving ${drivingTo.partnerName} to drop-off` : `Heading to ${drivingTo?.partnerName}`) : mode === "trip" ? `Trip with ${tripRoute?.partnerName}` : "Live Map"}
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
              onClick={toggleMapTheme}
              aria-label={mapTheme === "light" ? "Switch map to dark mode" : "Switch map to light mode"}
              title={mapTheme === "light" ? "Dark map" : "Light map"}
              className="size-10 rounded-full bg-slate-900/75 text-white backdrop-blur-md shadow-lg flex items-center justify-center hover:bg-slate-900"
            >
              {mapTheme === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </button>
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
                      <li key={r.id}>
                        <button onClick={() => selectSearchResult(r)} className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/10 flex items-start gap-2.5">
                          <MapPin className="size-3.5 text-white/50 shrink-0 mt-0.5" />
                          <span className="text-sm truncate">{r.detail}</span>
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
      `}</style>
    </div>
  )
}
