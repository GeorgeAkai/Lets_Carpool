import React, {
  useState, useMemo, useEffect, useCallback, useRef, useContext, type CSSProperties,
  useId,
} from 'react'
import {
  MapPin, Calendar, Users, Car, Search, ArrowRight, MessageCircle,
  Check, X, Fuel, ChevronRight, Home as HomeIcon, Dot, Bell, LogOut,
  Send, MoreHorizontal, Flag, UserX, UserPlus,
  ClipboardList, Shield, Map, Package, Camera, Moon, Sun,
  ChevronLeft, Copy, Settings2, ShieldCheck, User as UserIcon, Archive,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AuthUIContext } from '@neondatabase/neon-js/auth/react'
import { useTheme } from '@neondatabase/auth-ui'
import * as api from '../api'
import type { ApiUser, WsMessage } from '../api'
import { MapView } from '../MapView'
import type { TripRoute, DrivingTarget } from '../MapView'
import { PoolView } from '../PoolView'
import { authClient, fetchNeonJWT } from '../lib/auth'
import { useIsMobile } from '../lib/useIsMobile'
import { formatPlace } from '../lib/places'
import { isSuperadmin } from './admin'
import {
  MobileSearchBar, MobileFilterBar, FilterSheet, MobileListingCard, SectionHeader,
  ViewToggleFab, OfferRideFab,
} from './discover-mobile'

// ─── Types ───────────────────────────────────────────────────────────────────

type View = 'home' | 'feed' | 'post' | 'my-listings' | 'connections' | 'notifications' | 'profile' | 'map' | 'pools'
type ListingType = 'driver' | 'rider'
export type RideTag = 'airport' | 'student' | 'church' | 'college' | 'work' | 'event'
export type LuggageSize = 'none' | 'small' | 'medium' | 'large' | 'oversized'
export type CarType = 'sedan' | 'suv' | 'van' | 'minivan' | 'truck' | 'other'
export type Flexibility = 'morning' | 'afternoon' | 'evening' | 'flexible'
type ConnStatus = 'pending' | 'accepted' | 'declined' | 'completed' | 'cancelled' | 'expired'

export interface Listing {
  id: string; type: ListingType; apiId: string; ownerId: string
  user: { name: string; initials: string; verified: boolean; photoUrl?: string | null }
  from: string; to: string; date: string; flexibility: Flexibility
  seats?: number; seatsUsed?: number; passengers?: number; estimatedGas?: number
  tags: RideTag[]; vehicle?: string; carType?: CarType; luggageSize?: LuggageSize
  luggageCapacity?: LuggageSize; status: 'open' | 'matched'; postedAt: string
}

export interface MyListing {
  id: string; type: ListingType; from: string; to: string; date: string
  flexibility: Flexibility; seats?: number; seatsReserved?: number; passengers?: number; tags: RideTag[]
  status: string; createdAt: string
  // Own listings come back with exact coordinates, which "Re-book / Clone"
  // reuses to pre-fill the post form without re-geocoding.
  pickupLat?: number; pickupLng?: number; destLat?: number; destLng?: number
  carType?: CarType; luggage?: LuggageSize
}

// Values the post form can be pre-filled with (from "Re-book / Clone").
export interface PostPrefill {
  key: string; type: ListingType
  from: LocationValue | null; to: LocationValue | null
  flexibility: Flexibility; seats?: number; passengers?: number; tags: RideTag[]
  carType?: CarType; luggage?: LuggageSize
}

interface Connection {
  id: string
  withUser: { name: string; initials: string; photoUrl: string | null }
  withUserId: string
  initiatorUserId: string | null
  myRole: 'rider' | 'driver'
  route: string
  from: string
  to: string
  date: string
  status: ConnStatus
  splitConfirmed: boolean
  unreadMessages: number
  driverTripId: string
  rideRequestId: string
  pickupLat?: number; pickupLng?: number; pickupLabel?: string
  destLat?: number; destLng?: number; destLabel?: string
  riderPickupLat?: number; riderPickupLng?: number; riderPickupLabel?: string
  lastMessage?: { content: string; createdAt: string; senderId: string } | null
}

interface LocationValue {
  label: string
  lat: number
  lng: number
}

// ─── Location autocomplete ────────────────────────────────────────────────────

interface NominatimResult {
  place_id: number
  display_name: string
  name: string
  lat: string
  lon: string
  address?: { city?: string; town?: string; village?: string; state?: string; country?: string }
}

function shortLabel(r: NominatimResult): string {
  const parts = [r.name || r.display_name.split(',')[0]]
  const a = r.address ?? {}
  const city = a.city ?? a.town ?? a.village
  if (city) parts.push(city)
  if (a.state) parts.push(a.state)
  return parts.filter(Boolean).join(', ')
}

function LocationInput({
  label, value, onChange, placeholder, required,
}: {
  label: string
  value: LocationValue | null
  onChange: (v: LocationValue | null) => void
  placeholder: string
  required?: boolean
}) {
  const [query, setQuery] = useState(value?.label ?? '')
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  useEffect(() => {
    setQuery(value?.label ?? '')
  }, [value?.label])

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) { setSuggestions([]); setOpen(false); return }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=1`,
          { headers: { 'Accept-Language': 'en' } },
        )
        const data: NominatimResult[] = await res.json()
        setSuggestions(data)
        setOpen(data.length > 0)
      } catch { /* network error — silently ignore */ } finally {
        setLoading(false)
      }
    }, 350)
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const select = (r: NominatimResult) => {
    const lbl = shortLabel(r)
    setQuery(lbl)
    onChange({ label: lbl, lat: parseFloat(r.lat), lng: parseFloat(r.lon) })
    setOpen(false)
    setSuggestions([])
  }

  return (
    <div ref={containerRef} className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          required={required}
          placeholder={placeholder}
          value={query}
          autoComplete="off"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          onChange={e => {
            setQuery(e.target.value)
            onChange(null)
            search(e.target.value)
          }}
          onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
          className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors text-foreground placeholder:text-muted-foreground"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 size-3.5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        )}
        {open && suggestions.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute z-50 top-full mt-1.5 w-full bg-card border border-border rounded-2xl shadow-xl overflow-hidden"
          >
            {suggestions.map(r => (
              <li key={r.place_id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={e => { e.preventDefault(); select(r) }}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-muted transition-colors flex items-start gap-3"
                >
                  <MapPin className="size-3.5 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{shortLabel(r)}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{r.display_name}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const FLEX_LABEL: Record<Flexibility, string> = {
  morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', flexible: 'Flexible',
}

const CANNED_MESSAGES: Record<string, string> = {
  timing: 'Can we coordinate the exact timing?',
  pickup: 'Can we confirm the pickup area?',
  luggage: 'I have a luggage question.',
}

export const LUGGAGE_LABELS: Record<LuggageSize, string> = {
  none: 'No luggage', small: 'Small bag', medium: 'Medium bag', large: 'Large bag', oversized: 'Oversized',
}

export const CAR_TYPE_LABELS: Record<CarType, string> = {
  sedan: 'Sedan', suv: 'SUV', van: 'Van', minivan: 'Minivan', truck: 'Truck', other: 'Other',
}

export const CAR_TYPE_EMOJI: Record<CarType, string> = {
  sedan: '🚗', suv: '🚙', van: '🚐', minivan: '🚐', truck: '🚚', other: '🚗',
}

export const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }
export const MONO: CSSProperties = { fontFamily: "'DM Mono', monospace" }

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function toInitials(name: string): string {
  return name.split(' ').map(w => w[0]?.toUpperCase() ?? '').join('').slice(0, 2)
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function apiFlexibility(f: string): Flexibility {
  return (['morning', 'afternoon', 'evening', 'flexible'].includes(f) ? f : 'flexible') as Flexibility
}

const VALID_RIDE_TAGS = new Set(['airport', 'student', 'church', 'college', 'work', 'event'])

function tripToListing(trip: api.ApiDriverTrip): Listing {
  const name = trip.driver_name ?? 'Driver'
  return {
    id: trip.id, type: 'driver', apiId: trip.id, ownerId: trip.driver_id,
    user: { name, initials: toInitials(name), verified: false, photoUrl: trip.driver_photo_url },
    from: formatPlace(trip.pickup.label), to: formatPlace(trip.destination.label),
    date: trip.target_date, flexibility: apiFlexibility(trip.flexibility),
    seats: trip.seats_available, seatsUsed: trip.seats_reserved,
    tags: trip.tags.filter((t): t is RideTag => VALID_RIDE_TAGS.has(t)),
    carType: (trip.car_type as CarType) ?? undefined,
    luggageCapacity: (trip.luggage_capacity as LuggageSize) ?? undefined,
    status: trip.status === 'open' ? 'open' : 'matched',
    postedAt: relativeTime(trip.created_at),
  }
}

function requestToListing(req: api.ApiRideRequest): Listing {
  const name = req.rider_name ?? 'Rider'
  return {
    id: req.id, type: 'rider', apiId: req.id, ownerId: req.rider_id,
    user: { name, initials: toInitials(name), verified: false, photoUrl: req.rider_photo_url },
    from: formatPlace(req.pickup.label), to: formatPlace(req.destination.label),
    date: req.target_date, flexibility: apiFlexibility(req.flexibility),
    passengers: req.passenger_count,
    tags: req.tags.filter((t): t is RideTag => VALID_RIDE_TAGS.has(t)),
    luggageSize: (req.luggage_size as LuggageSize) ?? undefined,
    status: req.status === 'open' ? 'open' : 'matched',
    postedAt: relativeTime(req.created_at),
  }
}

function tripToMyListing(trip: api.ApiDriverTrip): MyListing {
  return {
    id: trip.id, type: 'driver',
    from: formatPlace(trip.pickup.label), to: formatPlace(trip.destination.label),
    date: trip.target_date, flexibility: apiFlexibility(trip.flexibility),
    seats: trip.seats_available, seatsReserved: trip.seats_reserved,
    tags: trip.tags.filter((t): t is RideTag => VALID_RIDE_TAGS.has(t)),
    status: trip.status, createdAt: trip.created_at,
    pickupLat: trip.pickup.latitude, pickupLng: trip.pickup.longitude,
    destLat: trip.destination.latitude, destLng: trip.destination.longitude,
    carType: (trip.car_type as CarType) ?? undefined, luggage: (trip.luggage_capacity as LuggageSize) ?? undefined,
  }
}

function requestToMyListing(req: api.ApiRideRequest): MyListing {
  return {
    id: req.id, type: 'rider',
    from: formatPlace(req.pickup.label), to: formatPlace(req.destination.label),
    date: req.target_date, flexibility: apiFlexibility(req.flexibility),
    passengers: req.passenger_count,
    tags: req.tags.filter((t): t is RideTag => VALID_RIDE_TAGS.has(t)),
    status: req.status, createdAt: req.created_at,
    pickupLat: req.pickup.latitude, pickupLng: req.pickup.longitude,
    destLat: req.destination.latitude, destLng: req.destination.longitude,
    luggage: (req.luggage_size as LuggageSize) ?? undefined,
  }
}

function todayLocalISO(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Upcoming = still bookable (open/matched) and not already in the past;
// everything else (cancelled, completed, expired, or a stale date) is archive.
function isActiveListing(l: MyListing): boolean {
  return (l.status === 'open' || l.status === 'matched') && l.date >= todayLocalISO()
}

function apiConnectionToConnection(conn: api.ApiConnection, currentUserId: string): Connection {
  const isDriver = conn.driver_trip.driver_id === currentUserId
  const withUserId = isDriver ? conn.ride_request.rider_id : conn.driver_trip.driver_id
  const profile = isDriver ? conn.rider_profile : conn.driver_profile
  const otherName = profile?.display_name ?? (isDriver ? 'Rider' : 'Driver')
  const trip = conn.driver_trip
  const from = formatPlace(trip.pickup.label)
  const to = formatPlace(trip.destination.label)
  return {
    id: conn.id,
    withUser: { name: otherName, initials: toInitials(otherName), photoUrl: profile?.photo_url ?? null },
    withUserId,
    initiatorUserId: conn.initiator_user_id ?? null,
    myRole: isDriver ? 'driver' : 'rider',
    route: `${from} ➔ ${to}`, from, to,
    date: trip.target_date,
    status: conn.status as ConnStatus,
    splitConfirmed: false, unreadMessages: 0,
    driverTripId: conn.driver_trip_id, rideRequestId: conn.ride_request_id,
    pickupLat: trip.pickup.latitude,
    pickupLng: trip.pickup.longitude,
    pickupLabel: from,
    destLat: trip.destination.latitude,
    destLng: trip.destination.longitude,
    destLabel: to,
    riderPickupLat: conn.ride_request.pickup.latitude,
    riderPickupLng: conn.ride_request.pickup.longitude,
    riderPickupLabel: formatPlace(conn.ride_request.pickup.label),
  }
}

// ─── Small utility components ─────────────────────────────────────────────────

export function Avatar({ initials, size = 'md', photoUrl }: { initials: string; size?: 'sm' | 'md' | 'lg'; photoUrl?: string | null }) {
  const cls = { sm: 'size-7 text-xs', md: 'size-9 text-sm', lg: 'size-14 text-xl' }[size]
  if (photoUrl) {
    return <img src={photoUrl} alt={initials} className={`${cls} rounded-full object-cover shrink-0 ring-1 ring-border`} />
  }
  return (
    <div style={MONO} className={`${cls} rounded-full bg-secondary text-secondary-foreground font-semibold flex items-center justify-center shrink-0`}>
      {initials}
    </div>
  )
}

function SeatDots({ total, used }: { total: number; used: number }) {
  return (
    <span className="flex gap-0.5 items-center">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`size-2 rounded-full ${i < used ? 'bg-muted-foreground/40' : 'bg-primary'}`} />
      ))}
    </span>
  )
}

function TagPill({ tag }: { tag: RideTag }) {
  return <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{tag}</span>
}

function ConnStatusBadge({ status }: { status: ConnStatus }) {
  const cfg: Record<ConnStatus, { label: string; cls: string }> = {
    pending:   { label: 'Pending',   cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
    accepted:  { label: 'Accepted',  cls: 'bg-green-500/15 text-green-700 dark:text-green-400' },
    declined:  { label: 'Declined',  cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
    completed: { label: 'Completed', cls: 'bg-muted text-muted-foreground' },
    cancelled: { label: 'Cancelled', cls: 'bg-muted text-muted-foreground' },
    expired:   { label: 'Expired',   cls: 'bg-muted text-muted-foreground' },
  }
  const { label, cls } = cfg[status]
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
}

function ListingStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    open:      'bg-green-500/15 text-green-700 dark:text-green-400',
    matched:   'bg-primary/10 text-primary',
    expired:   'bg-muted text-muted-foreground',
    cancelled: 'bg-red-500/10 text-red-600 dark:text-red-400',
    completed: 'bg-muted text-muted-foreground',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function Toast({ toast }: { toast: { message: string; type: 'success' | 'error' } | null }) {
  if (!toast) return null
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-2xl shadow-lg text-sm font-medium transition-all ${
      toast.type === 'success' ? 'bg-primary text-primary-foreground' : 'bg-destructive text-white'
    }`}>
      {toast.message}
    </div>
  )
}

// ─── Listing card ─────────────────────────────────────────────────────────────

