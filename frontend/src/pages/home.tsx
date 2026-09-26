import React, {
  useState, useMemo, useEffect, useCallback, useRef, useContext, type CSSProperties,
  useId,
} from 'react'
import {
  MapPin, Calendar, Users, Car, Search, ArrowRight, MessageCircle,
  Check, X, Fuel, ChevronRight, Home as HomeIcon, Dot, Bell, LogOut,
  Send, MoreHorizontal, Flag, UserX, UserPlus,
  ClipboardList, Shield, Map, Package, Camera, Moon, Sun,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { AuthUIContext } from '@neondatabase/neon-js/auth/react'
import { useTheme } from '@neondatabase/auth-ui'
import * as api from '../api'
import type { ApiUser, WsMessage } from '../api'
import { MapView } from '../MapView'
import type { TripRoute, DrivingTarget } from '../MapView'
import { PoolView } from '../PoolView'
import { authClient, fetchNeonJWT } from '../lib/auth'
import { useIsMobile } from '../lib/useIsMobile'
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
  flexibility: Flexibility; seats?: number; passengers?: number; tags: RideTag[]
  status: string; createdAt: string
}

interface Connection {
  id: string
  withUser: { name: string; initials: string; photoUrl: string | null }
  withUserId: string
  myRole: 'rider' | 'driver'
  route: string
  date: string
  status: ConnStatus
  splitConfirmed: boolean
  unreadMessages: number
  driverTripId: string
  rideRequestId: string
  pickupLat?: number; pickupLng?: number; pickupLabel?: string
  destLat?: number; destLng?: number; destLabel?: string
  riderPickupLat?: number; riderPickupLng?: number; riderPickupLabel?: string
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
    from: trip.pickup.label, to: trip.destination.label,
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
    from: req.pickup.label, to: req.destination.label,
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
    from: trip.pickup.label, to: trip.destination.label,
    date: trip.target_date, flexibility: apiFlexibility(trip.flexibility),
    seats: trip.seats_available,
    tags: trip.tags.filter((t): t is RideTag => t === 'airport' || t === 'student'),
    status: trip.status, createdAt: trip.created_at,
  }
}

function requestToMyListing(req: api.ApiRideRequest): MyListing {
  return {
    id: req.id, type: 'rider',
    from: req.pickup.label, to: req.destination.label,
    date: req.target_date, flexibility: apiFlexibility(req.flexibility),
    passengers: req.passenger_count,
    tags: req.tags.filter((t): t is RideTag => t === 'airport' || t === 'student'),
    status: req.status, createdAt: req.created_at,
  }
}

function apiConnectionToConnection(conn: api.ApiConnection, currentUserId: string): Connection {
  const isDriver = conn.driver_trip.driver_id === currentUserId
  const withUserId = isDriver ? conn.ride_request.rider_id : conn.driver_trip.driver_id
  const profile = isDriver ? conn.rider_profile : conn.driver_profile
  const otherName = profile?.display_name ?? (isDriver ? 'Rider' : 'Driver')
  const trip = conn.driver_trip
  return {
    id: conn.id,
    withUser: { name: otherName, initials: toInitials(otherName), photoUrl: profile?.photo_url ?? null },
    withUserId,
    myRole: isDriver ? 'driver' : 'rider',
    route: `${trip.pickup.label} → ${trip.destination.label}`,
    date: trip.target_date,
    status: conn.status as ConnStatus,
    splitConfirmed: false, unreadMessages: 0,
    driverTripId: conn.driver_trip_id, rideRequestId: conn.ride_request_id,
    pickupLat: trip.pickup.latitude,
    pickupLng: trip.pickup.longitude,
    pickupLabel: trip.pickup.label,
    destLat: trip.destination.latitude,
    destLng: trip.destination.longitude,
    destLabel: trip.destination.label,
    riderPickupLat: conn.ride_request.pickup.latitude,
    riderPickupLng: conn.ride_request.pickup.longitude,
    riderPickupLabel: conn.ride_request.pickup.label,
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
    pending:   { label: 'Pending',   cls: 'bg-amber-100 text-amber-800' },
    accepted:  { label: 'Accepted',  cls: 'bg-green-100 text-green-800' },
    declined:  { label: 'Declined',  cls: 'bg-red-100 text-red-700' },
    completed: { label: 'Completed', cls: 'bg-slate-100 text-slate-600' },
    cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500' },
    expired:   { label: 'Expired',   cls: 'bg-slate-100 text-slate-400' },
  }
  const { label, cls } = cfg[status]
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
}

function ListingStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    open:      'bg-green-100 text-green-800',
    matched:   'bg-blue-100 text-blue-800',
    expired:   'bg-slate-100 text-slate-500',
    cancelled: 'bg-red-100 text-red-600',
    completed: 'bg-slate-100 text-slate-600',
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

