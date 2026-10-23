// Google Maps is the app's primary map provider. The key lives in the backend
// env (MAP_API_KEY) and is handed to the browser by GET /config/maps, since the
// Maps JavaScript API runs client-side (restrict the key by HTTP referrer).
// Geocoding and routing use Google first and degrade to Nominatim / OSRM, so
// the app still works if the key is missing or an API isn't enabled for it.
import { BASE } from "../api"
import { formatPlace } from "./places"

type Maps = typeof google.maps

let loading: Promise<Maps | null> | null = null

/** Loads the Maps JS API once; resolves null (never rejects) when unavailable. */
export function loadGoogleMaps(): Promise<Maps | null> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${BASE}/config/maps`)
      if (!res.ok) return null
      const { api_key } = await res.json()
      if (!api_key) return null
      if (!window.google?.maps?.importLibrary) {
        await new Promise<void>((resolve, reject) => {
          const cb = "__carpoolGoogleMapsReady"
          ;(window as unknown as Record<string, unknown>)[cb] = resolve
          const s = document.createElement("script")
          s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(api_key)}&v=weekly&loading=async&callback=${cb}`
          s.async = true
          s.onerror = () => reject(new Error("Google Maps failed to load"))
          document.head.appendChild(s)
        })
      }
      await Promise.all([
        google.maps.importLibrary("maps"),
        google.maps.importLibrary("geocoding"),
        google.maps.importLibrary("routes"),
        // Optional: Places (New) powers address autocomplete, but the app
        // still geocodes by text when the API isn't enabled for the key.
        google.maps.importLibrary("places").catch(() => null),
      ])
      return google.maps
    } catch {
      return null
    }
  })()
  // A failed load (offline, blocked) shouldn't poison later attempts.
  return loading.then(m => { if (!m) loading = null; return m })
}

// ── Places ─────────────────────────────────────────────────────────────────────

export interface PlaceResult {
  id: string
  /** Short label stored on trips, e.g. "Allston, Boston, MA". */
  label: string
  /** Full address, shown as the secondary line. */
  detail: string
  /** NaN until `resolve()` is called, for autocomplete predictions. */
  lat: number
  lng: number
  /** Street-level (house number, building or named place) rather than a city or region. */
  exact?: boolean
  /** Autocomplete predictions carry no coordinates; this fetches them on selection. */
  resolve?: () => Promise<PlaceResult>
}

type NominatimResult = {
  place_id: number; display_name: string; name: string; lat: string; lon: string
  class?: string; type?: string
  address?: { city?: string; town?: string; village?: string; state?: string; house_number?: string }
}

const EXACT_TYPES = new Set([
  "street_address", "premise", "subpremise", "establishment", "point_of_interest",
  "airport", "university", "school", "hospital", "train_station", "transit_station",
  "shopping_mall", "park", "church", "place_of_worship", "stadium", "lodging",
])

/** True when a Google result pins a specific address or place, not an area. */
function isExactGoogle(types: string[], components: { types: string[] }[] = []): boolean {
  if (types.some(t => EXACT_TYPES.has(t))) return true
  return components.some(c => c.types.includes("street_number"))
}

function isExactNominatim(r: NominatimResult): boolean {
  if (r.address?.house_number) return true
  return ["amenity", "shop", "tourism", "aeroway", "building", "leisure", "office", "railway"].includes(r.class ?? "")
}

function nominatimLabel(r: NominatimResult): string {
  const a = r.address ?? {}
  const parts = [r.name || r.display_name.split(",")[0]]
  const city = a.city ?? a.town ?? a.village
  if (city) parts.push(city)
  if (a.state) parts.push(a.state)
  return formatPlace(parts.filter(Boolean).join(", "))
}

function googleLabel(r: google.maps.GeocoderResult): string {
  const get = (type: string) => r.address_components.find(c => c.types.includes(type))
  const head = get("point_of_interest")?.long_name ?? get("premise")?.long_name
    ?? [get("street_number")?.long_name, get("route")?.long_name].filter(Boolean).join(" ")
  const city = (get("locality") ?? get("sublocality") ?? get("postal_town"))?.long_name
  const state = get("administrative_area_level_1")?.short_name
  const parts = [head || r.formatted_address.split(",")[0]]
  if (city && city !== parts[0]) parts.push(city)
  if (state) parts.push(state)
  return formatPlace(parts.join(", "))
}