function ListingCard({ listing, onConnect, currentUserId }: { listing: Listing; onConnect: (l: Listing) => void; currentUserId: string }) {
  const isDriver = listing.type === 'driver'
  const freeSeats = isDriver ? (listing.seats! - (listing.seatsUsed ?? 0)) : 0
  const isOwn = listing.ownerId === currentUserId
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className="bg-card rounded-2xl border border-border p-5 flex flex-col gap-4 hover:shadow-lg hover:shadow-foreground/5 transition-shadow group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar initials={listing.user.initials} photoUrl={listing.user.photoUrl} />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">{listing.user.name}</span>
              {listing.user.verified && (
                <span className="size-4 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Check className="size-2.5 text-primary" />
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{listing.postedAt}</span>
          </div>
        </div>
        {isOwn ? (
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 bg-secondary text-secondary-foreground">Your Listing</span>
        ) : (
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full shrink-0 ${isDriver ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-amber-700'}`}>
            {isDriver ? 'Offering ride' : 'Needs ride'}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">{listing.from}</span>
          <ArrowRight className="size-3 text-muted-foreground shrink-0" />
          <span className="font-semibold text-foreground">{listing.to}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground pl-5">
          <Calendar className="size-3" /><span>{listing.date}</span>
          <Dot className="size-3" /><span>{FLEX_LABEL[listing.flexibility]}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        {isDriver ? (
          <span className="flex items-center gap-1.5">
            <SeatDots total={listing.seats!} used={listing.seatsUsed!} />
            <span><span style={MONO} className="text-foreground font-medium">{freeSeats}</span>{' of '}{listing.seats} seats free</span>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Users className="size-3" />
            {listing.passengers} passenger{(listing.passengers ?? 0) > 1 ? 's' : ''}
          </span>
        )}
        {listing.estimatedGas != null && (
          <><span className="text-border">·</span>
          <span className="flex items-center gap-1"><Fuel className="size-3" />~<span style={MONO} className="text-foreground font-medium">${listing.estimatedGas}</span>/person</span></>
        )}
        {isDriver && listing.carType && (
          <><span className="text-border">·</span>
          <span className="flex items-center gap-1"><span>{CAR_TYPE_EMOJI[listing.carType]}</span>{CAR_TYPE_LABELS[listing.carType]}</span></>
        )}
        {isDriver && listing.vehicle && !listing.carType && (
          <><span className="text-border">·</span>
          <span className="flex items-center gap-1"><Car className="size-3" />{listing.vehicle}</span></>
        )}
        {isDriver && listing.luggageCapacity && listing.luggageCapacity !== 'none' && (
          <><span className="text-border">·</span>
          <span className="flex items-center gap-1"><Package className="size-3" />Up to {LUGGAGE_LABELS[listing.luggageCapacity]}</span></>
        )}
        {!isDriver && listing.luggageSize && listing.luggageSize !== 'none' && (
          <><span className="text-border">·</span>
          <span className="flex items-center gap-1"><Package className="size-3" />{LUGGAGE_LABELS[listing.luggageSize]}</span></>
        )}
      </div>

      {listing.tags.length > 0 && (
        <div className="flex gap-1.5">{listing.tags.map(tag => <TagPill key={tag} tag={tag} />)}</div>
      )}

      {isOwn ? (
        <div className="mt-auto w-full py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-medium flex items-center justify-center gap-2">
          Manage it in My Rides
        </div>
      ) : (
        <button
          onClick={() => onConnect(listing)}
          className="mt-auto w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
        >
          {isDriver ? 'Request Ride' : 'Offer Ride'}
          <ChevronRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
        </button>
      )}
    </motion.div>
  )
}

// ─── Algorithmic match ranking ─────────────────────────────────────────────────
//
// Ranks candidates using only signals that are actually available pre-connection:
// shared profile interests, verified status, and — when the current user already
// has an open listing of their own — closeness of target date and flexibility
// window to it. Exact pickup coordinates are deliberately withheld pre-connection
// (see the location privacy model), so this does not fabricate a distance/ETA
// figure the way a full route-corridor match would.

function flexibilityCloseness(a: Flexibility, b: Flexibility): number {
  if (a === b) return 1
  if (a === 'flexible' || b === 'flexible') return 0.6
  return 0.2
}

function dateCloseness(a: string, b: string): number {
  const diffDays = Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
  if (Number.isNaN(diffDays)) return 0.5
  if (diffDays === 0) return 1
  if (diffDays <= 1) return 0.7
  if (diffDays <= 3) return 0.4
  return 0.1
}

interface EnrichedMatch {
  listing: Listing
  profile: api.ApiPublicProfile | null
  sharedInterests: string[]
  score: number
}

function useRankedMatches(
  candidates: Listing[], referenceListing: MyListing | undefined,
  currentUserId: string, currentUserInterests: string[],
): { matches: EnrichedMatch[]; loading: boolean } {
  const [matches, setMatches] = useState<EnrichedMatch[]>([])
  const [loading, setLoading] = useState(false)
  const candidateKey = candidates.map(c => c.id).join(',')

  useEffect(() => {
    let cancelled = false
    const pool = candidates.filter(c => c.ownerId !== currentUserId && c.status === 'open')
    if (pool.length === 0) { setMatches([]); return }

    const preScored = pool.map(listing => {
      const windowScore = referenceListing
        ? 0.6 * dateCloseness(listing.date, referenceListing.date) + 0.4 * flexibilityCloseness(listing.flexibility, referenceListing.flexibility)
        : 0.5
      return { listing, windowScore }
    }).sort((a, b) => b.windowScore - a.windowScore).slice(0, 8)

    setLoading(true)
    Promise.all(preScored.map(({ listing }) => api.getUserProfile(listing.ownerId).catch(() => null)))
      .then(profiles => {
        if (cancelled) return
        const lowerMine = new Set(currentUserInterests.map(i => i.toLowerCase()))
        const enriched: EnrichedMatch[] = preScored.map(({ listing, windowScore }, i) => {
          const profile = profiles[i]
          const sharedInterests = (profile?.interests ?? []).filter(t => lowerMine.has(t.toLowerCase()))
          const interestScore = Math.min(sharedInterests.length / 3, 1)
          const verifiedScore = profile?.photo_verified ? 1 : 0
          const score = 0.45 * windowScore + 0.4 * interestScore + 0.15 * verifiedScore
          return { listing, profile, sharedInterests, score }
        }).sort((a, b) => b.score - a.score)
        setMatches(enriched.slice(0, 3))
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, referenceListing?.id, currentUserId])

  return { matches, loading }
}

function UserMenuButton({ targetUserId, showToast }: { targetUserId: string; showToast: (msg: string, type: 'success' | 'error') => void }) {
  const [open, setOpen] = useState(false)
  const [reportMode, setReportMode] = useState(false)
  const [reason, setReason] = useState('')

  const handleBlock = async () => {
    try { await api.blockUser(targetUserId); showToast('User blocked', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to block', 'error') }
    finally { setOpen(false) }
  }
  const handleReport = async () => {
    if (!reason.trim()) return
    try { await api.reportUser(targetUserId, reason.trim()); showToast('Report submitted', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to report', 'error') }
    finally { setOpen(false); setReportMode(false); setReason('') }
  }

  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen(v => !v)} aria-label="More actions" className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-20 w-48 bg-card border border-border rounded-2xl shadow-lg p-2 space-y-1">
          {!reportMode ? (
            <>
              <button onClick={handleBlock} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-sm text-foreground hover:bg-muted transition-colors"><UserX className="size-3.5" />Block</button>
              <button onClick={() => setReportMode(true)} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-sm text-foreground hover:bg-muted transition-colors"><Flag className="size-3.5" />Report</button>
            </>
          ) : (
            <div className="space-y-1.5 p-1">
              <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason…" className="w-full px-2.5 py-1.5 rounded-lg bg-input-background border border-transparent text-xs focus:outline-none focus:ring-2 focus:ring-ring/20" />
              <div className="flex gap-1.5">
                <button onClick={handleReport} className="flex-1 px-2 py-1.5 rounded-lg bg-destructive text-white text-xs font-medium">Submit</button>
                <button onClick={() => { setReportMode(false); setOpen(false) }} className="px-2 py-1.5 rounded-lg border border-border text-xs text-muted-foreground">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MatchCard({ match, rank, onConnect, showToast }: {
  match: EnrichedMatch; rank: number
  onConnect: (l: Listing) => Promise<void>; showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const { listing, profile, sharedInterests } = match
  const isDriverListing = listing.type === 'driver'
  const freeSeats = isDriverListing ? (listing.seats! - (listing.seatsUsed ?? 0)) : null
  const [expanded, setExpanded] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const name = profile?.display_name ?? listing.user.name
  const initials = toInitials(name)

  const handleRequest = async () => {
    setRequesting(true)
    try { await onConnect(listing); showToast('Match requested!', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to connect', 'error') }
    finally { setRequesting(false) }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: rank * 0.05 }}
      className="relative bg-card rounded-[1.25rem] border border-border p-5 flex flex-col gap-4"
    >
      {rank === 0 && (
        <span className="absolute -top-2.5 left-5 bg-primary text-primary-foreground text-[10px] font-bold px-2.5 py-1 rounded-full tracking-wide">TOP MATCH</span>
      )}
      <div className="flex items-start justify-between gap-3 mt-1">
        <div className="flex items-center gap-3 min-w-0">
          {profile?.photo_url ? (
            <img src={profile.photo_url} alt="" className="size-11 rounded-full object-cover ring-1 ring-border shrink-0" />
          ) : (
            <div style={MONO} className="size-11 rounded-full bg-secondary text-secondary-foreground font-semibold flex items-center justify-center shrink-0">{initials}</div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold truncate">{name}</span>
              {profile?.photo_verified && (
                <span className="size-4 rounded-full bg-green-500 flex items-center justify-center shrink-0"><Check className="size-2.5 text-white" /></span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {profile?.nationality && <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{profile.nationality}</span>}
              {sharedInterests.slice(0, 2).map(tag => (
                <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{tag}</span>
              ))}
            </div>
          </div>
        </div>
        <UserMenuButton targetUserId={listing.ownerId} showToast={showToast} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground truncate">{listing.from}</span>
          <ArrowRight className="size-3 text-muted-foreground shrink-0" />
          <span className="font-semibold text-foreground truncate">{listing.to}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground pl-5">
          <Calendar className="size-3" /><span>{listing.date}</span>
          <Dot className="size-3" /><span>{FLEX_LABEL[listing.flexibility]}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isDriverListing ? (
          <span className="flex items-center gap-1.5"><Users className="size-3.5" /><span style={MONO} className="text-foreground font-medium">{freeSeats}</span> of {listing.seats} seats free</span>
        ) : (
          <span className="flex items-center gap-1.5"><Users className="size-3.5" />{listing.passengers} passenger{(listing.passengers ?? 0) > 1 ? 's' : ''}</span>
        )}
      </div>

      {expanded && (
        <div className="rounded-xl bg-muted/50 p-3 space-y-1.5 text-xs text-muted-foreground">
          {listing.tags.length > 0 && <div className="flex gap-1.5 flex-wrap">{listing.tags.map(t => <TagPill key={t} tag={t} />)}</div>}
          {isDriverListing && listing.carType && <p className="flex items-center gap-1.5"><Car className="size-3" />{CAR_TYPE_EMOJI[listing.carType]} {CAR_TYPE_LABELS[listing.carType]}</p>}
          {isDriverListing && listing.luggageCapacity && listing.luggageCapacity !== 'none' && <p className="flex items-center gap-1.5"><Package className="size-3" />Up to {LUGGAGE_LABELS[listing.luggageCapacity]}</p>}
          {!isDriverListing && listing.luggageSize && listing.luggageSize !== 'none' && <p className="flex items-center gap-1.5"><Package className="size-3" />{LUGGAGE_LABELS[listing.luggageSize]}</p>}
          <p>Posted {listing.postedAt}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={handleRequest} disabled={requesting} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 active:scale-[0.98] transition-all">
          {requesting ? 'Requesting…' : 'Instant Request Match'}
        </button>
        <button onClick={() => setExpanded(v => !v)} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
          {expanded ? 'Hide' : 'View Route'}
        </button>
      </div>
    </motion.div>
  )
}

function BestMatches({ listings, referenceListing, currentUserId, currentUserInterests, onConnect, showToast, onMatchedIds }: {
  listings: Listing[]; referenceListing: MyListing | undefined
  currentUserId: string; currentUserInterests: string[]
  onConnect: (l: Listing) => Promise<void>; showToast: (msg: string, type: 'success' | 'error') => void
  onMatchedIds: (ids: string[]) => void
}) {
  const candidates = useMemo(() => listings.filter(l => l.type === 'driver'), [listings])
  const { matches, loading } = useRankedMatches(candidates, referenceListing, currentUserId, currentUserInterests)

  // Let the parent exclude these from the flat feed below so the same listing
  // doesn't render twice on screen.
  const matchedIdsKey = matches.map(m => m.listing.id).join(',')
  useEffect(() => { onMatchedIds(matches.map(m => m.listing.id)) }, [matchedIdsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!loading && matches.length === 0) return null

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Best matches for you</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Ranked by departure window and what you have in common.</p>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground animate-pulse">Finding your best matches…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {matches.map((m, i) => <MatchCard key={m.listing.id} match={m} rank={i} onConnect={onConnect} showToast={showToast} />)}
        </div>
      )}
    </div>
  )
}

// ─── Driver-mode home ───────────────────────────────────────────────────────────

function DriverHomeView({
  myOpenTrip, listings, currentUserId, currentUserInterests, onConnect, showToast, setView,
  searchQuery, setSearchQuery, filterType, setFilterType, filterTag, setFilterTag,
  filterCarType, setFilterCarType, filterLuggage, setFilterLuggage,
  quickDateFilter, setQuickDateFilter, seatsNeeded, setSeatsNeeded,
  filterSheetOpen, setFilterSheetOpen, hasLocation,
}: {
  hasLocation: boolean
  myOpenTrip: MyListing | undefined; listings: Listing[]
  currentUserId: string; currentUserInterests: string[]
  onConnect: (l: Listing) => Promise<void>; showToast: (msg: string, type: 'success' | 'error') => void
  setView: (v: View) => void
  searchQuery: string; setSearchQuery: (v: string) => void
  filterType: 'all' | 'driver' | 'rider'; setFilterType: (v: 'all' | 'driver' | 'rider') => void
  filterTag: '' | RideTag; setFilterTag: (v: '' | RideTag) => void
  filterCarType: '' | CarType; setFilterCarType: (v: '' | CarType) => void
  filterLuggage: '' | LuggageSize; setFilterLuggage: (v: '' | LuggageSize) => void
  quickDateFilter: 'today' | 'any'; setQuickDateFilter: (v: 'today' | 'any') => void
  seatsNeeded: number | null; setSeatsNeeded: (v: number | null) => void
  filterSheetOpen: boolean; setFilterSheetOpen: (v: boolean) => void
}) {
  const candidates = useMemo(() => listings.filter(l => l.type === 'rider'), [listings])
  const { matches, loading } = useRankedMatches(candidates, myOpenTrip, currentUserId, currentUserInterests)
  const isMobile = useIsMobile()

  // Mobile-only: candidates are always ride requests (type 'rider'), so the
  // vehicle-size filter and rider-facing "seats needed" pill never apply here
  // — applying them would just zero out every result rather than doing
  // anything useful, so they're deliberately left out of this predicate.
  const mobileMatches = useMemo(() => {
    if (!isMobile) return matches
    const todayLocal = todayLocalISO()
    return matches.filter(m => {
      const l = m.listing
      const matchSearch = searchQuery.trim() === '' || l.to.toLowerCase().includes(searchQuery.toLowerCase()) || l.from.toLowerCase().includes(searchQuery.toLowerCase())
      const matchTag = filterTag === '' || l.tags.includes(filterTag)
      const matchLuggage = filterLuggage === '' || l.luggageSize == null || l.luggageSize === 'none' || l.luggageSize === filterLuggage
      const matchDate = quickDateFilter === 'any' || l.date === todayLocal
      return matchSearch && matchTag && matchLuggage && matchDate
    })
  }, [matches, isMobile, searchQuery, filterTag, filterLuggage, quickDateFilter])

  if (isMobile) {
    const activeFilterCount = [filterTag !== '', filterLuggage !== ''].filter(Boolean).length
    return (
      // pb-28 keeps the last card's CTA clear of the floating Map View / + controls.
      <div className="space-y-4 pb-28">
        <MobileSearchBar value={searchQuery} onChange={setSearchQuery} hasLocation={hasLocation} />
        {/* Seats-needed is a rider-side filter; a driver browsing ride requests has no use for it. */}
        <MobileFilterBar
          onOpenFilters={() => setFilterSheetOpen(true)}
          activeCount={activeFilterCount}
          quickDate={quickDateFilter} onQuickDate={setQuickDateFilter}
          seatsNeeded={seatsNeeded} onSeatsNeeded={setSeatsNeeded} showSeats={false}
        />
        {!myOpenTrip && (
          <div className="rounded-3xl border border-dashed border-border p-5 text-center">
            <p className="text-sm text-muted-foreground">You don't have an active trip yet.</p>
            <button onClick={() => setView('post')} className="mt-3 px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Publish a route</button>
          </div>
        )}
        <SectionHeader label="Nearby Riders" count={mobileMatches.length} noun={mobileMatches.length === 1 ? 'rider' : 'riders'} />
        {loading ? (
          <p className="text-sm text-muted-foreground animate-pulse text-center py-10">Finding nearby requests…</p>
        ) : mobileMatches.length > 0 ? (
          <div className="space-y-3">
            {mobileMatches.map(m => (
              <MobileListingCard key={m.listing.id} listing={m.listing} onConnect={l => { onConnect(l).then(() => showToast('Ride offered!', 'success')).catch(e => showToast(e instanceof Error ? e.message : 'Failed', 'error')) }} currentUserId={currentUserId} onEditOwn={() => setView('my-listings')} />
            ))}
          </div>
        ) : (
          <div className="text-center py-16 text-muted-foreground">
            <Search className="size-10 mx-auto mb-4 opacity-20" />
            <p className="font-medium">No ride requests match</p>
            <p className="text-sm mt-1">Try a different destination or fewer filters.</p>
          </div>
        )}
        <FilterSheet
          open={filterSheetOpen} onClose={() => setFilterSheetOpen(false)}
          filterType={filterType} setFilterType={setFilterType}
          filterTag={filterTag} setFilterTag={setFilterTag}
          filterCarType={filterCarType} setFilterCarType={setFilterCarType}
          filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Your route</h1>
        <p className="text-muted-foreground mt-1">Publish where you're driving, then review who wants a seat.</p>
      </div>

      {myOpenTrip ? (
        <div className="rounded-3xl bg-primary text-primary-foreground p-6">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-primary-foreground/70">Active trip</span>
            <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white/15">Open</span>
          </div>
          <div className="flex items-center gap-2 mt-3 text-lg font-semibold">
            <span className="truncate">{myOpenTrip.from}</span>
            <ArrowRight className="size-4 text-primary-foreground/60 shrink-0" />
            <span className="truncate">{myOpenTrip.to}</span>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-primary-foreground/80">
            <span className="flex items-center gap-1.5"><Calendar className="size-3.5" />{myOpenTrip.date}</span>
            <span className="flex items-center gap-1.5"><Users className="size-3.5" />{myOpenTrip.seats} seat{myOpenTrip.seats !== 1 ? 's' : ''}</span>
          </div>
        </div>
      ) : (
        <div className="rounded-3xl border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">You don't have an active trip yet.</p>
          <button onClick={() => setView('post')} className="mt-3 px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Publish a route</button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">Requests along your route</h2>
        {!loading && <span className="text-xs text-muted-foreground">{matches.length} nearby</span>}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground animate-pulse">Finding nearby requests…</p>
      ) : matches.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No ride requests to show yet.</p>
      ) : (
        <div className="space-y-2.5">
          {matches.map(m => {
            const name = m.profile?.display_name ?? m.listing.user.name
            return (
              <div key={m.listing.id} className="bg-card border border-border rounded-2xl p-4 flex items-center gap-3.5">
                {m.profile?.photo_url ? (
                  <img src={m.profile.photo_url} alt="" className="size-10 rounded-full object-cover shrink-0" />
                ) : (
                  <div style={MONO} className="size-10 rounded-full bg-secondary text-secondary-foreground text-sm font-semibold flex items-center justify-center shrink-0">{toInitials(name)}</div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{name}</span>
                    {m.sharedInterests.length > 0 && <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{m.sharedInterests[0]}</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    <span>{m.listing.from}</span> → <span>{m.listing.to}</span> · {m.listing.passengers} passenger{(m.listing.passengers ?? 0) > 1 ? 's' : ''} · {m.listing.date}
                  </p>
                </div>
                <UserMenuButton targetUserId={m.listing.ownerId} showToast={showToast} />
                <button onClick={() => onConnect(m.listing).then(() => showToast('Ride offered!', 'success')).catch(e => showToast(e instanceof Error ? e.message : 'Failed', 'error'))} className="shrink-0 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                  Offer Ride
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Feed view ────────────────────────────────────────────────────────────────

function FeedView({
  searchQuery, setSearchQuery, filterType, setFilterType, filterTag, setFilterTag,
  filterCarType, setFilterCarType, filterLuggage, setFilterLuggage,
  quickDateFilter, setQuickDateFilter, seatsNeeded, setSeatsNeeded,
  filterSheetOpen, setFilterSheetOpen,
  listings, onConnect, loading, currentUserId, setView, hasLocation,
}: {
  hasLocation: boolean
  searchQuery: string; setSearchQuery: (v: string) => void
  filterType: 'all' | 'driver' | 'rider'; setFilterType: (v: 'all' | 'driver' | 'rider') => void
  filterTag: '' | RideTag; setFilterTag: (v: '' | RideTag) => void
  filterCarType: '' | CarType; setFilterCarType: (v: '' | CarType) => void
  filterLuggage: '' | LuggageSize; setFilterLuggage: (v: '' | LuggageSize) => void
  quickDateFilter: 'today' | 'any'; setQuickDateFilter: (v: 'today' | 'any') => void
  seatsNeeded: number | null; setSeatsNeeded: (v: number | null) => void
  filterSheetOpen: boolean; setFilterSheetOpen: (v: boolean) => void
  listings: Listing[]; onConnect: (l: Listing) => void; loading: boolean; currentUserId: string
  setView: (v: View) => void
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const isMobile = useIsMobile()

  if (isMobile) {
    const activeFilterCount = [filterType !== 'all', filterTag !== '', filterCarType !== '', filterLuggage !== ''].filter(Boolean).length
    return (
      // pb-28 keeps the last card's CTA clear of the floating Map View / + controls.
      <div className="space-y-4 pb-28">
        <MobileSearchBar value={searchQuery} onChange={setSearchQuery} hasLocation={hasLocation} />
        <MobileFilterBar
          onOpenFilters={() => setFilterSheetOpen(true)}
          activeCount={activeFilterCount}
          quickDate={quickDateFilter} onQuickDate={setQuickDateFilter}
          seatsNeeded={seatsNeeded} onSeatsNeeded={setSeatsNeeded}
        />
        <SectionHeader
          label={filterType === 'driver' ? 'Nearby Drivers' : filterType === 'rider' ? 'Nearby Riders' : 'Nearby Rides'}
          count={listings.length}
          noun={filterType === 'driver' ? (listings.length === 1 ? 'driver' : 'drivers') : filterType === 'rider' ? (listings.length === 1 ? 'rider' : 'riders') : (listings.length === 1 ? 'ride' : 'rides')}
        />
        {loading ? (
          <p className="text-sm text-muted-foreground animate-pulse text-center py-10">Loading…</p>
        ) : listings.length > 0 ? (
          <div className="space-y-3">
            {listings.map(l => (
              <MobileListingCard key={l.id} listing={l} onConnect={onConnect} currentUserId={currentUserId} onEditOwn={() => setView('my-listings')} />
            ))}
          </div>
        ) : (
          <div className="text-center py-16 text-muted-foreground">
            <Search className="size-10 mx-auto mb-4 opacity-20" />
            <p className="font-medium">No rides match</p>
            <p className="text-sm mt-1">Try a different destination or fewer filters.</p>
          </div>
        )}
        <FilterSheet
          open={filterSheetOpen} onClose={() => setFilterSheetOpen(false)}
          filterType={filterType} setFilterType={setFilterType}
          filterTag={filterTag} setFilterTag={setFilterTag}
          filterCarType={filterCarType} setFilterCarType={setFilterCarType}
          filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="pb-2">
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Find your ride</h1>
        <p className="text-muted-foreground mt-1">Connect with drivers and riders heading your way.</p>
      </div>

      <div className="flex items-center gap-3 rounded-2xl bg-card border border-border px-8 py-6 focus-within:ring-2 focus-within:ring-ring/25 focus-within:border-primary/30 transition-colors">
        <Search className="size-5 shrink-0 text-muted-foreground" />
        <input type="text" placeholder="Search destination, neighborhood…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none pl-2" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'driver', 'rider'] as const).map(t => (
          <button key={t} onClick={() => setFilterType(t)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterType === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
            {t === 'all' ? 'All' : t === 'driver' ? 'Offering rides' : 'Need rides'}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-0.5" />
        {(['', 'airport', 'student', 'church', 'college'] as const).map(tag => (
          <button key={tag} onClick={() => setFilterTag(tag as '' | RideTag)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterTag === tag ? 'bg-accent/20 text-amber-800 ring-1 ring-accent/40' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
            {tag === '' ? 'All tags' : tag.charAt(0).toUpperCase() + tag.slice(1)}
          </button>
        ))}
        <button onClick={() => setShowAdvanced(v => !v)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${showAdvanced ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
          Filters {showAdvanced ? '▲' : '▼'}
        </button>
      </div>

      {showAdvanced && (
        <div className="rounded-2xl bg-muted p-4 space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Vehicle size</p>
            <div className="flex flex-wrap gap-2">
              {(['', 'sedan', 'suv', 'van', 'minivan', 'truck'] as const).map(ct => (
                <button key={ct} onClick={() => setFilterCarType(ct as '' | CarType)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterCarType === ct ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground border border-border'}`}>
                  {ct === '' ? 'Any' : `${CAR_TYPE_EMOJI[ct as CarType]} ${CAR_TYPE_LABELS[ct as CarType]}`}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Luggage I'm bringing</p>
            <div className="flex flex-wrap gap-2">
              {(['', 'small', 'medium', 'large', 'oversized'] as const).map(ls => (
                <button key={ls} onClick={() => setFilterLuggage(ls as '' | LuggageSize)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterLuggage === ls ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground border border-border'}`}>
                  {ls === '' ? 'Any' : LUGGAGE_LABELS[ls as LuggageSize]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {loading ? <span className="animate-pulse">Loading…</span> : (
          <><span style={MONO} className="text-foreground font-medium">{listings.length}</span><span>listing{listings.length !== 1 ? 's' : ''} found</span></>
        )}
      </div>

      {!loading && listings.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {listings.map(l => <ListingCard key={l.id} listing={l} onConnect={onConnect} currentUserId={currentUserId} />)}
        </div>
      ) : !loading ? (
        <div className="text-center py-24 text-muted-foreground">
          <Search className="size-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No listings match</p>
          <p className="text-sm mt-1">Try broadening your filters.</p>
        </div>
      ) : null}
    </div>
  )
}

// ─── Post view ────────────────────────────────────────────────────────────────

function PostView({ onPost, userCoords, defaultType, vehicle: myVehicle, prefill, onClearPrefill }: {
  onPost: (listing: MyListing) => void; userCoords: { lat: number; lng: number } | null
  defaultType: ListingType; vehicle: api.ApiVehicle
  prefill?: PostPrefill | null; onClearPrefill?: () => void
}) {
  const [type, setType] = useState<ListingType>(prefill?.type ?? defaultType)
  const [from, setFrom] = useState<LocationValue | null>(prefill?.from ?? null)
  const [to, setTo] = useState<LocationValue | null>(prefill?.to ?? null)
  const [date, setDate] = useState('')
  const [flexibility, setFlexibility] = useState<Flexibility>(prefill?.flexibility ?? 'morning')
  const [seats, setSeats] = useState(prefill?.seats ? String(prefill.seats) : myVehicle?.seats ? String(myVehicle.seats) : '3')
  const [passengers, setPassengers] = useState(prefill?.passengers ? String(prefill.passengers) : '1')
  const [gasEstimate, setGasEstimate] = useState('')
  const [tags, setTags] = useState<Set<RideTag>>(new Set(prefill?.tags ?? []))
  const [vehicle, setVehicle] = useState(myVehicle ? [myVehicle.color, myVehicle.make, myVehicle.model].filter(Boolean).join(' ') : '')
  const [carType, setCarType] = useState<CarType | ''>(prefill?.carType ?? (myVehicle?.car_type as CarType) ?? '')
  const [luggageSize, setLuggageSize] = useState<LuggageSize>(prefill?.type === 'rider' && prefill.luggage ? prefill.luggage : 'none')
  const [luggageCapacity, setLuggageCapacity] = useState<LuggageSize>(prefill?.type === 'driver' && prefill.luggage ? prefill.luggage : 'medium')
  const [declared, setDeclared] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const autoFilledFromProfile = !!myVehicle

  const toggleTag = (tag: RideTag) => setTags(prev => { const n = new Set(prev); n.has(tag) ? n.delete(tag) : n.add(tag); return n })

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!from || !to) { setError('Please select both pickup and destination from the suggestions'); return }
    setSubmitted(true); setError('')
    try {
      const [pickupLoc, destLoc] = await Promise.all([
        api.createLocation(from.label, from.lat, from.lng),
        api.createLocation(to.label, to.lat, to.lng),
      ])
      if (type === 'driver') {
        const trip = await api.createDriverTrip({
          pickup_location_id: pickupLoc.id, destination_location_id: destLoc.id,
          target_date: date, flexibility, seats_available: parseInt(seats, 10),
          tags: Array.from(tags), car_type: carType || undefined, luggage_capacity: luggageCapacity,
        })
        onPost(tripToMyListing(trip))
      } else {
        const req = await api.createRideRequest({
          pickup_location_id: pickupLoc.id, destination_location_id: destLoc.id,
          target_date: date, flexibility, passenger_count: parseInt(passengers, 10),
          tags: Array.from(tags), luggage_size: luggageSize,
        })
        onPost(requestToMyListing(req))
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to post'); setSubmitted(false) }
  }

  const inputCls = 'w-full px-3 py-2.5 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors'
  const iconInputCls = 'pl-9 ' + inputCls

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-8">
        <h1 style={SERIF} className="text-[2.25rem] xl:text-[2.75rem] leading-tight text-foreground">{prefill ? 'Re-book this ride' : 'Post a listing'}</h1>
        <p className="text-muted-foreground mt-1">
          {prefill ? 'Same route as before — pick a new date and post.' : 'Share your trip or request a ride.'}
          {prefill && onClearPrefill && <button type="button" onClick={onClearPrefill} className="ml-2 text-primary font-medium hover:underline">Start blank</button>}
        </p>
      </div>

      <div className="flex rounded-xl bg-muted p-1 gap-1 mb-8">
        {(['driver', 'rider'] as ListingType[]).map(t => (
          <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${type === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'driver' ? "I'm offering a ride" : 'I need a ride'}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <LocationInput label="From" value={from} onChange={setFrom} placeholder="Your area" required />
          <LocationInput label="To" value={to} onChange={setTo} placeholder="Destination" required />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Date</label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <input required type="date" value={date} onChange={e => setDate(e.target.value)} className={iconInputCls} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Flexibility</label>
            <select value={flexibility} onChange={e => setFlexibility(e.target.value as Flexibility)} className={inputCls}>
              {Object.entries(FLEX_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{type === 'driver' ? 'Seats available' : 'Passengers'}</label>
            <input required type="number" min="1" value={type === 'driver' ? seats : passengers} onChange={e => type === 'driver' ? setSeats(e.target.value) : setPassengers(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Gas split estimate</label>
            <div className="relative">
              <Fuel className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <input value={gasEstimate} onChange={e => setGasEstimate(e.target.value)} placeholder="$ per person" className={iconInputCls} />
            </div>
          </div>
        </div>

        {type === 'driver' && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Vehicle{autoFilledFromProfile && <span className="text-muted-foreground font-normal"> · auto-filled from your profile</span>}
            </label>
            <input value={vehicle} onChange={e => setVehicle(e.target.value)} placeholder="e.g. Subaru Outback '23" className={inputCls} />
          </div>
        )}

        {type === 'driver' && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Vehicle type</label>
            <div className="flex flex-wrap gap-2">
              {(['sedan', 'suv', 'van', 'minivan', 'truck'] as CarType[]).map(ct => (
                <button key={ct} type="button" onClick={() => setCarType(carType === ct ? '' : ct)} className={`px-3 py-2 rounded-xl text-sm font-medium transition-colors ${carType === ct ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                  {CAR_TYPE_EMOJI[ct]} {CAR_TYPE_LABELS[ct]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{type === 'driver' ? 'Max luggage accepted' : "Luggage I'm bringing"}</label>
          <div className="flex flex-wrap gap-2">
            {(['none', 'small', 'medium', 'large', 'oversized'] as LuggageSize[]).map(ls => {
              const current = type === 'driver' ? luggageCapacity : luggageSize
              const setter = type === 'driver' ? setLuggageCapacity : setLuggageSize
              return (
                <button key={ls} type="button" onClick={() => setter(ls)} className={`px-3 py-2 rounded-xl text-sm font-medium transition-colors ${current === ls ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                  {LUGGAGE_LABELS[ls]}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Tags</label>
          <div className="flex gap-2 flex-wrap">
            {(['airport', 'student', 'church', 'college', 'work', 'event'] as RideTag[]).map(tag => (
              <button key={tag} type="button" onClick={() => toggleTag(tag)} className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${tags.has(tag) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                {tag.charAt(0).toUpperCase() + tag.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={declared} onChange={() => setDeclared(v => !v)} className="form-checkbox h-4 w-4 rounded border-border bg-input-background text-primary focus:ring-ring" />
          I confirm the information is accurate.
        </label>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <button type="submit" disabled={submitted} className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">
          {submitted ? 'Posting...' : 'Post listing'}
        </button>
      </form>
    </div>
  )
}

// ─── My Rides view ────────────────────────────────────────────────────────────

type RidesTab = 'active' | 'past' | 'pools'
type RidesTypeFilter = 'all' | ListingType

function MyRideCard({ listing, conversationCount, onManage, onViewMatches, onClone, onCancel }: {
  listing: MyListing; conversationCount: number
  onManage: () => void; onViewMatches: () => void; onClone: () => void; onCancel: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const active = isActiveListing(listing)
  const isDriver = listing.type === 'driver'

  const cancel = async () => {
    setCancelling(true)
    try { await onCancel() } finally { setCancelling(false); setConfirming(false) }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`bg-card rounded-2xl border border-border p-5 flex flex-col gap-4 ${active ? '' : 'opacity-90'}`}>
      <div className="flex items-start justify-between gap-3">
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${isDriver ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-amber-700 dark:text-amber-400'}`}>
          {isDriver ? <Car className="size-3" /> : <Users className="size-3" />}
          {isDriver ? 'Driving' : 'Riding'}
        </span>
        <ListingStatusBadge status={listing.status === 'open' && !active ? 'expired' : listing.status} />
      </div>

      {/* Route: vertical pickup → destination rail */}
      <div className="flex items-stretch gap-3 min-w-0">
        <div className="flex flex-col items-center pt-1.5 pb-1.5">
          <span className="size-2.5 rounded-full border-2 border-primary" />
          <span className="w-px flex-1 bg-border my-1" />
          <span className="size-2.5 rounded-full bg-primary" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-muted-foreground truncate" title={listing.from}>{listing.from}</p>
          <p className="text-base font-semibold text-foreground truncate" title={listing.to}>{listing.to}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Calendar className="size-3" />{listing.date} · {FLEX_LABEL[listing.flexibility]}</span>
        {listing.seats != null && <span className="flex items-center gap-1"><Users className="size-3" />{listing.seats - (listing.seatsReserved ?? 0)} of {listing.seats} seats free</span>}
        {listing.passengers != null && <span className="flex items-center gap-1"><Users className="size-3" />{listing.passengers} passenger{listing.passengers > 1 ? 's' : ''}</span>}
        {conversationCount > 0 && <span className="flex items-center gap-1 text-primary font-medium"><MessageCircle className="size-3" />{conversationCount} conversation{conversationCount > 1 ? 's' : ''}</span>}
      </div>
      {listing.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{listing.tags.map(tag => <TagPill key={tag} tag={tag} />)}</div>}

      <div className="mt-auto pt-1 flex flex-wrap gap-2">
        {active ? (
          <>
            <button onClick={onManage} className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
              <Settings2 className="size-4" />Manage Ride
            </button>
            <button onClick={onViewMatches} className="flex-1 min-w-[8rem] inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
              <Search className="size-4" />View Matches
            </button>
            <div className="w-full flex items-center justify-between gap-2">
              <button onClick={onClone} className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                <Copy className="size-3.5" />Clone
              </button>
              {confirming ? (
                <span className="flex items-center gap-1.5">
                  <button onClick={() => setConfirming(false)} disabled={cancelling} className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted">Keep</button>
                  <button onClick={cancel} disabled={cancelling} className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-destructive text-white disabled:opacity-60">
                    {cancelling ? 'Cancelling…' : 'Confirm cancel'}
                  </button>
                </span>
              ) : (
                <button onClick={() => setConfirming(true)} className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                  <X className="size-3.5" />Cancel Listing
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <button onClick={onClone} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
              <Copy className="size-4" />Re-book
            </button>
            {conversationCount > 0 && (
              <button onClick={onManage} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                <MessageCircle className="size-4" />Conversations
              </button>
            )}
          </>
        )}
      </div>
    </motion.div>
  )
}

function MyListingsView({ myListings, connections, onCancel, onManage, onViewMatches, onClone, onPostNew, userCoords, currentUserId, showToast }: {
  myListings: MyListing[]; connections: Connection[]
  onCancel: (listing: MyListing) => Promise<void>
  onManage: (listing: MyListing) => void; onViewMatches: (listing: MyListing) => void
  onClone: (listing: MyListing) => void; onPostNew: () => void
  userCoords: { lat: number; lng: number } | null; currentUserId: string
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<RidesTab>('active')
  const [typeFilter, setTypeFilter] = useState<RidesTypeFilter>('all')

  const activeListings = useMemo(() => myListings.filter(isActiveListing), [myListings])
  const pastListings = useMemo(() => myListings.filter(l => !isActiveListing(l)), [myListings])
  const source = tab === 'past' ? pastListings : activeListings
  const shown = source.filter(l => typeFilter === 'all' || l.type === typeFilter)
    // Active: soonest first. Past: most recent first.
    .sort((a, b) => tab === 'past' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))

  const conversationCount = (l: MyListing) =>
    connections.filter(c => (l.type === 'driver' ? c.driverTripId : c.rideRequestId) === l.id && inboxBucket(c.status) !== 'archived').length

  // Pools is a standalone Sidebar entry on desktop already — only surface it
  // as a third tab here on mobile, where the bottom nav was trimmed to 4 tabs.
  const tabs: { id: RidesTab; label: string; count?: number }[] = [
    { id: 'active', label: 'Active', count: activeListings.length },
    { id: 'past', label: 'Past / Archive', count: pastListings.length },
    ...(isMobile ? [{ id: 'pools' as const, label: 'Pools' }] : []),
  ]

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 style={SERIF} className="text-[2.25rem] xl:text-[2.75rem] leading-tight text-foreground">My Rides</h1>
          <p className="text-muted-foreground mt-1">Manage your upcoming trips and ride requests.</p>
        </div>
        <button onClick={onPostNew} className="hidden sm:inline-flex shrink-0 items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
          + New listing
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex rounded-xl bg-muted p-1 gap-1" role="tablist">
          {tabs.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${tab === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {t.label}
              {t.count != null && <span className={`text-[11px] tabular-nums ${tab === t.id ? 'text-muted-foreground' : 'opacity-70'}`}>{t.count}</span>}
            </button>
          ))}
        </div>
        {tab !== 'pools' && (
          <div className="flex gap-1.5" role="group" aria-label="Listing type">
            {(['all', 'driver', 'rider'] as const).map(f => (
              <button key={f} aria-pressed={typeFilter === f} onClick={() => setTypeFilter(f)} className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${typeFilter === f ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                {f === 'all' ? 'All' : f === 'driver' ? 'Driver trips' : 'Ride requests'}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'pools' ? (
        <PoolView userCoords={userCoords} currentUserId={currentUserId} showToast={showToast} />
      ) : shown.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground rounded-3xl border border-dashed border-border">
          {tab === 'past' ? <Archive className="size-10 mx-auto mb-4 opacity-20" /> : <ClipboardList className="size-10 mx-auto mb-4 opacity-20" />}
          <p className="font-medium">{tab === 'past' ? 'No past rides yet' : 'No upcoming rides'}</p>
          <p className="text-sm mt-1">{tab === 'past' ? 'Completed, cancelled and expired listings will show up here.' : 'Post a trip or a ride request to get started.'}</p>
          {tab === 'active' && (
            <button onClick={onPostNew} className="mt-4 px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Post a listing</button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {shown.map(listing => (
            <MyRideCard
              key={listing.id} listing={listing} conversationCount={conversationCount(listing)}
              onManage={() => onManage(listing)} onViewMatches={() => onViewMatches(listing)}
              onClone={() => onClone(listing)} onCancel={() => onCancel(listing)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Inbox (master-detail) ────────────────────────────────────────────────────

type InboxFilter = 'all' | 'active' | 'completed' | 'archived'

// Declined/cancelled/expired threads are dead ends — they live under
// "Archived" so the default list only shows conversations that still matter.
function inboxBucket(status: ConnStatus): Exclude<InboxFilter, 'all'> {
  if (status === 'pending' || status === 'accepted') return 'active'
  if (status === 'completed') return 'completed'
  return 'archived'
}

function inboxMatches(filter: InboxFilter, status: ConnStatus): boolean {
  const bucket = inboxBucket(status)
  return filter === 'all' ? bucket !== 'archived' : bucket === filter
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function connectionPreview(c: Connection, currentUserId: string): string {
  if (c.lastMessage) return `${c.lastMessage.senderId === currentUserId ? 'You: ' : ''}${c.lastMessage.content}`
  const iStarted = c.initiatorUserId === currentUserId
  switch (c.status) {
    case 'pending': return iStarted ? 'Request sent — waiting for a reply' : 'New ride request'
    case 'accepted': return 'Chat unlocked — say hi!'
    case 'completed': return 'Ride completed'
    default: return 'No longer active'
  }
}

function ConversationListItem({ connection, selected, currentUserId, onSelect }: {
  connection: Connection; selected: boolean; currentUserId: string; onSelect: () => void
}) {
  const unread = connection.unreadMessages
  return (
    <button
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`w-full text-left px-4 py-3.5 flex gap-3 transition-colors border-l-2 ${selected ? 'bg-primary/5 border-primary' : 'border-transparent hover:bg-muted/60'}`}
    >
      <div className="relative shrink-0">
        <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="md" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{unread > 9 ? '9+' : unread}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm truncate ${unread > 0 ? 'font-bold text-foreground' : 'font-semibold text-foreground'}`}>{connection.withUser.name}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">{connection.lastMessage ? shortTime(connection.lastMessage.createdAt) : connection.date}</span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{connection.from} ➔ {connection.to}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <ConnStatusBadge status={connection.status} />
          <span className={`text-xs truncate ${unread > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{connectionPreview(connection, currentUserId)}</span>
        </div>
      </div>
    </button>
  )
}

function ConversationPane({
  connection, currentUserId, onBack, onAccept, onDecline, onCancel, onComplete, showToast,
  onViewRoute, onStartDriving, onMarkRead, initialPanel, incomingMessage, onMessageSent,
}: {
  connection: Connection; currentUserId: string; onBack?: () => void
  onAccept: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>; onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
  onViewRoute: (conn: Connection) => void; onStartDriving: (conn: Connection) => void
  onMarkRead: (id: string) => void
  initialPanel?: 'gassplit' | null
  incomingMessage: { connectionId: string; message: api.ApiMessage } | null
  onMessageSent: (connectionId: string, message: api.ApiMessage) => void
}) {
  const [panel, setPanel] = useState<'gassplit' | 'safety' | null>(initialPanel ?? null)
  const [msgs, setMsgs] = useState<api.ApiMessage[]>([])
  const [msgsLoaded, setMsgsLoaded] = useState(false)
  const [msgText, setMsgText] = useState('')
  const [sending, setSending] = useState(false)
  const [gasSuggestion, setGasSuggestion] = useState<api.GasSplitSuggestion | null>(null)
  const [splitAmount, setSplitAmount] = useState('')
  const [splitDone, setSplitDone] = useState(connection.splitConfirmed)
  const [reportReason, setReportReason] = useState('')
  const [reportMode, setReportMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const { id: connectionId, status } = connection

  useEffect(() => {
    let cancelled = false
    onMarkRead(connectionId)
    api.getMessages(connectionId)
      .then(fetched => { if (!cancelled) setMsgs(fetched) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setMsgsLoaded(true) })
    return () => { cancelled = true }
  }, [connectionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live messages for the open thread arrive over the WebSocket via Home.
  useEffect(() => {
    if (!incomingMessage || incomingMessage.connectionId !== connectionId) return
    setMsgs(prev => prev.some(m => m.id === incomingMessage.message.id) ? prev : [...prev, incomingMessage.message])
    onMarkRead(connectionId)
  }, [incomingMessage]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length])

  useEffect(() => {
    if (panel !== 'gassplit' || gasSuggestion || status !== 'accepted') return
    api.suggestGasSplit(connectionId)
      .then(s => { setGasSuggestion(s); setSplitAmount((s.amount_cents / 100).toFixed(2)) })
      .catch(() => {})
  }, [panel, gasSuggestion, status, connectionId])

  const appendSent = (msg: api.ApiMessage) => { setMsgs(prev => [...prev, msg]); onMessageSent(connectionId, msg) }

  const sendCanned = async (key: string) => {
    setSending(true)
    try { appendSent(await api.sendCannedMessage(connectionId, key)) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to send', 'error') }
    finally { setSending(false) }
  }

  const sendFree = async () => {
    if (!msgText.trim()) return
    setSending(true)
    try { appendSent(await api.sendMessage(connectionId, msgText.trim())); setMsgText('') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to send', 'error') }
    finally { setSending(false) }
  }

  const confirmSplit = async () => {
    const cents = Math.round(parseFloat(splitAmount) * 100)
    if (isNaN(cents) || cents < 1) return
    try { await api.confirmGasSplit(connectionId, cents, gasSuggestion?.assumptions ?? {}); setSplitDone(true); showToast('Split confirmed ✓', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to confirm', 'error') }
  }

  const run = (fn: (id: string) => Promise<void>, ok: string) => async () => {
    setBusy(true)
    try { await fn(connectionId); showToast(ok, 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') }
    finally { setBusy(false) }
  }
  const handleBlock = async () => {
    try { await api.blockUser(connection.withUserId); showToast('User blocked', 'success'); setPanel(null) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') }
  }
  const handleReport = async () => {
    if (!reportReason.trim()) return
    try { await api.reportUser(connection.withUserId, reportReason.trim()); showToast('Report submitted', 'success'); setReportReason(''); setReportMode(false); setPanel(null) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') }
  }

  const iStarted = connection.initiatorUserId === currentUserId
  const hasRouteCoords = !!(connection.pickupLat && connection.destLat)
  const hasRiderPickupCoords = !!(connection.riderPickupLat && connection.riderPickupLng)
  const btn = 'shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-60'
  const btnOutline = `${btn} border border-border text-foreground hover:bg-muted`

  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      {/* ── Fixed header: who, which trip, and the trip's primary controls ── */}
      <div className="shrink-0 border-b border-border px-4 sm:px-5 pt-4 pb-3 space-y-3">
        <div className="flex items-start gap-3">
          {onBack && (
            <button onClick={onBack} aria-label="Back to conversations" className="p-1.5 -ml-1.5 rounded-lg hover:bg-muted text-muted-foreground"><ChevronLeft className="size-5" /></button>
          )}
          <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-foreground truncate">{connection.withUser.name}</h2>
              <ConnStatusBadge status={status} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {connection.myRole === 'driver' ? "You're driving" : "You're riding"} · {connection.from} ➔ {connection.to}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
              <span className="inline-flex items-center gap-1"><Calendar className="size-3" />{connection.date}</span>
              {splitDone && <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400"><Check className="size-3" />Split confirmed</span>}
            </p>
          </div>
          <button onClick={() => setPanel(panel === 'safety' ? null : 'safety')} aria-label="Safety options" className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><MoreHorizontal className="size-4" /></button>
        </div>

        {(status === 'pending' || status === 'accepted') && (
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {status === 'pending' && !iStarted && (
              <>
                <button onClick={run(onAccept, 'Connection accepted')} disabled={busy} className={`${btn} bg-primary text-primary-foreground font-semibold hover:bg-primary/90`}><Check className="size-4" />Accept</button>
                <button onClick={run(onDecline, 'Connection declined')} disabled={busy} className={btnOutline}><X className="size-4" />Decline</button>
              </>
            )}
            {status === 'pending' && iStarted && (
              <>
                <span className="shrink-0 self-center text-xs text-muted-foreground mr-1">Waiting for {connection.withUser.name} to respond</span>
                <button onClick={run(onCancel, 'Request cancelled')} disabled={busy} className={btnOutline}>Cancel request</button>
              </>
            )}
            {status === 'accepted' && (
              <>
                {connection.myRole === 'driver' && hasRiderPickupCoords && (
                  <button onClick={() => onStartDriving(connection)} className={`${btn} bg-green-600 text-white font-semibold hover:bg-green-700`}><Car className="size-4" />Start Driving</button>
                )}
                {hasRouteCoords && <button onClick={() => onViewRoute(connection)} className={btnOutline}><Map className="size-4" />Route</button>}
                <button onClick={() => setPanel(panel === 'gassplit' ? null : 'gassplit')} aria-pressed={panel === 'gassplit'} className={`${btn} ${panel === 'gassplit' ? 'bg-accent/20 text-amber-800 dark:text-amber-300' : 'border border-border text-foreground hover:bg-muted'}`}><Fuel className="size-4" />Gas Split</button>
                <button onClick={run(onComplete, 'Ride completed!')} disabled={busy} className={btnOutline}><Check className="size-4" />Complete</button>
                <button onClick={run(onCancel, 'Ride cancelled')} disabled={busy} className={`${btn} text-muted-foreground hover:text-destructive hover:bg-destructive/10`}>Cancel</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Collapsible panels ── */}
      {panel === 'gassplit' && status === 'accepted' && (
        <div className="shrink-0 border-b border-border bg-muted/40 px-5 py-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Confirm gas split</p>
          {gasSuggestion ? (
            <>
              <p className="text-sm text-muted-foreground">Suggested: <span style={MONO} className="text-foreground font-medium">${(gasSuggestion.amount_cents / 100).toFixed(2)}</span></p>
              {splitDone ? (
                <p className="text-sm text-green-700 dark:text-green-400 font-medium flex items-center gap-1"><Check className="size-4" />Split confirmed</p>
              ) : (
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1 max-w-[140px]">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                    <input type="number" step="0.01" min="0.01" value={splitAmount} onChange={e => setSplitAmount(e.target.value)} aria-label="Split amount" className="w-full pl-7 pr-3 py-2 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20" />
                  </div>
                  <button onClick={confirmSplit} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Confirm</button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Payment happens outside the app.</p>
            </>
          ) : <p className="text-sm text-muted-foreground animate-pulse">Loading suggestion…</p>}
        </div>
      )}
      {panel === 'safety' && (
        <div className="shrink-0 border-b border-border bg-muted/40 px-5 py-4 space-y-3">
          {!reportMode ? (
            <div className="flex gap-2">
              <button onClick={handleBlock} className={btnOutline}><UserX className="size-4" />Block</button>
              <button onClick={() => setReportMode(true)} className={btnOutline}><Flag className="size-4" />Report</button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Reason</label>
              <input type="text" value={reportReason} onChange={e => setReportReason(e.target.value)} placeholder="Describe the issue…" className="w-full px-3 py-2 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20" />
              <div className="flex gap-2">
                <button onClick={handleReport} disabled={!reportReason.trim()} className="px-3 py-2 rounded-xl bg-destructive text-white text-sm font-medium disabled:opacity-50">Submit</button>
                <button onClick={() => setReportMode(false)} className="px-3 py-2 rounded-xl border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Back</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Scrollable thread ── */}
      <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-2.5 bg-muted/20">
        {!msgsLoaded && <p className="text-xs text-muted-foreground text-center py-6 animate-pulse">Loading messages…</p>}
        {msgsLoaded && msgs.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground py-10">
            <MessageCircle className="size-8 mb-2 opacity-25" />
            <p className="text-sm">No messages yet.</p>
            <p className="text-xs mt-0.5">{status === 'pending' ? 'Send a quick message to coordinate.' : status === 'accepted' ? 'Say hi and sort out the pickup details.' : ''}</p>
          </div>
        )}
        {msgs.map(m => {
          const isMine = m.sender_id === currentUserId
          return (
            <div key={m.id} className={`flex items-end gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
              {!isMine && <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="sm" />}
              <div className={`max-w-[75%] flex flex-col gap-0.5 ${isMine ? 'items-end' : 'items-start'}`}>
                <div className={`px-3.5 py-2 rounded-2xl text-sm leading-snug ${isMine ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-card text-foreground border border-border rounded-bl-sm'}`}>
                  {m.content}
                </div>
                <span className="text-[10px] text-muted-foreground px-1">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Sticky composer ── */}
      <div className="shrink-0 border-t border-border bg-card px-4 sm:px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {status === 'pending' ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Quick messages while the request is pending — full chat unlocks once accepted.</p>
            <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {Object.entries(CANNED_MESSAGES).map(([key, text]) => (
                <button key={key} onClick={() => sendCanned(key)} disabled={sending} className="shrink-0 px-3 py-1.5 rounded-full bg-muted text-sm text-foreground hover:bg-muted/70 disabled:opacity-50 transition-colors">{text}</button>
              ))}
            </div>
          </div>
        ) : status === 'accepted' ? (
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); sendFree() }}>
            <input type="text" value={msgText} onChange={e => setMsgText(e.target.value)} placeholder={`Message ${connection.withUser.name}…`} aria-label="Message" className="flex-1 min-w-0 px-4 py-2.5 rounded-full bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors" />
            <button type="submit" disabled={sending || !msgText.trim()} aria-label="Send message" className="shrink-0 size-10 rounded-full bg-primary text-primary-foreground disabled:opacity-50 flex items-center justify-center transition-colors"><Send className="size-4" /></button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground text-center">This conversation is closed — the ride was {status}.</p>
        )}
      </div>
    </div>
  )
}

function InboxView({
  connections, currentUserId, onAccept, onDecline, onCancel, onComplete, showToast, onViewRoute, onStartDriving,
  onMarkRead, deepLink, onDeepLinkHandled, listingFilter, onClearListingFilter, incomingMessage, onMessageSent,
}: {
  connections: Connection[]; currentUserId: string
  onAccept: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>; onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
  onViewRoute: (conn: Connection) => void
  onStartDriving: (conn: Connection) => void
  onMarkRead: (id: string) => void
  deepLink?: { connectionId: string; section: 'chat' | 'gassplit' } | null
  onDeepLinkHandled: () => void
  listingFilter: { id: string; label: string } | null
  onClearListingFilter: () => void
  incomingMessage: { connectionId: string; message: api.ApiMessage } | null
  onMessageSent: (connectionId: string, message: api.ApiMessage) => void
}) {
  const isMobile = useIsMobile()
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [initialPanel, setInitialPanel] = useState<'gassplit' | null>(null)
  const totalUnread = connections.reduce((sum, c) => sum + c.unreadMessages, 0)

  const scoped = useMemo(
    () => listingFilter ? connections.filter(c => c.driverTripId === listingFilter.id || c.rideRequestId === listingFilter.id) : connections,
    [connections, listingFilter],
  )
  const visible = useMemo(() => scoped.filter(c => inboxMatches(filter, c.status)), [scoped, filter])
  const counts = useMemo(() => {
    const out: Record<InboxFilter, number> = { all: 0, active: 0, completed: 0, archived: 0 }
    for (const c of scoped) { out[inboxBucket(c.status)] += 1; if (inboxBucket(c.status) !== 'archived') out.all += 1 }
    return out
  }, [scoped])

  // Deep link from a notification: jump straight to that thread (and panel).
  useEffect(() => {
    if (!deepLink) return
    const target = connections.find(c => c.id === deepLink.connectionId)
    if (!target) return
    setFilter(inboxBucket(target.status) === 'archived' ? 'archived' : 'all')
    setInitialPanel(deepLink.section === 'gassplit' ? 'gassplit' : null)
    setSelectedId(target.id)
    onDeepLinkHandled()
  }, [deepLink, connections]) // eslint-disable-line react-hooks/exhaustive-deps

  // Desktop always shows a conversation in the detail pane; mobile shows the
  // list until one is tapped.
  useEffect(() => {
    if (selectedId && visible.some(c => c.id === selectedId)) return
    if (selectedId && isMobile && scoped.some(c => c.id === selectedId)) return
    setSelectedId(!isMobile && visible.length > 0 ? visible[0].id : null)
  }, [visible, scoped, selectedId, isMobile])

  const selected = connections.find(c => c.id === selectedId) ?? null
  const select = (id: string) => { setInitialPanel(null); setSelectedId(id) }

  const pane = selected && (
    <ConversationPane
      key={selected.id}
      connection={selected} currentUserId={currentUserId}
      onBack={isMobile ? () => setSelectedId(null) : undefined}
      onAccept={onAccept} onDecline={onDecline} onCancel={onCancel} onComplete={onComplete}
      showToast={showToast} onViewRoute={onViewRoute} onStartDriving={onStartDriving} onMarkRead={onMarkRead}
      initialPanel={initialPanel} incomingMessage={incomingMessage} onMessageSent={onMessageSent}
    />
  )

  const FILTERS: { id: InboxFilter; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'active', label: 'Active' },
    { id: 'completed', label: 'Completed' }, { id: 'archived', label: 'Archived' },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h1 style={SERIF} className="text-[2.25rem] xl:text-[2.75rem] leading-tight text-foreground">Inbox</h1>
        <p className="text-muted-foreground mt-1">
          {totalUnread > 0
            ? <span className="text-primary font-medium">{totalUnread} unread message{totalUnread !== 1 ? 's' : ''}</span>
            : 'Track pending offers, accepted rides, and chats.'}
        </p>
      </div>

      {listingFilter && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-primary/10 text-primary px-4 py-2.5 text-sm">
          <span className="truncate">Conversations for <span className="font-semibold">{listingFilter.label}</span></span>
          <button onClick={onClearListingFilter} className="shrink-0 font-semibold hover:underline">Show all</button>
        </div>
      )}

      <div className="rounded-3xl border border-border bg-card overflow-hidden xl:grid xl:grid-cols-[minmax(0,35fr)_minmax(0,65fr)] xl:h-[calc(100dvh-16rem)] xl:min-h-[520px]">
        <aside className="flex flex-col min-h-0 xl:border-r border-border">
          <div className="shrink-0 flex gap-1 p-2 border-b border-border overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Conversation filter">
            {FILTERS.map(f => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${filter === f.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {f.id === 'archived' && <Archive className="size-3.5" />}
                {f.label}
                <span className="text-[11px] tabular-nums opacity-60">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
            {visible.length === 0 ? (
              <div className="text-center py-16 px-6 text-muted-foreground">
                <MessageCircle className="size-10 mx-auto mb-4 opacity-20" />
                <p className="font-medium">{connections.length === 0 ? 'No connections yet' : filter === 'archived' ? 'Nothing archived' : 'No conversations here'}</p>
                <p className="text-sm mt-1">{connections.length === 0 ? 'Connect with a driver or rider from Discover.' : 'Try another filter.'}</p>
              </div>
            ) : visible.map(c => (
              <ConversationListItem key={c.id} connection={c} currentUserId={currentUserId} selected={c.id === selectedId} onSelect={() => select(c.id)} />
            ))}
          </div>
        </aside>

        {!isMobile && (
          <section className="min-h-0 flex flex-col" aria-label="Conversation">
            {pane ?? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-10 text-center">
                <MessageCircle className="size-10 mb-3 opacity-20" />
                <p className="font-medium">Select a conversation</p>
                <p className="text-sm mt-1">Trip details, controls and chat will show up here.</p>
              </div>
            )}
          </section>
        )}
      </div>

      {/* Mobile: the open thread takes over the whole screen (over the bottom
          nav) so the composer can sit at the very bottom like a messaging app. */}
      {isMobile && pane && <div className="fixed inset-0 z-50 flex flex-col bg-background">{pane}</div>}
    </div>
  )
}

// ─── Notifications view ───────────────────────────────────────────────────────

type NotifCategory = 'all' | 'connections' | 'chat' | 'payments'

function notifCategory(type: string): Exclude<NotifCategory, 'all'> {
  if (type === 'chat_message') return 'chat'
  if (type === 'gas_split_confirmed') return 'payments'
  return 'connections'
}

const NOTIF_FILTERS: { id: NotifCategory; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'connections', label: 'Connections' },
  { id: 'chat', label: 'Chat' }, { id: 'payments', label: 'Payments' },
]

function NotificationsView({ notifications, onMarkAllRead, onDismiss, onNavigate }: {
  notifications: api.ApiNotification[]
  onMarkAllRead: () => void
  onDismiss: (id: string) => void
  onNavigate: (n: api.ApiNotification) => void
}) {
  const [filter, setFilter] = useState<NotifCategory>('all')

  const iconForType = (type: string) => {
    if (type.includes('connection_received')) return <UserPlus className="size-4 text-primary" />
    if (type.includes('accepted') || type.includes('chat_unlocked')) return <Check className="size-4 text-green-600" />
    if (type.includes('chat')) return <MessageCircle className="size-4 text-primary" />
    if (type.includes('gas_split')) return <Fuel className="size-4 text-amber-600" />
    if (type.includes('declined') || type.includes('cancelled')) return <X className="size-4 text-red-500" />
    return <Bell className="size-4 text-muted-foreground" />
  }

  const unreadCount = notifications.filter(n => !n.read).length
  const visible = [...notifications].reverse().filter(n => filter === 'all' || notifCategory(n.type) === filter)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Notifications</h1>
          <p className="text-muted-foreground mt-1">Stay up to date on your connections and activity.</p>
        </div>
        {unreadCount > 0 && (
          <button onClick={onMarkAllRead} className="shrink-0 text-sm font-semibold text-primary hover:underline">
            Mark all as read
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {NOTIF_FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filter === f.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Bell className="size-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No notifications</p>
          <p className="text-sm mt-1">You're all caught up.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(n => (
            <motion.div
              key={n.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
              onClick={() => onNavigate(n)}
              className={`relative flex items-start gap-3 p-4 pl-5 rounded-2xl border cursor-pointer transition-colors ${n.read ? 'bg-card border-border hover:bg-muted/50' : 'bg-primary/10 border-primary/25 hover:bg-primary/15'}`}
            >
              {!n.read && <span className="absolute top-5 left-1.5 size-1.5 rounded-full bg-primary" aria-hidden />}
              <div className="mt-0.5 shrink-0">{iconForType(n.type)}</div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{n.title}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{n.body}</p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{relativeTime(n.created_at)}</span>
              <button
                onClick={e => { e.stopPropagation(); onDismiss(n.id) }}
                aria-label="Dismiss notification"
                className="shrink-0 p-1 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="size-3.5" />
              </button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Profile view ─────────────────────────────────────────────────────────────

function ProfileView({ currentUser, onProfileUpdate }: {
  currentUser: ApiUser; onProfileUpdate: (user: ApiUser) => void
}) {
  const profile = currentUser.profile
  const vehicle = currentUser.vehicle
  const [displayName, setDisplayName] = useState(profile.display_name)
  const [bio, setBio] = useState(profile.bio ?? '')
  const [interests, setInterests] = useState<string[]>(profile.interests ?? [])
  const [interestDraft, setInterestDraft] = useState('')
  const [nationality, setNationality] = useState(profile.nationality ?? '')
  const [make, setMake] = useState(vehicle?.make ?? '')
  const [model, setModel] = useState(vehicle?.model ?? '')
  const [color, setColor] = useState(vehicle?.color ?? '')
  const [vSeats, setVSeats] = useState(vehicle?.seats != null ? String(vehicle.seats) : '')
  const [vCarType, setVCarType] = useState(vehicle?.car_type ?? '')
  const [hasLicense, setHasLicense] = useState(vehicle?.has_license ?? false)
  const [hasInsurance, setHasInsurance] = useState(vehicle?.has_insurance ?? false)
  const [hasRecord, setHasRecord] = useState(vehicle?.has_good_driving_record ?? false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [photoUploading, setPhotoUploading] = useState(false)

  const addInterest = () => {
    const tag = interestDraft.trim()
    if (tag && !interests.includes(tag)) setInterests(prev => [...prev, tag])
    setInterestDraft('')
  }
  const removeInterest = (tag: string) => setInterests(prev => prev.filter(t => t !== tag))

  // Only what actually changed gets saved — in particular, a rider who never
  // touches the vehicle section must not end up with an empty vehicle record
  // (which would mark them as "driver ready" and skip vehicle setup later).
  const profileDirty =
    displayName !== profile.display_name || bio !== (profile.bio ?? '') || nationality !== (profile.nationality ?? '') ||
    interests.join('\u0000') !== (profile.interests ?? []).join('\u0000')
  const vehicleDirty =
    make !== (vehicle?.make ?? '') || model !== (vehicle?.model ?? '') || color !== (vehicle?.color ?? '') ||
    vSeats !== (vehicle?.seats != null ? String(vehicle.seats) : '') || vCarType !== (vehicle?.car_type ?? '') ||
    hasLicense !== (vehicle?.has_license ?? false) || hasInsurance !== (vehicle?.has_insurance ?? false) ||
    hasRecord !== (vehicle?.has_good_driving_record ?? false)
  const dirty = profileDirty || vehicleDirty || interestDraft.trim() !== ''

  const saveChanges = async () => {
    const pendingInterest = interestDraft.trim()
    const nextInterests = pendingInterest && !interests.includes(pendingInterest) ? [...interests, pendingInterest] : interests
    if (pendingInterest) { setInterests(nextInterests); setInterestDraft('') }
    if (!displayName.trim()) { setSaveMsg({ text: 'Display name is required', ok: false }); return }
    setSaving(true); setSaveMsg(null)
    try {
      let next: ApiUser = currentUser
      if (profileDirty || pendingInterest) {
        const updated = await api.updateProfile(displayName.trim(), profile.photo_url, bio || null, nextInterests, nationality || null)
        next = { ...next, profile: { ...next.profile, display_name: updated.display_name, bio: updated.bio, interests: updated.interests, nationality: updated.nationality } }
      }
      if (vehicleDirty) {
        const v = await api.updateDriverReadiness({
          make: make || undefined, model: model || undefined, color: color || undefined,
          seats: vSeats ? parseInt(vSeats, 10) : undefined, car_type: vCarType || undefined,
          has_license: hasLicense, has_insurance: hasInsurance, has_good_driving_record: hasRecord,
        })
        next = { ...next, vehicle: v }
      }
      onProfileUpdate(next)
      setSaveMsg({ text: 'Changes saved', ok: true })
    } catch (e) { setSaveMsg({ text: e instanceof Error ? e.message : 'Failed to save', ok: false }) }
    finally { setSaving(false) }
  }

  const onPhotoSelected = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      setPhotoUploading(true)
      try {
        const updated = await api.uploadPhoto(ev.target?.result as string)
        onProfileUpdate({ ...currentUser, profile: { ...profile, photo_url: updated.photo_url, photo_verified: true } })
      } catch (err) { setSaveMsg({ text: err instanceof Error ? err.message : 'Upload failed', ok: false }) }
      finally { setPhotoUploading(false) }
    }
    reader.readAsDataURL(file)
  }

  const inputCls = 'w-full px-3 py-2.5 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors'
  const eligibility = [hasLicense, hasInsurance, hasRecord].filter(Boolean).length
  const driverReady = eligibility === 3 && !!make && !!model

  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.25rem] xl:text-[2.75rem] leading-tight text-foreground">Profile</h1>
        <p className="text-muted-foreground mt-1">How riders and drivers see you, plus your vehicle details.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        {/* ── Left: public profile ── */}
        <section className="rounded-3xl bg-card border border-border p-6 space-y-5">
          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              {profile.photo_url ? (
                <img src={profile.photo_url} alt="Profile" className="size-20 rounded-full object-cover ring-2 ring-primary/20" />
              ) : (
                <div style={MONO} className="size-20 rounded-full bg-secondary text-secondary-foreground text-2xl font-semibold flex items-center justify-center">{toInitials(profile.display_name)}</div>
              )}
              <label className="absolute -bottom-1 -right-1 size-8 rounded-full bg-primary text-primary-foreground ring-2 ring-card flex items-center justify-center cursor-pointer hover:bg-primary/90 transition-colors" aria-label="Upload profile photo">
                <Camera className="size-4" />
                <input type="file" accept="image/*" className="sr-only" onChange={e => onPhotoSelected(e.target.files?.[0])} />
              </label>
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-foreground truncate">{profile.display_name}</h2>
              <p className="text-sm text-muted-foreground truncate">{currentUser.email}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-700 dark:text-green-400"><Check className="size-3" />Email Verified</span>
                {profile.photo_verified
                  ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-700 dark:text-green-400"><Check className="size-3" />Photo Verified</span>
                  : <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{photoUploading ? 'Uploading photo…' : 'Add a photo to get verified'}</span>}
                {currentUser.email_domain && <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">@{currentUser.email_domain}</span>}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5"><label htmlFor="pf-name" className="text-sm font-medium">Display name</label><input id="pf-name" value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} /></div>
            <div className="space-y-1.5"><label htmlFor="pf-bio" className="text-sm font-medium">Bio</label><textarea id="pf-bio" value={bio} onChange={e => setBio(e.target.value)} rows={3} placeholder="Tell others a bit about yourself…" className={`${inputCls} resize-none`} /></div>
            <div className="space-y-1.5">
              <label htmlFor="pf-nat" className="text-sm font-medium">Nationality <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input id="pf-nat" value={nationality} onChange={e => setNationality(e.target.value)} placeholder="e.g. Kenyan" className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pf-int" className="text-sm font-medium">Interests <span className="text-muted-foreground font-normal">(icebreakers, e.g. "Loves Afrobeat")</span></label>
              {interests.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {interests.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary font-medium">
                      {tag}
                      <button type="button" onClick={() => removeInterest(tag)} aria-label={`Remove ${tag}`} className="hover:text-foreground"><X className="size-3" /></button>
                    </span>
                  ))}
                </div>
              )}
              <input
                id="pf-int" value={interestDraft} onChange={e => setInterestDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInterest() } }}
                placeholder="Type an interest and press Enter…" className={inputCls}
              />
            </div>
          </div>
        </section>

        {/* ── Right: driver readiness ── */}
        <section className="rounded-3xl bg-card border border-border p-6 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">Driver Readiness</h3>
              <p className="text-sm text-muted-foreground mt-1">Vehicle details and self-declared eligibility. Only needed if you offer rides.</p>
            </div>
            <span className={`shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full ${driverReady ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
              {driverReady ? 'Ready to drive' : `${eligibility}/3 declared`}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {([['Make', make, setMake, 'e.g. Toyota'], ['Model', model, setModel, 'e.g. Prius'], ['Color', color, setColor, 'e.g. Blue']] as const).map(([label, val, setter, ph]) => (
              <div key={label} className="space-y-1.5">
                <label htmlFor={`veh-${label}`} className="text-sm font-medium">{label}</label>
                <input id={`veh-${label}`} value={val} onChange={e => setter(e.target.value)} placeholder={ph} className={inputCls} />
              </div>
            ))}
            <div className="space-y-1.5"><label htmlFor="veh-seats" className="text-sm font-medium">Seats</label><input id="veh-seats" type="number" min="1" max="9" value={vSeats} onChange={e => setVSeats(e.target.value)} placeholder="4" className={inputCls} /></div>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Vehicle type</p>
            <div className="flex flex-wrap gap-2">
              {(['sedan', 'suv', 'van', 'minivan', 'truck', 'other'] as CarType[]).map(ct => (
                <button key={ct} type="button" aria-pressed={vCarType === ct} onClick={() => setVCarType(vCarType === ct ? '' : ct)} className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${vCarType === ct ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                  {CAR_TYPE_EMOJI[ct]} {CAR_TYPE_LABELS[ct]}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Eligibility</p>
            {([['has_license', "Driver's License", 'I hold a valid license', hasLicense, setHasLicense], ['has_insurance', 'Insurance', 'My vehicle is insured', hasInsurance, setHasInsurance], ['has_record', 'Clean Record', 'I have a good driving record', hasRecord, setHasRecord]] as [string, string, string, boolean, (v: boolean) => void][]).map(([key, title, desc, val, setter]) => (
              <label key={key} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 cursor-pointer transition-colors ${val ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-muted/50'}`}>
                <input type="checkbox" checked={val} onChange={() => setter(!val)} className="form-checkbox h-4 w-4 rounded border-border bg-input-background text-primary focus:ring-ring" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{title}</span>
                  <span className="block text-xs text-muted-foreground">{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      </div>

      {/* One save action for the whole page, kept in reach while scrolling. */}
      <div className="sticky bottom-20 xl:bottom-4 z-30 flex items-center justify-end gap-3 rounded-2xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-lg">
        {saveMsg
          ? <p role="status" className={`text-sm mr-auto ${saveMsg.ok ? 'text-green-700 dark:text-green-400' : 'text-red-500'}`}>{saveMsg.text}</p>
          : <p className="text-sm mr-auto text-muted-foreground">{dirty ? 'You have unsaved changes' : 'All changes saved'}</p>}
        <button onClick={saveChanges} disabled={saving || !dirty} className="px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}

// ─── Neon ↔ Backend session sync ─────────────────────────────────────────────

const AUTH_TOKEN_RETRY_LIMIT = 3

function NeonAuthSync({ onAuthenticated, onUnauthenticated, onAuthError }: {
  onAuthenticated: (neonToken: string) => Promise<void>
  onUnauthenticated: () => void
  onAuthError: (message: string) => void
}) {
  const ctx = useContext(AuthUIContext)
  const { data: session, isPending } = ctx.hooks.useSession()
  const lastSyncedId = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (isPending) return
    if (!session?.user) {
      if (lastSyncedId.current !== null) {
        lastSyncedId.current = null
        onUnauthenticated()
      }
      return
    }
    const uid = session.user.id
    if (lastSyncedId.current === uid) return

    // The backend verifies this token's signature itself — it never trusts a
    // client-supplied email/name (that would let anyone authenticate as anyone).
    // fetchNeonJWT can reject or resolve null (e.g. the Neon Auth server is
    // briefly unreachable) — retry a few times with backoff, and surface an
    // error instead of hanging on "Loading…" forever if it never recovers.
    let cancelled = false

    const attempt = async (attemptNumber: number): Promise<void> => {
      try {
        const token = await fetchNeonJWT()
        if (cancelled) return
        if (!token) throw new Error('Neon Auth returned no token')
        lastSyncedId.current = uid
        await onAuthenticated(token)
      } catch {
        if (cancelled) return
        if (attemptNumber < AUTH_TOKEN_RETRY_LIMIT) {
          setTimeout(() => { if (!cancelled) attempt(attemptNumber + 1) }, 1000 * attemptNumber)
        } else {
          onAuthError('Could not verify your session. Check your connection and try again.')
        }
      }
    }
    attempt(1)

    return () => { cancelled = true }
  }, [session?.user?.id, isPending, onAuthenticated, onUnauthenticated, onAuthError])

  return null
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function ModeToggle({ mode, onSetMode }: { mode: ListingType; onSetMode: (m: ListingType) => void }) {
  return (
    <div className="flex rounded-xl bg-sidebar-accent p-0.5 gap-0.5" role="group" aria-label="Passenger or Driver mode">
      {(['rider', 'driver'] as ListingType[]).map(m => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => onSetMode(m)} className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${mode === m ? 'bg-white text-sidebar shadow-sm' : 'text-sidebar-foreground/65 hover:text-sidebar-foreground'}`}>
          {m === 'rider' ? 'Passenger' : 'Driver'}
        </button>
      ))}
    </div>
  )
}

// Account actions (Profile, Admin, Sign out) live only here — not duplicated
// in the page bodies — so there's exactly one place to find them.
function AccountMenu({ currentUser, initials, setView, onSignOut, onOpenAdmin }: {
  currentUser: ApiUser; initials: string; setView: (v: View) => void; onSignOut: () => void; onOpenAdmin: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const item = 'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-foreground hover:bg-muted transition-colors'
  const photo = currentUser.profile.photo_url
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Account" className="size-8 rounded-full bg-sidebar-accent text-sidebar-foreground text-xs font-semibold flex items-center justify-center overflow-hidden hover:ring-2 hover:ring-sidebar-primary/40 transition-all" style={MONO}>
        {photo ? <img src={photo} alt="" className="size-full object-cover" /> : initials}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-50 w-60 rounded-2xl border border-border bg-card text-foreground shadow-xl p-2">
          <div className="px-3 py-2 mb-1 border-b border-border">
            <p className="text-sm font-semibold truncate">{currentUser.profile.display_name}</p>
            <p className="text-xs text-muted-foreground truncate">{currentUser.email}</p>
          </div>
          <button role="menuitem" className={item} onClick={() => { setOpen(false); setView('profile') }}><UserIcon className="size-4 text-muted-foreground" />Profile & vehicle</button>
          {isSuperadmin(currentUser) && (
            <button role="menuitem" className={item} onClick={() => { setOpen(false); onOpenAdmin() }}><ShieldCheck className="size-4 text-muted-foreground" />Admin Panel</button>
          )}
          <button role="menuitem" className={`${item} text-destructive`} onClick={() => { setOpen(false); onSignOut() }}><LogOut className="size-4" />Sign out</button>
        </div>
      )}
    </div>
  )
}

function TopBar({ setView, currentUser, unreadCount, onSignOut, onOpenAdmin, initials, darkMode, onToggleDark, mode, onSetMode }: {
  setView: (v: View) => void; currentUser: ApiUser | null; unreadCount: number
  onSignOut: () => void; onOpenAdmin: () => void; initials: string; darkMode: boolean; onToggleDark: () => void
  mode: ListingType; onSetMode: (m: ListingType) => void
}) {
  return (
    <header className="sticky top-0 z-40 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
      <div className="max-w-[1440px] mx-auto px-4 lg:px-8 h-14 flex items-center justify-between gap-3">
        <button onClick={() => setView('feed')} className="flex items-center gap-2 text-sm font-semibold text-sidebar-foreground hover:text-sidebar-primary transition-colors xl:text-base min-w-0">
          <span className="size-7 rounded-lg bg-sidebar-primary text-white flex items-center justify-center shrink-0"><Car className="size-4" /></span>
          <span className="hidden sm:inline truncate">Let's Carpool</span>
        </button>
        {currentUser ? (
          <div className="flex items-center gap-1 sm:gap-2">
            {/* The single Passenger/Driver switch for the whole app, on every screen size. */}
            <ModeToggle mode={mode} onSetMode={onSetMode} />
            <button onClick={onToggleDark} className="p-2 rounded-xl hover:bg-sidebar-accent text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors" aria-label="Toggle dark mode">
              {darkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
            <button onClick={() => setView('notifications')} className="relative p-2 rounded-xl hover:bg-sidebar-accent text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors" aria-label="Notifications">
              <Bell className="size-5" />
              {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[10px] font-bold">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
            <AccountMenu currentUser={currentUser} initials={initials} setView={setView} onSignOut={onSignOut} onOpenAdmin={onOpenAdmin} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={onToggleDark} className="p-2 rounded-xl hover:bg-sidebar-accent text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors" aria-label="Toggle dark mode">
              {darkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
            <button onClick={() => setView('feed')} className="px-4 py-2 rounded-2xl bg-sidebar-primary text-white text-sm font-semibold hover:opacity-90 transition-colors">Sign in</button>
          </div>
        )}
      </div>
    </header>
  )
}

function BottomNav({ view, setView, unreadMessages }: { view: View; setView: (v: View) => void; unreadMessages: number }) {
  // Trimmed to 4 core tabs — Map is a toggle inside Discover, Pools lives
  // inside My Rides, and ride creation moved to the Discover FAB.
  const items: Array<{ id: View; label: string; icon: React.ReactNode }> = [
    { id: 'feed', label: 'Discover', icon: <Search className="size-5" /> },
    { id: 'my-listings', label: 'My Rides', icon: <Car className="size-5" /> },
    { id: 'connections', label: 'Inbox', icon: <MessageCircle className="size-5" /> },
    { id: 'profile', label: 'Profile', icon: <Shield className="size-5" /> },
  ]
  return (
    <nav className="xl:hidden fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t border-border z-40 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around px-2 h-16">
        {items.map(({ id, label, icon }) => {
          const active = view === id || (id === 'feed' && view === 'map')
          const badge = id === 'connections' ? unreadMessages : 0
          return (
            <button key={id} onClick={() => setView(id)} aria-label={label} aria-current={active ? 'page' : undefined} className={`relative flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-colors ${active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
              {icon}
              {badge > 0 && (
                <span className="absolute -top-0.5 right-1.5 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{badge > 9 ? '9+' : badge}</span>
              )}
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function Sidebar({ view, setView, unreadMessages }: { view: View; setView: (v: View) => void; unreadMessages: number }) {
  const items: Array<{ id: View; label: string }> = [
    { id: 'feed', label: 'Discover' }, { id: 'map', label: 'Live Map' }, { id: 'pools', label: 'Pools' },
    { id: 'post', label: 'Post' }, { id: 'my-listings', label: 'My Rides' },
    { id: 'connections', label: 'Inbox' }, { id: 'notifications', label: 'Notifications' }, { id: 'profile', label: 'Profile' },
  ]
  return (
    <aside className="bg-sidebar border border-sidebar-border rounded-[2rem] p-6 xl:h-fit xl:sticky xl:top-20">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-sidebar-foreground/60">Carpooling app</p>
          <h1 className="mt-2 text-2xl font-semibold text-sidebar-foreground">Let's Carpool</h1>
        </div>
        <div className="rounded-3xl bg-sidebar-primary px-3 py-2 text-white text-xs font-semibold">MVP</div>
      </div>
      <div className="mt-8 space-y-1.5">
        {items.map(item => (
          <button key={item.id} type="button" onClick={() => setView(item.id)} aria-current={view === item.id ? 'page' : undefined} className={`w-full rounded-3xl px-4 py-3 text-left text-sm font-medium transition-all flex items-center justify-between ${view === item.id ? 'bg-sidebar-primary text-white shadow-lg shadow-sidebar-primary/20' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`}>
            {item.label}
            {item.id === 'connections' && unreadMessages > 0 && (
              <span className="min-w-5 h-5 px-1.5 rounded-full bg-destructive text-white text-[10px] font-bold flex items-center justify-center">{unreadMessages > 9 ? '9+' : unreadMessages}</span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-8 rounded-[2rem] bg-card p-6 shadow-[0_36px_60px_-40px_rgba(0,0,0,0.18)]">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-primary/10 p-3 text-primary"><HomeIcon className="size-5" /></div>
          <div>
            <p className="text-sm text-muted-foreground">Quick start</p>
            <p className="text-sm font-semibold text-foreground">Browse listings, post trips, and manage matches.</p>
          </div>
        </div>
        <div className="mt-6 space-y-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2"><Dot className="size-2" />Search and filter rides across the marketplace.</div>
          <div className="flex items-center gap-2"><Dot className="size-2" />Post one-off ride requests or driver trips.</div>
          <div className="flex items-center gap-2"><Dot className="size-2" />Track pending connections and confirm gas split.</div>
        </div>
      </div>
    </aside>
  )
}

// ─── Home (carpool app) ───────────────────────────────────────────────────────

// Each app view has its own URL so tabs are linkable, survive a refresh and
// work with the browser's back button.
const VIEW_PATHS: Record<View, string> = {
  home: '/discover', feed: '/discover', map: '/map', pools: '/pools', post: '/post',
  'my-listings': '/my-rides', connections: '/connections', notifications: '/notifications', profile: '/profile',
}
const PATH_VIEWS: Record<string, View> = {
  '/': 'feed', '/discover': 'feed', '/map': 'map', '/pools': 'pools', '/post': 'post',
  '/my-rides': 'my-listings', '/connections': 'connections', '/inbox': 'connections',
  '/notifications': 'notifications', '/profile': 'profile',
}

export function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const isMobile = useIsMobile()

  // ── Auth ──
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authRetryNonce, setAuthRetryNonce] = useState(0)

  // ── Dark mode ──
  // Driven by next-themes (via NeonAuthUIProvider in App.tsx), not a separate
  // mechanism of our own — it already owns the `class` on <html>, persists to
  // localStorage, and is active on every route (Home never having mounted was
  // exactly why the old carpool_dark-based toggle didn't survive across pages:
  // NeonAuthUIProvider wraps every route and would silently overwrite it).
  const { resolvedTheme, setTheme } = useTheme()
  const darkMode = resolvedTheme === 'dark'

  // ── Geolocation ──
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null)
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { timeout: 8000 }
    )
  }, [])

  // ── Navigation ──
  const view: View = PATH_VIEWS[location.pathname.replace(/\/+$/, '') || '/'] ?? 'feed'
  const pathnameRef = useRef(location.pathname)
  pathnameRef.current = location.pathname
  const setView = useCallback((v: View) => {
    const path = VIEW_PATHS[v]
    if (pathnameRef.current !== path) navigate(path)
  }, [navigate])

  // ── Passenger/Driver mode ── persists per session; switches primary actions/views
  const [mode, setMode] = useState<ListingType>(() => (sessionStorage.getItem('carpool_mode') as ListingType) || 'rider')
  useEffect(() => { sessionStorage.setItem('carpool_mode', mode) }, [mode])

  // ── Feed ──
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'driver' | 'rider'>('all')
  const [filterTag, setFilterTag] = useState<'' | RideTag>('')
  const [filterCarType, setFilterCarType] = useState<'' | CarType>('')
  const [filterLuggage, setFilterLuggage] = useState<'' | LuggageSize>('')
  const [allListings, setAllListings] = useState<Listing[]>([])
  const [matchedListingIds, setMatchedListingIds] = useState<string[]>([])
  const [feedLoading, setFeedLoading] = useState(false)

  // ── Mobile Discover: quick filters, filter sheet ──
  const [quickDateFilter, setQuickDateFilter] = useState<'today' | 'any'>('any')
  const [seatsNeeded, setSeatsNeeded] = useState<number | null>(null)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)

  // ── My Listings ──
  const [myListings, setMyListings] = useState<MyListing[]>([])
  const [postPrefill, setPostPrefill] = useState<PostPrefill | null>(null)
  useEffect(() => { if (view !== 'post') setPostPrefill(null) }, [view])

  // ── Connections ──
  const [connections, setConnections] = useState<Connection[]>([])
  const connectionsRef = useRef<Connection[]>([])
  useEffect(() => { connectionsRef.current = connections }, [connections])
  const [incomingMessage, setIncomingMessage] = useState<{ connectionId: string; message: api.ApiMessage } | null>(null)
  const [inboxListingFilter, setInboxListingFilter] = useState<{ id: string; label: string } | null>(null)

  // ── Trip route (for Map view) ──
  const [tripRoute, setTripRoute] = useState<TripRoute | null>(null)

  // ── Driving-to-pickup (for Map view) ──
  const [drivingTo, setDrivingTo] = useState<DrivingTarget | null>(null)

  // ── Notifications ──
  const [notifications, setNotifications] = useState<api.ApiNotification[]>([])
  const [connDeepLink, setConnDeepLink] = useState<{ connectionId: string; section: 'chat' | 'gassplit' } | null>(null)

  // ── WebSocket ──
  const wsRef = useRef<WebSocket | null>(null)
  const showToastRef = useRef<(msg: string, type: 'success' | 'error') => void>(() => {})

  // ── Toast ──
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ message, type })
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }, [])
  showToastRef.current = showToast

  useEffect(() => {
    if (!currentUser) { wsRef.current?.close(); wsRef.current = null; return }
    const ws = api.createWebSocket(currentUser.id, (msg: WsMessage) => {
      if (msg.type === 'chat_message') {
        const m = msg.message
        setConnections(prev => prev.map(c => c.id === msg.connection_id
          ? { ...c, unreadMessages: c.unreadMessages + 1, lastMessage: { content: m.content, createdAt: m.created_at, senderId: m.sender_id } }
          : c))
        setIncomingMessage({ connectionId: msg.connection_id, message: m })
        const conn = connectionsRef.current.find(c => c.id === msg.connection_id)
        const senderName = conn?.withUser.name ?? 'Someone'
        const preview = msg.message.content.length > 45 ? msg.message.content.slice(0, 45) + '…' : msg.message.content
        showToastRef.current(`💬 ${senderName}: ${preview}`, 'success')
        setNotifications(prev => [{ id: `ws_${Date.now()}`, user_id: currentUser.id, type: 'chat_message', title: `${senderName} sent a message`, body: msg.message.content, created_at: new Date().toISOString(), read: false, related_id: msg.connection_id }, ...prev])
      } else if (msg.type === 'connection_update') {
        setConnections(prev => prev.map(c => c.id === msg.connection_id ? { ...c, status: msg.status as Connection['status'] } : c))
      } else if (msg.type === 'driver_nearby') {
        showToastRef.current(`🚗 ${msg.display_name} is nearby!`, 'success')
      }
    })
    wsRef.current = ws
    return () => { ws?.close(); wsRef.current = null }
  }, [currentUser])

  // ── Neon session → backend sync ──
  const handleAuthenticated = useCallback(async (neonToken: string) => {
    try {
      const existingToken = localStorage.getItem('carpool_token')
      if (existingToken) {
        try { const user = await api.getMe(); setCurrentUser(user); requestLocation(); return }
        catch { localStorage.removeItem('carpool_token') }
      }
      const user = await api.login(neonToken)
      setCurrentUser(user); requestLocation()
      setAuthError(null)
    } finally { setAuthLoading(false) }
  }, [requestLocation])

  const handleUnauthenticated = useCallback(() => {
    api.logout(); setCurrentUser(null); setAuthLoading(false); setAuthError(null)
  }, [])

  // Fires only after NeonAuthSync exhausts its retries — e.g. the Neon Auth
  // server is unreachable — so the UI never hangs on "Loading…" forever.
  const handleAuthError = useCallback((message: string) => {
    setAuthError(message); setAuthLoading(false)
  }, [])

  const retryAuth = useCallback(() => {
    setAuthError(null); setAuthLoading(true); setAuthRetryNonce(n => n + 1)
  }, [])

  // ── Redirect when not authenticated ──
  // Must not fire when authError is set — otherwise this immediately bounces
  // the user to the plain sign-in form before they ever see the "couldn't
  // verify your session" screen (with its Retry/Sign out actions) below,
  // since authLoading and currentUser==null are both already true at that
  // point too.
  useEffect(() => {
    if (!authLoading && !currentUser && !authError) {
      navigate('/auth/sign-in', { replace: true })
    }
  }, [authLoading, currentUser, authError, navigate])

  useEffect(() => {
    if (!authLoading && currentUser && window.location.pathname.startsWith('/auth/')) {
      navigate('/', { replace: true })
    }
  }, [authLoading, currentUser, navigate])

  useEffect(() => {
    if (!currentUser) return
    api.getNotifications().then(setNotifications).catch(() => {})
  }, [currentUser])

  // ── Connections from API ──
  const loadConnections = useCallback(async (userId: string) => {
    try {
      const conns = await api.getMyConnections()
      setConnections(prev => {
        const prevMap = Object.fromEntries(prev.map(c => [c.id, c]))
        return conns.map(c => {
          const mapped = apiConnectionToConnection(c, userId)
          mapped.unreadMessages = prevMap[mapped.id]?.unreadMessages ?? 0
          mapped.lastMessage = prevMap[mapped.id]?.lastMessage ?? null
          return mapped
        })
      })
      // Inbox list previews: the last message of each still-relevant thread.
      const live = conns.filter(c => c.status === 'pending' || c.status === 'accepted' || c.status === 'completed').slice(0, 30)
      const lasts = await Promise.all(live.map(c => api.getMessages(c.id).then(ms => ms[ms.length - 1] ?? null).catch(() => null)))
      const lastById: Record<string, api.ApiMessage> = {}
      live.forEach((c, i) => { const m = lasts[i]; if (m) lastById[c.id] = m })
      setConnections(prev => prev.map(c => {
        const m = lastById[c.id]
        return m ? { ...c, lastMessage: { content: m.content, createdAt: m.created_at, senderId: m.sender_id } } : c
      }))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { if (currentUser) loadConnections(currentUser.id) }, [currentUser, loadConnections])

  // ── My Listings ──
  const loadMyListings = useCallback(async () => {
    try {
      const [trips, requests] = await Promise.all([api.getMyDriverTrips(), api.getMyRideRequests()])
      const combined: MyListing[] = [
        ...trips.map(tripToMyListing),
        ...requests.map(requestToMyListing),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      setMyListings(combined)
    } catch { }
  }, [])

  useEffect(() => { if (currentUser) loadMyListings() }, [currentUser, loadMyListings])

  // ── Feed ──
  const loadListings = useCallback(async (coords?: { lat: number; lng: number } | null) => {
    setFeedLoading(true)
    try {
      const q = coords ? { pickup_latitude: coords.lat, pickup_longitude: coords.lng, pickup_radius_meters: 80000 } : {}
      const [trips, requests] = await Promise.all([api.searchDriverTrips(q), api.searchRideRequests(q)])
      setAllListings([...trips.map(tripToListing), ...requests.map(requestToListing)])
    } catch { } finally { setFeedLoading(false) }
  }, [])

  useEffect(() => { if (currentUser) loadListings(userCoords) }, [currentUser, userCoords, loadListings])

  const LUGGAGE_ORDER = ['none', 'small', 'medium', 'large', 'oversized']
  const filteredListings = useMemo(() => {
    const todayLocal = todayLocalISO()
    return allListings.filter(listing => {
      const matchType = filterType === 'all' || listing.type === filterType
      const matchTag = filterTag === '' || listing.tags.includes(filterTag)
      const matchSearch = searchQuery.trim() === '' || listing.to.toLowerCase().includes(searchQuery.toLowerCase()) || listing.from.toLowerCase().includes(searchQuery.toLowerCase())
      const matchCarType = filterCarType === '' || (listing.type === 'driver' && listing.carType === filterCarType)
      const matchLuggage = filterLuggage === '' || listing.type !== 'driver' || (listing.luggageCapacity != null && LUGGAGE_ORDER.indexOf(listing.luggageCapacity) >= LUGGAGE_ORDER.indexOf(filterLuggage))
      const matchDate = quickDateFilter === 'any' || listing.date === todayLocal
      const matchSeats = seatsNeeded == null || listing.type !== 'driver' || ((listing.seats ?? 0) - (listing.seatsUsed ?? 0)) >= seatsNeeded
      return matchType && matchTag && matchSearch && matchCarType && matchLuggage && matchDate && matchSeats
    })
  }, [allListings, filterTag, filterType, searchQuery, filterCarType, filterLuggage, quickDateFilter, seatsNeeded]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──
  const onConnect = useCallback(async (listing: Listing) => {
    try {
      const lat = userCoords?.lat ?? 0; const lng = userCoords?.lng ?? 0
      let conn: api.ApiConnection
      if (listing.type === 'driver') {
        const [p, d] = await Promise.all([api.createLocation('My location', lat, lng), api.createLocation(listing.to, lat, lng)])
        const rr = await api.createRideRequest({ pickup_location_id: p.id, destination_location_id: d.id, target_date: listing.date, flexibility: listing.flexibility, passenger_count: 1, tags: [] })
        conn = await api.createConnection(rr.id, listing.apiId)
      } else {
        const [p, d] = await Promise.all([api.createLocation('My location', lat, lng), api.createLocation(listing.to, lat, lng)])
        const trip = await api.createDriverTrip({ pickup_location_id: p.id, destination_location_id: d.id, target_date: listing.date, flexibility: listing.flexibility, seats_available: 1, tags: [] })
        conn = await api.createConnection(listing.apiId, trip.id)
      }
      const newConn = apiConnectionToConnection(conn, currentUser?.id ?? '')
      setConnections(prev => [newConn, ...prev]); showToast('Connection created!', 'success')
      setInboxListingFilter(null); setConnDeepLink({ connectionId: newConn.id, section: 'chat' }); setView('connections')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed to connect', 'error') }
  }, [currentUser, userCoords, showToast, setView])

  const onPost = useCallback((listing: MyListing) => {
    setMyListings(prev => [listing, ...prev]); setPostPrefill(null); loadListings(userCoords); loadMyListings(); setView('my-listings'); showToast('Listing posted!', 'success')
  }, [loadListings, loadMyListings, showToast, setView, userCoords])

  // ── My Rides card actions ──
  const onManageListing = useCallback((listing: MyListing) => {
    setInboxListingFilter({ id: listing.id, label: `${listing.from} ➔ ${listing.to}` })
    setConnDeepLink(null)
    setView('connections')
  }, [setView])

  // Opens Discover pre-searched for the listing's destination, showing the
  // opposite side of the marketplace (riders for a trip, drivers for a request).
  const onViewMatches = useCallback((listing: MyListing) => {
    setSearchQuery(listing.to.split(',')[0])
    setFilterType(listing.type === 'driver' ? 'rider' : 'driver')
    setQuickDateFilter('any')
    setView('feed')
  }, [setView])

  const onCloneListing = useCallback((listing: MyListing) => {
    const loc = (label: string, lat?: number, lng?: number): LocationValue | null =>
      lat != null && lng != null ? { label, lat, lng } : null
    setPostPrefill({
      key: `${listing.id}_${Date.now()}`, type: listing.type,
      from: loc(listing.from, listing.pickupLat, listing.pickupLng),
      to: loc(listing.to, listing.destLat, listing.destLng),
      flexibility: listing.flexibility, seats: listing.seats, passengers: listing.passengers,
      tags: listing.tags, carType: listing.carType, luggage: listing.luggage,
    })
    setView('post')
  }, [setView])

  const onMessageSent = useCallback((connectionId: string, m: api.ApiMessage) => {
    setConnections(prev => prev.map(c => c.id === connectionId ? { ...c, lastMessage: { content: m.content, createdAt: m.created_at, senderId: m.sender_id } } : c))
  }, [])

  const onCancelListing = useCallback(async (listing: MyListing) => {
    if (listing.type === 'driver') await api.cancelDriverTrip(listing.id)
    else await api.cancelRideRequest(listing.id)
    await loadMyListings()
    showToast('Listing cancelled', 'success')
  }, [loadMyListings, showToast])

  const transact = useCallback(async (id: string, action: 'accept' | 'decline' | 'cancel' | 'complete') => {
    const updated = await api.transitionConnection(id, action)
    setConnections(prev => prev.map(c => c.id === id ? { ...c, status: updated.status as ConnStatus } : c))
  }, [])

  const onAccept = useCallback((id: string) => transact(id, 'accept'), [transact])
  const onDecline = useCallback((id: string) => transact(id, 'decline'), [transact])
  const onCancel = useCallback((id: string) => transact(id, 'cancel'), [transact])
  const onComplete = useCallback((id: string) => transact(id, 'complete'), [transact])

  const onMarkRead = useCallback((id: string) => {
    setConnections(prev => prev.map(c => c.id === id ? { ...c, unreadMessages: 0 } : c))
  }, [])

  const onViewRoute = useCallback((conn: Connection) => {
    if (!conn.pickupLat || !conn.pickupLng || !conn.destLat || !conn.destLng) return
    setDrivingTo(null)
    setTripRoute({
      pickupLat: conn.pickupLat, pickupLng: conn.pickupLng, pickupLabel: conn.pickupLabel ?? 'Pickup',
      destLat: conn.destLat, destLng: conn.destLng, destLabel: conn.destLabel ?? 'Destination',
      partnerName: conn.withUser.name, date: conn.date,
    })
    setView('map')
  }, [setView])

  const onStartDriving = useCallback((conn: Connection) => {
    if (!conn.riderPickupLat || !conn.riderPickupLng) return
    setTripRoute(null)
    setDrivingTo({
      connectionId: conn.id, pickupLat: conn.riderPickupLat, pickupLng: conn.riderPickupLng,
      pickupLabel: conn.riderPickupLabel ?? 'Pickup', partnerName: conn.withUser.name,
    })
    setView('map')
  }, [setView])

  const onStopDriving = useCallback(() => {
    setDrivingTo(null)
    showToast('Trip navigation ended', 'success')
  }, [showToast])

  const onMarkAllReadNotifs = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    api.markNotificationsRead().catch(() => {})
  }, [])

  const onDismissNotif = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
    if (!id.startsWith('ws_')) api.dismissNotification(id).catch(() => {})
  }, [])

  const onNotifNavigate = useCallback((n: api.ApiNotification) => {
    setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))
    setInboxListingFilter(null)
    if (n.related_id && (n.type === 'chat_message' || n.type === 'connection_received' || n.type === 'connection_accepted' || n.type === 'chat_unlocked')) {
      setConnDeepLink({ connectionId: n.related_id, section: 'chat' })
      setView('connections')
    } else if (n.related_id && n.type === 'gas_split_confirmed') {
      setConnDeepLink({ connectionId: n.related_id, section: 'gassplit' })
      setView('connections')
    } else if (n.type === 'pool_joined') {
      setConnDeepLink(null)
      setView('pools')
    } else {
      setConnDeepLink(null)
      setView('connections')
    }
  }, [setView])

  const unreadCount = notifications.filter(n => !n.read).length
  const unreadMessages = connections.reduce((sum, c) => sum + c.unreadMessages, 0)

  const onSignOut = useCallback(() => {
    authClient.signOut().catch(() => {})
    api.logout(); setCurrentUser(null); setConnections([]); setMyListings([]); setNotifications([]); setTripRoute(null); setDrivingTo(null)
    navigate('/auth/sign-in', { replace: true })
  }, [navigate])

  // Switching into Driver mode without a vehicle on file routes into the
  // existing vehicle setup form (on the Profile view) instead of silently
  // switching modes with nothing for the user to actually do as a driver yet.
  const handleSetMode = useCallback((m: ListingType) => {
    setMode(m)
    if (m === 'driver' && !currentUser?.vehicle) setView('profile')
  }, [currentUser?.vehicle, setView])

  const AUTH_VIEWS: View[] = ['feed', 'post', 'my-listings', 'connections', 'notifications', 'profile', 'map', 'pools']
  const guardedView: View = !currentUser && AUTH_VIEWS.includes(view) ? 'feed' : view
  const displayName = currentUser?.profile?.display_name ?? 'You'
  const initials = toInitials(displayName)

  // Session verification failed after retrying — never leave the user stuck
  // on an infinite "Loading…" spinner with no way forward.
  if (authError) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-muted-foreground max-w-xs">{authError}</p>
        <div className="flex items-center gap-3">
          <button onClick={retryAuth} className="px-4 py-2 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Retry</button>
          <button onClick={onSignOut} className="px-4 py-2 rounded-2xl border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Sign out</button>
        </div>
      </div>
    )
  }

  // Show loading while session is resolving
  if (authLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        <NeonAuthSync key={authRetryNonce} onAuthenticated={handleAuthenticated} onUnauthenticated={handleUnauthenticated} onAuthError={handleAuthError} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      </div>
    )
  }

  // Not authenticated — redirect effect fires above, render nothing while redirecting
  if (!currentUser) {
    return <NeonAuthSync key={authRetryNonce} onAuthenticated={handleAuthenticated} onUnauthenticated={handleUnauthenticated} onAuthError={handleAuthError} />
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <NeonAuthSync key={authRetryNonce} onAuthenticated={handleAuthenticated} onUnauthenticated={handleUnauthenticated} onAuthError={handleAuthError} />
      <Toast toast={toast} />

      {/* The immersive full-bleed Map view supplies its own floating header on
          mobile, so the app's own top bar would just double up with it there. */}
      <div className={guardedView === 'map' ? 'hidden xl:block' : ''}>
        <TopBar setView={setView} currentUser={currentUser} unreadCount={unreadCount} onSignOut={onSignOut} onOpenAdmin={() => navigate('/admin')} initials={initials} darkMode={darkMode} onToggleDark={() => setTheme(darkMode ? 'light' : 'dark')} mode={mode} onSetMode={handleSetMode} />
      </div>

      <div className="flex-1 max-w-[1440px] mx-auto w-full px-4 py-4 xl:py-6 lg:px-8 pb-24 xl:pb-6">
        <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
          <div className="hidden xl:block">
            <Sidebar view={guardedView} setView={setView} unreadMessages={unreadMessages} />
          </div>
          <main className="min-w-0">
            {guardedView === 'feed' && (
              mode === 'driver' ? (
                <DriverHomeView
                  myOpenTrip={myListings.find(l => l.type === 'driver' && l.status === 'open')}
                  listings={allListings} currentUserId={currentUser.id} currentUserInterests={currentUser.profile.interests}
                  onConnect={onConnect} showToast={showToast} setView={setView}
                  searchQuery={searchQuery} setSearchQuery={setSearchQuery}
                  filterType={filterType} setFilterType={setFilterType}
                  filterTag={filterTag} setFilterTag={setFilterTag}
                  filterCarType={filterCarType} setFilterCarType={setFilterCarType}
                  filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage}
                  quickDateFilter={quickDateFilter} setQuickDateFilter={setQuickDateFilter}
                  seatsNeeded={seatsNeeded} setSeatsNeeded={setSeatsNeeded}
                  filterSheetOpen={filterSheetOpen} setFilterSheetOpen={setFilterSheetOpen}
                  hasLocation={!!userCoords}
                />
              ) : (
                <div className="space-y-8">
                  {/* Its own desktop-styled MatchCard would clash with the new mobile
                      card design, and isn't part of the mobile redesign's scope. */}
                  {!isMobile && (
                    <BestMatches
                      listings={allListings}
                      referenceListing={myListings.find(l => l.type === 'rider' && l.status === 'open')}
                      currentUserId={currentUser.id} currentUserInterests={currentUser.profile.interests}
                      onConnect={onConnect} showToast={showToast} onMatchedIds={setMatchedListingIds}
                    />
                  )}
                  <FeedView searchQuery={searchQuery} setSearchQuery={setSearchQuery} filterType={filterType} setFilterType={setFilterType} filterTag={filterTag} setFilterTag={setFilterTag} filterCarType={filterCarType} setFilterCarType={setFilterCarType} filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage} quickDateFilter={quickDateFilter} setQuickDateFilter={setQuickDateFilter} seatsNeeded={seatsNeeded} setSeatsNeeded={setSeatsNeeded} filterSheetOpen={filterSheetOpen} setFilterSheetOpen={setFilterSheetOpen} listings={filteredListings.filter(l => !matchedListingIds.includes(l.id))} onConnect={onConnect} loading={feedLoading} currentUserId={currentUser.id} setView={setView} hasLocation={!!userCoords} />
                </div>
              )
            )}
            {guardedView === 'feed' && isMobile && (
              <>
                <ViewToggleFab onClick={() => setView('map')} />
                <OfferRideFab mode={mode} onClick={() => setView('post')} />
              </>
            )}
            {guardedView === 'map' && <MapView userCoords={userCoords} currentUserId={currentUser.id} tripRoute={tripRoute} onClearRoute={() => setTripRoute(null)} drivingTo={drivingTo} onStopDriving={onStopDriving} />}
            {guardedView === 'pools' && <PoolView userCoords={userCoords} currentUserId={currentUser.id} showToast={showToast} />}
            {guardedView === 'post' && <PostView key={postPrefill?.key ?? 'new'} onPost={onPost} userCoords={userCoords} defaultType={mode} vehicle={currentUser.vehicle} prefill={postPrefill} onClearPrefill={() => setPostPrefill(null)} />}
            {guardedView === 'my-listings' && (
              <MyListingsView
                myListings={myListings} connections={connections} onCancel={onCancelListing}
                onManage={onManageListing} onViewMatches={onViewMatches} onClone={onCloneListing} onPostNew={() => setView('post')}
                userCoords={userCoords} currentUserId={currentUser.id} showToast={showToast}
              />
            )}
            {guardedView === 'connections' && (
              <InboxView
                connections={connections} currentUserId={currentUser.id}
                onAccept={onAccept} onDecline={onDecline} onCancel={onCancel} onComplete={onComplete}
                showToast={showToast} onViewRoute={onViewRoute} onStartDriving={onStartDriving} onMarkRead={onMarkRead}
                deepLink={connDeepLink} onDeepLinkHandled={() => setConnDeepLink(null)}
                listingFilter={inboxListingFilter} onClearListingFilter={() => setInboxListingFilter(null)}
                incomingMessage={incomingMessage} onMessageSent={onMessageSent}
              />
            )}
            {guardedView === 'notifications' && <NotificationsView notifications={notifications} onMarkAllRead={onMarkAllReadNotifs} onDismiss={onDismissNotif} onNavigate={onNotifNavigate} />}
            {guardedView === 'profile' && <ProfileView currentUser={currentUser} onProfileUpdate={setCurrentUser} />}
          </main>
        </div>
      </div>

      <BottomNav view={guardedView} setView={setView} unreadMessages={unreadMessages} />
    </div>
  )
}