function ListingCard({ listing, onConnect, currentUserId, alreadyConnected }: { listing: Listing; onConnect: (l: Listing) => void; currentUserId: string; alreadyConnected: boolean }) {
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
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full shrink-0 ${isDriver ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-amber-700'}`}>
          {isDriver ? 'Offering ride' : 'Needs ride'}
        </span>
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
          Your post
        </div>
      ) : alreadyConnected ? (
        <div className="mt-auto w-full py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-medium flex items-center justify-center gap-2">
          <Check className="size-4" />{isDriver ? 'Request sent' : 'Offer sent'}
        </div>
      ) : (
        <button
          onClick={() => onConnect(listing)}
          className="mt-auto w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
        >
          {isDriver ? 'Request to join' : 'Offer a ride'}
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

function MatchCard({ match, rank, onConnect, showToast, alreadyConnected }: {
  match: EnrichedMatch; rank: number
  onConnect: (l: Listing) => Promise<void>; showToast: (msg: string, type: 'success' | 'error') => void
  alreadyConnected: boolean
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
        {alreadyConnected ? (
          <div className="flex-1 py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-medium flex items-center justify-center gap-1.5">
            <Check className="size-4" />Request sent
          </div>
        ) : (
          <button onClick={handleRequest} disabled={requesting} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 active:scale-[0.98] transition-all">
            {requesting ? 'Requesting…' : 'Instant Request Match'}
          </button>
        )}
        <button onClick={() => setExpanded(v => !v)} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">
          {expanded ? 'Hide' : 'View Route'}
        </button>
      </div>
    </motion.div>
  )
}

function BestMatches({ listings, referenceListing, currentUserId, currentUserInterests, onConnect, showToast, onMatchedIds, connectedListingIds }: {
  listings: Listing[]; referenceListing: MyListing | undefined
  currentUserId: string; currentUserInterests: string[]
  onConnect: (l: Listing) => Promise<void>; showToast: (msg: string, type: 'success' | 'error') => void
  onMatchedIds: (ids: string[]) => void
  connectedListingIds: Set<string>
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
          {matches.map((m, i) => <MatchCard key={m.listing.id} match={m} rank={i} onConnect={onConnect} showToast={showToast} alreadyConnected={connectedListingIds.has(m.listing.apiId)} />)}
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
  filterSheetOpen, setFilterSheetOpen, connectedListingIds,
}: {
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
  connectedListingIds: Set<string>
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
    const now = new Date()
    const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
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
      <div className="space-y-4">
        <MobileSearchBar value={searchQuery} onChange={setSearchQuery} />
        <MobileFilterBar
          onOpenFilters={() => setFilterSheetOpen(true)}
          activeCount={activeFilterCount}
          quickDate={quickDateFilter} onQuickDate={setQuickDateFilter}
          seatsNeeded={seatsNeeded} onSeatsNeeded={setSeatsNeeded}
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
              <MobileListingCard key={m.listing.id} listing={m.listing} onConnect={l => { onConnect(l).then(() => showToast('Ride offered!', 'success')).catch(e => showToast(e instanceof Error ? e.message : 'Failed', 'error')) }} currentUserId={currentUserId} onEditOwn={() => setView('my-listings')} alreadyConnected={connectedListingIds.has(m.listing.apiId)} />
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
                {connectedListingIds.has(m.listing.apiId) ? (
                  <span className="shrink-0 px-4 py-2 rounded-xl bg-muted text-muted-foreground text-sm font-medium flex items-center gap-1.5"><Check className="size-4" />Offered</span>
                ) : (
                  <button onClick={() => onConnect(m.listing).then(() => showToast('Ride offered!', 'success')).catch(e => showToast(e instanceof Error ? e.message : 'Failed', 'error'))} className="shrink-0 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                    Offer Ride
                  </button>
                )}
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
  listings, onConnect, loading, currentUserId, setView, connectedListingIds,
}: {
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
  connectedListingIds: Set<string>
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const isMobile = useIsMobile()

  if (isMobile) {
    const activeFilterCount = [filterType !== 'all', filterTag !== '', filterCarType !== '', filterLuggage !== ''].filter(Boolean).length
    return (
      <div className="space-y-4">
        <MobileSearchBar value={searchQuery} onChange={setSearchQuery} />
        <MobileFilterBar
          onOpenFilters={() => setFilterSheetOpen(true)}
          activeCount={activeFilterCount}
          quickDate={quickDateFilter} onQuickDate={setQuickDateFilter}
          seatsNeeded={seatsNeeded} onSeatsNeeded={setSeatsNeeded}
        />
        <SectionHeader label="Nearby Drivers" count={listings.length} noun={listings.length === 1 ? 'driver' : 'drivers'} />
        {loading ? (
          <p className="text-sm text-muted-foreground animate-pulse text-center py-10">Loading…</p>
        ) : listings.length > 0 ? (
          <div className="space-y-3">
            {listings.map(l => (
              <MobileListingCard key={l.id} listing={l} onConnect={onConnect} currentUserId={currentUserId} onEditOwn={() => setView('my-listings')} alreadyConnected={connectedListingIds.has(l.apiId)} />
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {listings.map(l => <ListingCard key={l.id} listing={l} onConnect={onConnect} currentUserId={currentUserId} alreadyConnected={connectedListingIds.has(l.apiId)} />)}
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

function PostView({ onPost, userCoords, defaultType, vehicle: myVehicle }: {
  onPost: (listing: MyListing) => void; userCoords: { lat: number; lng: number } | null
  defaultType: ListingType; vehicle: api.ApiVehicle
}) {
  const [type, setType] = useState<ListingType>(defaultType)
  const [from, setFrom] = useState<LocationValue | null>(null)
  const [to, setTo] = useState<LocationValue | null>(null)
  const [date, setDate] = useState('')
  const [flexibility, setFlexibility] = useState<Flexibility>('morning')
  const [seats, setSeats] = useState(myVehicle?.seats ? String(myVehicle.seats) : '3')
  const [passengers, setPassengers] = useState('1')
  const [gasEstimate, setGasEstimate] = useState('')
  const [tags, setTags] = useState<Set<RideTag>>(new Set())
  const [vehicle, setVehicle] = useState(myVehicle ? [myVehicle.color, myVehicle.make, myVehicle.model].filter(Boolean).join(' ') : '')
  const [carType, setCarType] = useState<CarType | ''>((myVehicle?.car_type as CarType) ?? '')
  const [luggageSize, setLuggageSize] = useState<LuggageSize>('none')
  const [luggageCapacity, setLuggageCapacity] = useState<LuggageSize>('medium')
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
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Post a listing</h1>
        <p className="text-muted-foreground mt-1">Share your trip or request a ride.</p>
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

// ─── My Listings view ─────────────────────────────────────────────────────────

function MyListingsView({ myListings, onCancel, userCoords, currentUserId, showToast }: {
  myListings: MyListing[]; onCancel: (listing: MyListing) => Promise<void>
  userCoords: { lat: number; lng: number } | null; currentUserId: string
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<'driver' | 'rider' | 'pools'>('driver')
  const [cancelling, setCancelling] = useState<string | null>(null)
  const shown = myListings.filter(l => l.type === tab)
  const handleCancel = async (listing: MyListing) => {
    setCancelling(listing.id); try { await onCancel(listing) } finally { setCancelling(null) }
  }
  // Pools is a standalone Sidebar entry on desktop already — only surface it
  // as a third tab here on mobile, where the bottom nav was trimmed to 4 tabs.
  const tabs = isMobile ? (['driver', 'rider', 'pools'] as const) : (['driver', 'rider'] as const)
  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">My Rides</h1>
        <p className="text-muted-foreground mt-1">Your posted driver trips and ride requests.</p>
      </div>
      <div className="flex rounded-xl bg-muted p-1 gap-1">
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'driver' ? 'Driver Trips' : t === 'rider' ? 'Ride Requests' : 'Pools'}
          </button>
        ))}
      </div>
      {tab === 'pools' ? (
        <PoolView userCoords={userCoords} currentUserId={currentUserId} showToast={showToast} />
      ) : shown.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <ClipboardList className="size-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No {tab === 'driver' ? 'driver trips' : 'ride requests'} yet</p>
          <p className="text-sm mt-1">Post one from the Post tab.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map(listing => (
            <motion.div key={listing.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="bg-card rounded-2xl border border-border p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground truncate">{listing.from}</span>
                    <ArrowRight className="size-3 text-muted-foreground shrink-0" />
                    <span className="font-semibold truncate">{listing.to}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground pl-5">
                    <Calendar className="size-3" /><span>{listing.date}</span><Dot className="size-3" /><span>{FLEX_LABEL[listing.flexibility]}</span>
                    {listing.seats != null && <><Dot className="size-3" /><span>{listing.seats} seats</span></>}
                    {listing.passengers != null && <><Dot className="size-3" /><span>{listing.passengers} passenger{listing.passengers > 1 ? 's' : ''}</span></>}
                  </div>
                  {listing.tags.length > 0 && <div className="flex gap-1.5 pl-5 pt-1">{listing.tags.map(tag => <TagPill key={tag} tag={tag} />)}</div>}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <ListingStatusBadge status={listing.status} />
                  {listing.status === 'open' && (
                    <button onClick={() => handleCancel(listing)} disabled={cancelling === listing.id} className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50">
                      {cancelling === listing.id ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Connection card ──────────────────────────────────────────────────────────

function ConnectionCard({
  connection, currentUserId, onAccept, onDecline, onCancel, onComplete, showToast, onViewRoute, onStartDriving, onOpenChat,
  autoOpen, isActive, onActivate,
}: {
  connection: Connection; currentUserId: string
  onAccept: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>; onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
  onViewRoute: (conn: Connection) => void
  onStartDriving: (conn: Connection) => void
  onOpenChat: (conn: Connection) => void
  autoOpen?: 'gassplit' | null
  isActive: boolean
  onActivate: () => void
}) {
  const [expanded, setExpanded] = useState<'gassplit' | 'blockreport' | null>(null)

  // Another card became the active one — collapse this one so only a single
  // panel is ever open across the inbox at a time.
  useEffect(() => {
    if (!isActive) setExpanded(null)
  }, [isActive])
  const [gasSuggestion, setGasSuggestion] = useState<api.GasSplitSuggestion | null>(null)
  const [splitAmount, setSplitAmount] = useState('')
  const [splitDone, setSplitDone] = useState(connection.splitConfirmed)
  const [reportReason, setReportReason] = useState('')
  const [reportMode, setReportMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const toggleSection = async (section: 'gassplit' | 'blockreport') => {
    const next = expanded === section ? null : section
    setExpanded(next)
    if (next !== null) onActivate()
    if (next === 'gassplit' && !gasSuggestion) {
      try { const s = await api.suggestGasSplit(connection.id); setGasSuggestion(s); setSplitAmount(String((s.amount_cents / 100).toFixed(2))) } catch { /* ignore */ }
    }
  }

  // Deep link from a notification: open the right panel and scroll to this card.
  // (Chat deep links skip this entirely — they open the full-screen chat instead.)
  useEffect(() => {
    if (!autoOpen) return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    toggleSection(autoOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen])

  const confirmSplit = async () => {
    const cents = Math.round(parseFloat(splitAmount) * 100)
    if (isNaN(cents) || cents < 1) return
    try { await api.confirmGasSplit(connection.id, cents, gasSuggestion?.assumptions ?? {}); setSplitDone(true); showToast('Split confirmed ✓', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to confirm', 'error') }
  }

  const handleAccept = async () => { setBusy(true); try { await onAccept(connection.id); showToast('Connection accepted', 'success') } catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') } finally { setBusy(false) } }
  const handleDecline = async () => { setBusy(true); try { await onDecline(connection.id); showToast('Connection declined', 'success') } catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') } finally { setBusy(false) } }
  const handleCancel = async () => { setBusy(true); try { await onCancel(connection.id); showToast('Connection cancelled', 'success') } catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') } finally { setBusy(false) } }
  const handleComplete = async () => { setBusy(true); try { await onComplete(connection.id); showToast('Ride completed!', 'success') } catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') } finally { setBusy(false) } }
  const handleBlock = async () => {
    try { await api.blockUser(connection.withUserId); showToast('User blocked', 'success'); setExpanded(null) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') }
  }
  const handleReport = async () => {
    if (!reportReason.trim()) return
    try { await api.reportUser(connection.withUserId, reportReason.trim()); showToast('Report submitted', 'success'); setReportReason(''); setReportMode(false); setExpanded(null) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Error', 'error') }
  }

  const { status } = connection
  const hasRouteCoords = !!(connection.pickupLat && connection.destLat)
  const hasRiderPickupCoords = !!(connection.riderPickupLat && connection.riderPickupLng)

  return (
    <motion.div ref={cardRef} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={`bg-card rounded-3xl border overflow-hidden transition-colors ${autoOpen ? 'border-primary/50 ring-2 ring-primary/20' : 'border-border'}`}>
      {/* Header strip */}
      <div className="px-6 pt-6 pb-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          {/* Partner info */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative shrink-0">
              <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="md" />
              {connection.unreadMessages > 0 && (
                <span className="absolute -top-1 -right-1 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{connection.unreadMessages > 9 ? '9+' : connection.unreadMessages}</span>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{connection.myRole === 'driver' ? 'You are driving' : 'You are riding with'}</span>
              </div>
              <h2 className="text-base font-semibold text-foreground truncate">{connection.withUser.name}</h2>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{connection.route}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-1">
              <button onClick={() => toggleSection('blockreport')} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"><MoreHorizontal className="size-4" /></button>
            </div>
            <ConnStatusBadge status={status} />
          </div>
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Calendar className="size-3.5" />{connection.date}</span>
          {splitDone && <span className="inline-flex items-center gap-1 text-green-700"><Check className="size-3.5" />Split confirmed</span>}
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-6 pb-4 flex flex-wrap gap-2">
        {status === 'pending' && (
          <>
            <button onClick={handleAccept} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"><Check className="size-4" />Accept</button>
            <button onClick={handleDecline} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60 transition-colors"><X className="size-4" />Decline</button>
            <button onClick={() => onOpenChat(connection)} className="relative inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
              <MessageCircle className="size-4" />Message
              {connection.unreadMessages > 0 && <span className="ml-1 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{connection.unreadMessages}</span>}
            </button>
            <button onClick={handleCancel} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-60 transition-colors">Cancel</button>
          </>
        )}
        {status === 'accepted' && (
          <>
            <button onClick={() => onOpenChat(connection)} className="relative inline-flex items-center gap-1.5 rounded-2xl bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors">
              <MessageCircle className="size-4" />Chat
              {connection.unreadMessages > 0 && <span className="ml-1 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{connection.unreadMessages}</span>}
            </button>
            {hasRouteCoords && (
              <button onClick={() => onViewRoute(connection)} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                <Map className="size-4" />Route
              </button>
            )}
            {connection.myRole === 'driver' && hasRiderPickupCoords && (
              <button onClick={() => onStartDriving(connection)} className="inline-flex items-center gap-1.5 rounded-2xl bg-green-600 text-white px-4 py-2 text-sm font-semibold hover:bg-green-700 transition-colors">
                <Car className="size-4" />Start Driving
              </button>
            )}
            <button onClick={() => toggleSection('gassplit')} className={`inline-flex items-center gap-1.5 rounded-2xl px-4 py-2 text-sm font-medium transition-colors ${expanded === 'gassplit' ? 'bg-accent/20 text-amber-800' : 'border border-border text-foreground hover:bg-muted'}`}><Fuel className="size-4" />Gas Split</button>
            <button onClick={handleComplete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60 transition-colors"><Check className="size-4" />Complete</button>
            <button onClick={handleCancel} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-60 transition-colors">Cancel</button>
          </>
        )}
      </div>

      {/* Gas split panel */}
      {expanded === 'gassplit' && status === 'accepted' && (
        <div className="border-t border-border bg-muted/30 px-6 py-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Confirm Gas Split</p>
          {gasSuggestion ? (
            <>
              <p className="text-sm text-muted-foreground">Suggested: <span style={MONO} className="text-foreground font-medium">${(gasSuggestion.amount_cents / 100).toFixed(2)}</span></p>
              {splitDone ? (
                <p className="text-sm text-green-700 font-medium flex items-center gap-1"><Check className="size-4" />Split confirmed</p>
              ) : (
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1 max-w-[140px]">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                    <input type="number" step="0.01" min="0.01" value={splitAmount} onChange={e => setSplitAmount(e.target.value)} className="w-full pl-7 pr-3 py-2 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20" />
                  </div>
                  <button onClick={confirmSplit} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Confirm</button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Payment happens outside the app.</p>
            </>
          ) : <p className="text-sm text-muted-foreground animate-pulse">Loading suggestion…</p>}
        </div>
      )}

      {/* Block/report panel */}
      {expanded === 'blockreport' && (
        <div className="border-t border-border bg-muted/30 px-6 py-4 space-y-3">
          {!reportMode ? (
            <div className="flex gap-2">
              <button onClick={handleBlock} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm text-foreground hover:bg-muted transition-colors"><UserX className="size-4" />Block</button>
              <button onClick={() => setReportMode(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm text-foreground hover:bg-muted transition-colors"><Flag className="size-4" />Report</button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Reason</label>
              <input type="text" value={reportReason} onChange={e => setReportReason(e.target.value)} placeholder="Describe the issue…" className="w-full px-3 py-2 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20" />
              <div className="flex gap-2">
                <button onClick={handleReport} disabled={!reportReason.trim()} className="px-3 py-2 rounded-xl bg-destructive text-white text-sm font-medium disabled:opacity-50">Submit</button>
                <button onClick={() => setReportMode(false)} className="px-3 py-2 rounded-xl border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}

// ─── Full-screen chat ─────────────────────────────────────────────────────────
// Its own dedicated screen rather than an accordion panel wedged inside a card
// already crowded with route/gas-split/complete/cancel buttons — the chat
// itself is the thing people spend the most time in, so it gets the room.

function FullScreenChatView({ connection, currentUserId, onClose, showToast, incomingMessage }: {
  connection: Connection; currentUserId: string
  onClose: () => void
  showToast: (msg: string, type: 'success' | 'error') => void
  incomingMessage: { connectionId: string; message: api.ApiMessage } | null
}) {
  const [msgs, setMsgs] = useState<api.ApiMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [msgText, setMsgText] = useState('')
  const [sending, setSending] = useState(false)
  const msgEndRef = useRef<HTMLDivElement>(null)
  const { status } = connection

  useEffect(() => {
    let cancelled = false
    api.getMessages(connection.id).then(fetched => {
      if (cancelled) return
      setMsgs(fetched); setLoaded(true)
      setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'auto' }), 50)
    }).catch(() => setLoaded(true))
    return () => { cancelled = true }
  }, [connection.id])

  // Live-append a message that arrives over the websocket while this chat is
  // already open, instead of only reflecting it as an unread-count bump.
  useEffect(() => {
    if (!incomingMessage || incomingMessage.connectionId !== connection.id) return
    setMsgs(prev => prev.some(m => m.id === incomingMessage.message.id) ? prev : [...prev, incomingMessage.message])
    setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [incomingMessage, connection.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sendCanned = async (key: string) => {
    setSending(true)
    try { const msg = await api.sendCannedMessage(connection.id, key); setMsgs(prev => [...prev, msg]); setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to send', 'error') }
    finally { setSending(false) }
  }

  const sendFree = async () => {
    if (!msgText.trim()) return; setSending(true)
    try { const msg = await api.sendMessage(connection.id, msgText.trim()); setMsgs(prev => [...prev, msg]); setMsgText(''); setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to send', 'error') }
    finally { setSending(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col" role="dialog" aria-modal="true" aria-label={`Chat with ${connection.withUser.name}`}>
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border">
        <button onClick={onClose} aria-label="Close chat" className="p-2 -ml-2 rounded-full hover:bg-muted text-foreground transition-colors">
          <X className="size-5" />
        </button>
        <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="md" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground truncate">{connection.withUser.name}</h2>
          <p className="text-xs text-muted-foreground truncate">{connection.route} · {status === 'pending' ? 'Pending connection' : 'Accepted'}</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5 max-w-2xl w-full mx-auto">
        {msgs.map(m => {
          const isMine = m.sender_id === currentUserId
          return (
            <div key={m.id} className={`flex items-end gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
              {!isMine && <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="sm" />}
              <div className={`max-w-[75%] space-y-0.5 ${isMine ? 'items-end' : 'items-start'} flex flex-col`}>
                {!isMine && <span className="text-[10px] text-muted-foreground pl-1">{connection.withUser.name}</span>}
                <div className={`px-3.5 py-2 rounded-2xl text-sm leading-snug ${isMine ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-card text-foreground border border-border rounded-bl-sm'}`}>
                  {m.content}
                </div>
                <span className="text-[10px] text-muted-foreground px-1">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          )
        })}
        {msgs.length === 0 && loaded && (
          <p className="text-sm text-muted-foreground text-center py-10">No messages yet. Say hi!</p>
        )}
        <div ref={msgEndRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border p-4 max-w-2xl w-full mx-auto">
        {status === 'pending' ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Quick messages while connection is pending:</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(CANNED_MESSAGES).map(([key, text]) => (
                <button key={key} onClick={() => sendCanned(key)} disabled={sending} className="px-3 py-1.5 rounded-xl bg-muted border border-border text-sm text-foreground hover:bg-muted/70 disabled:opacity-50 transition-colors text-left">{text}</button>
              ))}
            </div>
          </div>
        ) : status === 'accepted' ? (
          <div className="flex gap-2">
            <input type="text" autoFocus value={msgText} onChange={e => setMsgText(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendFree()} placeholder={`Message ${connection.withUser.name}…`} className="flex-1 px-3.5 py-2.5 rounded-2xl bg-muted border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors" />
            <button onClick={sendFree} disabled={sending || !msgText.trim()} className="px-3.5 py-2.5 rounded-2xl bg-primary text-primary-foreground disabled:opacity-50 transition-colors"><Send className="size-4" /></button>
          </div>
        ) : <p className="text-sm text-muted-foreground text-center">Chat unavailable in this state.</p>}
      </div>
    </div>
  )
}

// ─── Connections view ─────────────────────────────────────────────────────────

function ConnectionsView({ connections, currentUserId, onAccept, onDecline, onCancel, onComplete, showToast, onViewRoute, onStartDriving, onOpenChat, deepLink }: {
  connections: Connection[]; currentUserId: string
  onAccept: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>; onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
  onViewRoute: (conn: Connection) => void
  onStartDriving: (conn: Connection) => void
  onOpenChat: (conn: Connection) => void
  deepLink?: { connectionId: string; section: 'gassplit' } | null
}) {
  const totalUnread = connections.reduce((sum, c) => sum + c.unreadMessages, 0)
  // Only one card's chat/gas-split/report panel stays open at a time — opening
  // a different one collapses whatever was open before, instead of letting
  // several expand simultaneously and cluttering the inbox.
  const [openConnectionId, setOpenConnectionId] = useState<string | null>(null)
  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Inbox</h1>
        <p className="text-muted-foreground mt-1">
          {totalUnread > 0
            ? <span className="text-primary font-medium">{totalUnread} unread message{totalUnread !== 1 ? 's' : ''}</span>
            : 'Track pending offers, accepted rides, and chats.'}
        </p>
      </div>
      {connections.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <MessageCircle className="size-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No connections yet</p>
          <p className="text-sm mt-1">Connect with a driver or rider from the feed.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {connections.map(c => (
            <ConnectionCard key={c.id} connection={c} currentUserId={currentUserId}
              onAccept={onAccept} onDecline={onDecline} onCancel={onCancel} onComplete={onComplete}
              showToast={showToast} onViewRoute={onViewRoute} onStartDriving={onStartDriving} onOpenChat={onOpenChat}
              autoOpen={deepLink?.connectionId === c.id ? deepLink.section : null}
              isActive={openConnectionId === c.id} onActivate={() => setOpenConnectionId(c.id)} />
          ))}
        </div>
      )}
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

function ProfileView({ currentUser, onProfileUpdate, mode, onSetMode }: {
  currentUser: ApiUser; onProfileUpdate: (user: ApiUser) => void
  mode: ListingType; onSetMode: (m: ListingType) => void
}) {
  const profile = currentUser.profile
  const vehicle = currentUser.vehicle
  const [displayName, setDisplayName] = useState(profile.display_name)
  const [bio, setBio] = useState(profile.bio ?? '')
  const [interests, setInterests] = useState<string[]>(profile.interests ?? [])
  const [interestDraft, setInterestDraft] = useState('')
  const [nationality, setNationality] = useState(profile.nationality ?? '')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const addInterest = () => {
    const tag = interestDraft.trim()
    if (tag && !interests.includes(tag)) setInterests(prev => [...prev, tag])
    setInterestDraft('')
  }
  const removeInterest = (tag: string) => setInterests(prev => prev.filter(t => t !== tag))
  const [make, setMake] = useState(vehicle?.make ?? '')
  const [model, setModel] = useState(vehicle?.model ?? '')
  const [color, setColor] = useState(vehicle?.color ?? '')
  const [vSeats, setVSeats] = useState(String(vehicle?.seats ?? ''))
  const [vCarType, setVCarType] = useState(vehicle?.car_type ?? '')
  const [hasLicense, setHasLicense] = useState(vehicle?.has_license ?? false)
  const [hasInsurance, setHasInsurance] = useState(vehicle?.has_insurance ?? false)
  const [hasRecord, setHasRecord] = useState(vehicle?.has_good_driving_record ?? false)
  const [vehicleSaving, setVehicleSaving] = useState(false)
  const [vehicleMsg, setVehicleMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const saveProfile = async () => {
    setProfileSaving(true); setProfileMsg(null)
    try {
      const updated = await api.updateProfile(displayName, profile.photo_url, bio || null, interests, nationality || null)
      onProfileUpdate({
        ...currentUser,
        profile: { ...profile, display_name: updated.display_name, bio: updated.bio, interests: updated.interests, nationality: updated.nationality },
      })
      setProfileMsg({ text: 'Profile saved', ok: true })
    } catch (e) { setProfileMsg({ text: e instanceof Error ? e.message : 'Failed to save', ok: false }) }
    finally { setProfileSaving(false) }
  }

  const saveVehicle = async () => {
    setVehicleSaving(true); setVehicleMsg(null)
    try {
      const v = await api.updateDriverReadiness({
        make: make || undefined, model: model || undefined, color: color || undefined,
        seats: vSeats ? parseInt(vSeats, 10) : undefined, car_type: vCarType || undefined,
        has_license: hasLicense, has_insurance: hasInsurance, has_good_driving_record: hasRecord,
      })
      onProfileUpdate({ ...currentUser, vehicle: v })
      setVehicleMsg({ text: 'Vehicle saved', ok: true })
    } catch (e) { setVehicleMsg({ text: e instanceof Error ? e.message : 'Failed to save', ok: false }) }
    finally { setVehicleSaving(false) }
  }

  const inputCls = 'w-full px-3 py-2.5 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors'

  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] bg-card border border-border p-8">
        <div className="flex flex-wrap items-center gap-6">
          <div className="relative group">
            {profile.photo_url ? (
              <img src={profile.photo_url} alt="Profile" className="size-14 rounded-full object-cover ring-2 ring-primary/20" />
            ) : (
              <Avatar initials={toInitials(profile.display_name)} size="lg" />
            )}
            <label className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
              <Camera className="size-5 text-white" />
              <input type="file" accept="image/*" className="sr-only" onChange={async (e) => {
                const file = e.target.files?.[0]; if (!file) return
                const reader = new FileReader()
                reader.onload = async (ev) => {
                  const dataUrl = ev.target?.result as string
                  try { const updated = await api.uploadPhoto(dataUrl); onProfileUpdate({ ...currentUser, profile: { ...profile, photo_url: updated.photo_url, photo_verified: true } }) }
                  catch (err) { alert(err instanceof Error ? err.message : 'Upload failed') }
                }
                reader.readAsDataURL(file)
              }} />
            </label>
            {profile.photo_verified && (
              <span className="absolute -bottom-1 -right-1 size-5 bg-green-500 rounded-full flex items-center justify-center"><Check className="size-3 text-white" /></span>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Your profile{profile.photo_verified ? ' · ✓ Photo verified' : ' · Hover photo to upload'}</p>
            <h2 className="mt-2 text-2xl font-semibold text-foreground">{profile.display_name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{currentUser.email}</p>
          </div>
        </div>
      </div>

      <div className="rounded-3xl bg-card border border-border p-6 space-y-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Riding as</h3>
          <p className="text-sm text-muted-foreground mt-0.5">Switch between browsing as a passenger looking for a ride, or a driver offering one.</p>
        </div>
        <div className="flex rounded-xl bg-muted p-1 gap-1" role="group" aria-label="Passenger or Driver mode">
          {(['rider', 'driver'] as ListingType[]).map(m => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => onSetMode(m)} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {m === 'rider' ? 'Passenger' : 'Driver'}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-3xl bg-card border border-border p-6 space-y-4">
        <h3 className="text-base font-semibold text-foreground">Edit Profile</h3>
        <div className="space-y-3">
          <div className="space-y-1.5"><label className="text-sm font-medium">Display name</label><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} /></div>
          <div className="space-y-1.5"><label className="text-sm font-medium">Bio</label><textarea value={bio} onChange={e => setBio(e.target.value)} rows={3} placeholder="Tell others a bit about yourself…" className={`${inputCls} resize-none`} /></div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Nationality <span className="text-muted-foreground font-normal">(optional)</span></label>
            <input value={nationality} onChange={e => setNationality(e.target.value)} placeholder="e.g. Kenyan" className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Interests <span className="text-muted-foreground font-normal">(optional icebreakers, e.g. "Loves Afrobeat")</span></label>
            {interests.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1">
                {interests.map(tag => (
                  <span key={tag} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium">
                    {tag}
                    <button type="button" onClick={() => removeInterest(tag)} aria-label={`Remove ${tag}`} className="hover:text-foreground"><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <input
              value={interestDraft} onChange={e => setInterestDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInterest() } }}
              onBlur={addInterest}
              placeholder="Type an interest and press Enter…" className={inputCls}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={saveProfile} disabled={profileSaving} className="px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">{profileSaving ? 'Saving…' : 'Save profile'}</button>
          {profileMsg && <p className={`text-sm ${profileMsg.ok ? 'text-green-700' : 'text-red-500'}`}>{profileMsg.text}</p>}
        </div>
      </div>

      <div className="rounded-3xl bg-card border border-border p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">Driver Readiness</h3>
          <p className="text-sm text-muted-foreground mt-1">Vehicle details and self-declared eligibility.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[['Make', make, setMake], ['Model', model, setModel], ['Color', color, setColor]].map(([label, val, setter]) => (
            <div key={label as string} className="space-y-1.5">
              <label className="text-sm font-medium">{label as string}</label>
              <input value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)} placeholder={label as string} className={inputCls} />
            </div>
          ))}
          <div className="space-y-1.5"><label className="text-sm font-medium">Seats</label><input type="number" min="1" max="9" value={vSeats} onChange={e => setVSeats(e.target.value)} className={inputCls} /></div>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Vehicle type</label>
          <div className="flex flex-wrap gap-2">
            {(['sedan', 'suv', 'van', 'minivan', 'truck', 'other'] as CarType[]).map(ct => (
              <button key={ct} type="button" onClick={() => setVCarType(vCarType === ct ? '' : ct)} className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${vCarType === ct ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                {CAR_TYPE_EMOJI[ct]} {CAR_TYPE_LABELS[ct]}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {([['has_license', "I have a valid driver's license", hasLicense, setHasLicense], ['has_insurance', 'I have valid car insurance', hasInsurance, setHasInsurance], ['has_record', 'I have a good driving record', hasRecord, setHasRecord]] as [string, string, boolean, (v: boolean) => void][]).map(([key, label, val, setter]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={val} onChange={() => setter(!val)} className="form-checkbox h-4 w-4 rounded border-border bg-input-background text-primary focus:ring-ring" />
              {label}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={saveVehicle} disabled={vehicleSaving} className="px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">{vehicleSaving ? 'Saving…' : 'Save vehicle'}</button>
          {vehicleMsg && <p className={`text-sm ${vehicleMsg.ok ? 'text-green-700' : 'text-red-500'}`}>{vehicleMsg.text}</p>}
        </div>
      </div>

      <div className="rounded-3xl bg-muted p-6">
        <p className="text-sm font-semibold text-foreground">Identity</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {currentUser.email_domain ? `Verified domain: ${currentUser.email_domain}` : 'Use a verified email domain to establish trust.'}
        </p>
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

function TopBar({ setView, currentUser, unreadCount, onSignOut, initials, darkMode, onToggleDark, mode, onSetMode }: {
  setView: (v: View) => void; currentUser: ApiUser | null; unreadCount: number
  onSignOut: () => void; initials: string; darkMode: boolean; onToggleDark: () => void
  mode: ListingType; onSetMode: (m: ListingType) => void
}) {
  return (
    <header className="sticky top-0 z-40 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
      <div className="max-w-[1240px] mx-auto px-4 lg:px-8 h-14 flex items-center justify-between gap-4">
        <button onClick={() => setView('feed')} className="text-sm font-semibold text-sidebar-foreground hover:text-sidebar-primary transition-colors xl:text-base">Let's Carpool</button>
        {currentUser ? (
          <div className="flex items-center gap-2">
            {/* Relocated to Profile on mobile — this screen is too cramped for it, and it's a settings-style choice, not a per-screen action. */}
            <div className="hidden xl:flex rounded-xl bg-sidebar-accent p-0.5 gap-0.5 mr-1" role="group" aria-label="Passenger or Driver mode">
              {(['rider', 'driver'] as ListingType[]).map(m => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => onSetMode(m)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${mode === m ? 'bg-white text-sidebar shadow-sm' : 'text-sidebar-foreground/65 hover:text-sidebar-foreground'}`}>
                  {m === 'rider' ? 'Passenger' : 'Driver'}
                </button>
              ))}
            </div>
            <button onClick={onToggleDark} className="p-2 rounded-xl hover:bg-sidebar-accent text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors" aria-label="Toggle dark mode">
              {darkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
            <button onClick={() => setView('notifications')} className="relative p-2 rounded-xl hover:bg-sidebar-accent text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors" aria-label="Notifications">
              <Bell className="size-5" />
              {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[10px] font-bold">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
            <button onClick={() => setView('profile')} className="size-8 rounded-full bg-sidebar-accent text-sidebar-foreground text-xs font-semibold flex items-center justify-center hover:ring-2 hover:ring-sidebar-primary/40 transition-all" aria-label="Account" style={MONO}>{initials}</button>
            <button onClick={onSignOut} className="hidden xl:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors" aria-label="Sign out"><LogOut className="size-4" /><span>Sign out</span></button>
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
  // Trimmed to 4 core tabs — Map is now a toggle inside Discover, Pools lives
  // inside My Rides, and ride creation moved to the Discover FAB.
  const items: Array<{ id: View; label: string; icon: React.ReactNode }> = [
    { id: 'feed', label: 'Discover', icon: <Search className="size-5" /> },
    { id: 'my-listings', label: 'My Rides', icon: <Car className="size-5" /> },
    { id: 'connections', label: 'Inbox', icon: <MessageCircle className="size-5" /> },
    { id: 'profile', label: 'Profile', icon: <Shield className="size-5" /> },
  ]
  return (
    <nav className="xl:hidden fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t border-border z-40">
      <div className="flex items-center justify-around px-2 h-16">
        {items.map(({ id, label, icon }) => {
          const active = view === id
          const badge = id === 'connections' ? unreadMessages : 0
          return (
            <button key={id} onClick={() => setView(id)} aria-label={label} className={`relative flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-colors ${active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
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

function Sidebar({ view, setView, onSignOut }: { view: View; setView: (v: View) => void; onSignOut: () => void }) {
  const items: Array<{ id: View; label: string }> = [
    { id: 'feed', label: 'Discover' }, { id: 'map', label: 'Live Map' }, { id: 'pools', label: 'Pools' },
    { id: 'post', label: 'Post' }, { id: 'my-listings', label: 'My Rides' },
    { id: 'connections', label: 'Connections' }, { id: 'notifications', label: 'Notifications' }, { id: 'profile', label: 'Profile' },
  ]
  return (
    <aside className="bg-sidebar border border-sidebar-border rounded-[2rem] p-6 xl:h-fit">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-sidebar-foreground/60">Carpooling app</p>
          <h1 className="mt-2 text-2xl font-semibold text-sidebar-foreground">Let's Carpool</h1>
        </div>
        <div className="rounded-3xl bg-sidebar-primary px-3 py-2 text-white text-xs font-semibold">MVP</div>
      </div>
      <div className="mt-8 space-y-1.5">
        {items.map(item => (
          <button key={item.id} type="button" onClick={() => setView(item.id)} className={`w-full rounded-3xl px-4 py-3 text-left text-sm font-medium transition-all ${view === item.id ? 'bg-sidebar-primary text-white shadow-lg shadow-sidebar-primary/20' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`}>
            {item.label}
          </button>
        ))}
        <button type="button" onClick={onSignOut} className="w-full rounded-3xl px-4 py-3 text-left text-sm font-medium text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all flex items-center gap-2"><LogOut className="size-4" />Sign out</button>
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

export function Home() {
  const navigate = useNavigate()
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
  const [view, setView] = useState<View>('feed')

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

  // ── Connections ──
  const [connections, setConnections] = useState<Connection[]>([])
  const connectionsRef = useRef<Connection[]>([])
  useEffect(() => { connectionsRef.current = connections }, [connections])

  // ── Trip route (for Map view) ──
  const [tripRoute, setTripRoute] = useState<TripRoute | null>(null)

  // ── Driving-to-pickup (for Map view) ──
  const [drivingTo, setDrivingTo] = useState<DrivingTarget | null>(null)

  // ── Notifications ──
  const [notifications, setNotifications] = useState<api.ApiNotification[]>([])
  const [connDeepLink, setConnDeepLink] = useState<{ connectionId: string; section: 'gassplit' } | null>(null)

  // ── Full-screen chat ──
  const [openChatConnectionId, setOpenChatConnectionId] = useState<string | null>(null)
  const openChatConnectionIdRef = useRef<string | null>(null)
  useEffect(() => { openChatConnectionIdRef.current = openChatConnectionId }, [openChatConnectionId])
  const [incomingChatMessage, setIncomingChatMessage] = useState<{ connectionId: string; message: api.ApiMessage } | null>(null)

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
        const chatIsOpenForThis = openChatConnectionIdRef.current === msg.connection_id
        if (chatIsOpenForThis) {
          // Already looking at this conversation — live-append instead of
          // bumping an unread badge and popping a toast over its own screen.
          setIncomingChatMessage({ connectionId: msg.connection_id, message: msg.message })
        } else {
          setConnections(prev => prev.map(c => c.id === msg.connection_id ? { ...c, unreadMessages: c.unreadMessages + 1 } : c))
          const conn = connectionsRef.current.find(c => c.id === msg.connection_id)
          const senderName = conn?.withUser.name ?? 'Someone'
          const preview = msg.message.content.length > 45 ? msg.message.content.slice(0, 45) + '…' : msg.message.content
          showToastRef.current(`💬 ${senderName}: ${preview}`, 'success')
          setNotifications(prev => [{ id: `ws_${Date.now()}`, user_id: currentUser.id, type: 'chat_message', title: `${senderName} sent a message`, body: msg.message.content, created_at: new Date().toISOString(), read: false, related_id: msg.connection_id }, ...prev])
        }
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
        const unreadMap: Record<string, number> = Object.fromEntries(prev.map(c => [c.id, c.unreadMessages]))
        return conns.map(c => {
          const mapped = apiConnectionToConnection(c, userId)
          mapped.unreadMessages = unreadMap[mapped.id] ?? 0
          return mapped
        })
      })
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
    const now = new Date()
    const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
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

  // ── Listings the current user has already acted on ──────────────────────────
  // onConnect always creates a fresh ride_request/driver_trip on our side, so
  // the only way to recognize "I already requested/offered on this listing" is
  // by the OTHER party's id it points at: a rider's connection records the
  // driver's trip id, a driver's connection records the rider's request id —
  // which is exactly listing.apiId for that listing either way. Only pending/
  // accepted count: once declined/cancelled/expired, the listing is fair game
  // again instead of being permanently stuck.
  const connectedListingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of connections) {
      if (c.status !== 'pending' && c.status !== 'accepted') continue
      ids.add(c.myRole === 'rider' ? c.driverTripId : c.rideRequestId)
    }
    return ids
  }, [connections])

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
      setConnections(prev => [newConn, ...prev]); showToast('Connection created!', 'success'); setView('connections')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed to connect', 'error') }
  }, [currentUser, userCoords, showToast])

  const onPost = useCallback((listing: MyListing) => {
    setMyListings(prev => [listing, ...prev]); loadListings(); loadMyListings(); setView('my-listings'); showToast('Listing posted!', 'success')
  }, [loadListings, loadMyListings, showToast])

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

  const onOpenChat = useCallback((conn: Connection) => {
    setOpenChatConnectionId(conn.id)
    onMarkRead(conn.id)
  }, [onMarkRead])

  const onCloseChat = useCallback(() => setOpenChatConnectionId(null), [])

  const onViewRoute = useCallback((conn: Connection) => {
    if (!conn.pickupLat || !conn.pickupLng || !conn.destLat || !conn.destLng) return
    setDrivingTo(null)
    setTripRoute({
      pickupLat: conn.pickupLat, pickupLng: conn.pickupLng, pickupLabel: conn.pickupLabel ?? 'Pickup',
      destLat: conn.destLat, destLng: conn.destLng, destLabel: conn.destLabel ?? 'Destination',
      partnerName: conn.withUser.name, date: conn.date,
    })
    setView('map')
  }, [])

  const onStartDriving = useCallback((conn: Connection) => {
    if (!conn.riderPickupLat || !conn.riderPickupLng) return
    setTripRoute(null)
    setDrivingTo({
      connectionId: conn.id, pickupLat: conn.riderPickupLat, pickupLng: conn.riderPickupLng,
      pickupLabel: conn.riderPickupLabel ?? 'Pickup', partnerName: conn.withUser.name,
    })
    setView('map')
  }, [])

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
    if (n.related_id && (n.type === 'chat_message' || n.type === 'connection_received' || n.type === 'connection_accepted' || n.type === 'chat_unlocked')) {
      setConnDeepLink(null)
      setOpenChatConnectionId(n.related_id)
      setView('connections')
    } else if (n.related_id && n.type === 'gas_split_confirmed') {
      setOpenChatConnectionId(null)
      setConnDeepLink({ connectionId: n.related_id, section: 'gassplit' })
      setView('connections')
    } else if (n.type === 'pool_joined') {
      setOpenChatConnectionId(null)
      setConnDeepLink(null)
      setView('pools')
    } else {
      setOpenChatConnectionId(null)
      setConnDeepLink(null)
      setView('connections')
    }
  }, [])

  const unreadCount = notifications.filter(n => !n.read).length
  const unreadMessages = connections.reduce((sum, c) => sum + c.unreadMessages, 0)

  const onSignOut = useCallback(() => {
    authClient.signOut().catch(() => {})
    api.logout(); setCurrentUser(null); setConnections([]); setMyListings([]); setNotifications([]); setTripRoute(null); setDrivingTo(null); setOpenChatConnectionId(null)
    navigate('/auth/sign-in', { replace: true })
  }, [navigate])

  // Switching into Driver mode without a vehicle on file routes into the
  // existing vehicle setup form (on the Profile view) instead of silently
  // switching modes with nothing for the user to actually do as a driver yet.
  const handleSetMode = useCallback((m: ListingType) => {
    setMode(m)
    if (m === 'driver' && !currentUser?.vehicle) setView('profile')
  }, [currentUser?.vehicle])

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

      {(() => {
        const openChatConnection = connections.find(c => c.id === openChatConnectionId)
        return openChatConnection ? (
          <FullScreenChatView connection={openChatConnection} currentUserId={currentUser.id} onClose={onCloseChat} showToast={showToast} incomingMessage={incomingChatMessage} />
        ) : null
      })()}

      {/* The immersive full-bleed Map view supplies its own floating header on
          mobile, so the app's own top bar would just double up with it there. */}
      <div className={guardedView === 'map' ? 'hidden xl:block' : ''}>
        <TopBar setView={setView} currentUser={currentUser} unreadCount={unreadCount} onSignOut={onSignOut} initials={initials} darkMode={darkMode} onToggleDark={() => setTheme(darkMode ? 'light' : 'dark')} mode={mode} onSetMode={handleSetMode} />
      </div>

      <div className="flex-1 max-w-[1240px] mx-auto w-full px-4 py-6 lg:px-8 pb-24 xl:pb-6">
        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="hidden xl:block">
            <Sidebar view={guardedView} setView={setView} onSignOut={onSignOut} />
          </div>
          <main className="min-w-0">
            {guardedView === 'feed' && (
              mode === 'driver' ? (
                <DriverHomeView
                  myOpenTrip={myListings.find(l => l.type === 'driver' && l.status === 'open')}
                  listings={allListings} currentUserId={currentUser.id} currentUserInterests={currentUser.profile.interests}
                  onConnect={onConnect} showToast={showToast} setView={setView} connectedListingIds={connectedListingIds}
                  searchQuery={searchQuery} setSearchQuery={setSearchQuery}
                  filterType={filterType} setFilterType={setFilterType}
                  filterTag={filterTag} setFilterTag={setFilterTag}
                  filterCarType={filterCarType} setFilterCarType={setFilterCarType}
                  filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage}
                  quickDateFilter={quickDateFilter} setQuickDateFilter={setQuickDateFilter}
                  seatsNeeded={seatsNeeded} setSeatsNeeded={setSeatsNeeded}
                  filterSheetOpen={filterSheetOpen} setFilterSheetOpen={setFilterSheetOpen}
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
                      onConnect={onConnect} showToast={showToast} onMatchedIds={setMatchedListingIds} connectedListingIds={connectedListingIds}
                    />
                  )}
                  <FeedView searchQuery={searchQuery} setSearchQuery={setSearchQuery} filterType={filterType} setFilterType={setFilterType} filterTag={filterTag} setFilterTag={setFilterTag} filterCarType={filterCarType} setFilterCarType={setFilterCarType} filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage} quickDateFilter={quickDateFilter} setQuickDateFilter={setQuickDateFilter} seatsNeeded={seatsNeeded} setSeatsNeeded={setSeatsNeeded} filterSheetOpen={filterSheetOpen} setFilterSheetOpen={setFilterSheetOpen} listings={filteredListings.filter(l => !matchedListingIds.includes(l.id))} onConnect={onConnect} loading={feedLoading} currentUserId={currentUser.id} setView={setView} connectedListingIds={connectedListingIds} />
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
            {guardedView === 'post' && <PostView onPost={onPost} userCoords={userCoords} defaultType={mode} vehicle={currentUser.vehicle} />}
            {guardedView === 'my-listings' && <MyListingsView myListings={myListings} onCancel={onCancelListing} userCoords={userCoords} currentUserId={currentUser.id} showToast={showToast} />}
            {guardedView === 'connections' && <ConnectionsView connections={connections} currentUserId={currentUser.id} onAccept={onAccept} onDecline={onDecline} onCancel={onCancel} onComplete={onComplete} showToast={showToast} onViewRoute={onViewRoute} onStartDriving={onStartDriving} onOpenChat={onOpenChat} deepLink={connDeepLink} />}
            {guardedView === 'notifications' && <NotificationsView notifications={notifications} onMarkAllRead={onMarkAllReadNotifs} onDismiss={onDismissNotif} onNavigate={onNotifNavigate} />}
            {guardedView === 'profile' && <ProfileView currentUser={currentUser} onProfileUpdate={setCurrentUser} mode={mode} onSetMode={handleSetMode} />}
          </main>
        </div>
      </div>

      <BottomNav view={guardedView} setView={setView} unreadMessages={unreadMessages} />
    </div>
  )
}