/**
 * Google Places autocomplete (as-you-type address suggestions). Predictions
 * have no coordinates yet; `resolve()` fetches them when the user picks one.
 * Returns null when Places isn't available so callers can fall back to
 * `searchPlaces`.
 */
export async function autocompletePlaces(query: string, near?: { lat: number; lng: number } | null): Promise<PlaceResult[] | null> {
  const maps = await loadGoogleMaps()
  const places = maps?.places as (typeof google.maps.places & { AutocompleteSuggestion?: any }) | undefined
  if (!maps || !places?.AutocompleteSuggestion) return null
  try {
    const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: query,
      locationBias: near ? { center: near, radius: 50_000 } : undefined,
    })
    return (suggestions as { placePrediction: any }[]).filter(s => s.placePrediction).slice(0, 6).map(({ placePrediction: p }) => {
      const base: PlaceResult = {
        id: p.placeId,
        label: formatPlace(p.mainText?.text ? [p.mainText.text, p.secondaryText?.text].filter(Boolean).join(", ") : p.text.text),
        detail: p.text.text, lat: NaN, lng: NaN,
        exact: isExactGoogle(p.types ?? []),
      }
      base.resolve = async () => {
        const place = p.toPlace()
        await place.fetchFields({ fields: ["location", "addressComponents", "types"] })
        const comps = (place.addressComponents ?? []).map((c: { types: string[] }) => ({ types: c.types }))
        return {
          ...base, lat: place.location.lat(), lng: place.location.lng(),
          exact: isExactGoogle(place.types ?? p.types ?? [], comps), resolve: undefined,
        }
      }
      return base
    })
  } catch {
    return null
  }
}

/** Forward geocode, biased (not restricted) toward `near` when given. */
export async function searchPlaces(query: string, near?: { lat: number; lng: number } | null): Promise<PlaceResult[]> {
  const maps = await loadGoogleMaps()
  if (maps) {
    try {
      const { results } = await new maps.Geocoder().geocode({
        address: query,
        bounds: near ? { north: near.lat + 1, south: near.lat - 1, east: near.lng + 1, west: near.lng - 1 } : undefined,
      })
      return results.slice(0, 6).map(r => ({
        id: r.place_id, label: googleLabel(r), detail: r.formatted_address,
        lat: r.geometry.location.lat(), lng: r.geometry.location.lng(),
        exact: isExactGoogle(r.types, r.address_components),
      }))
    } catch (e) {
      // ZERO_RESULTS is a real answer; anything else (key/API problems) falls through.
      if ((e as { code?: string }).code === "ZERO_RESULTS") return []
    }
  }
  const viewbox = near ? `&viewbox=${near.lng - 1},${near.lat + 1},${near.lng + 1},${near.lat - 1}` : ""
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6&addressdetails=1${viewbox}`,
    { headers: { "Accept-Language": "en" } },
  )
  const data: NominatimResult[] = await res.json()
  return data.map(r => ({
    id: String(r.place_id), label: nominatimLabel(r), detail: r.display_name,
    lat: parseFloat(r.lat), lng: parseFloat(r.lon), exact: isExactNominatim(r),
  }))
}

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const maps = await loadGoogleMaps()
  if (maps) {
    try {
      const { results } = await new maps.Geocoder().geocode({ location: { lat, lng } })
      if (results[0]) return googleLabel(results[0])
    } catch { /* fall through to Nominatim */ }
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { "Accept-Language": "en" } },
    )
    return nominatimLabel(await res.json()) || "My location"
  } catch {
    return "My location"
  }
}

// ── Routing ────────────────────────────────────────────────────────────────────

export interface LineString {
  type: "LineString"
  coordinates: number[][]
}

export interface RouteGeometry {
  distanceMeters: number
  durationSeconds: number
  geometry: LineString
}

export async function fetchRoute(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<RouteGeometry | null> {
  const maps = await loadGoogleMaps()
  if (maps) {
    try {
      const res = await new maps.DirectionsService().route({
        origin: { lat: fromLat, lng: fromLng },
        destination: { lat: toLat, lng: toLng },
        travelMode: maps.TravelMode.DRIVING,
      })
      const route = res.routes[0]
      if (route) {
        const leg = route.legs[0]
        return {
          distanceMeters: leg.distance?.value ?? 0,
          durationSeconds: leg.duration?.value ?? 0,
          geometry: { type: "LineString", coordinates: route.overview_path.map(p => [p.lng(), p.lat()]) },
        }
      }
    } catch { /* fall through to OSRM */ }
  }
  try {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`,
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
  } catch { /* no route */ }
  return null
}
