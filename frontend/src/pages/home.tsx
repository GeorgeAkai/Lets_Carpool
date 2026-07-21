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
import * as api from '../api'
import type { ApiUser, WsMessage } from '../api'
import { MapView } from '../MapView'
import type { TripRoute } from '../MapView'
import { PoolView } from '../PoolView'
import { authClient } from '../lib/auth'

// ─── Types ───────────────────────────────────────────────────────────────────

type View = 'home' | 'feed' | 'post' | 'my-listings' | 'connections' | 'notifications' | 'profile' | 'map' | 'pools'
type ListingType = 'driver' | 'rider'
type RideTag = 'airport' | 'student' | 'church' | 'college' | 'work' | 'event'
type LuggageSize = 'none' | 'small' | 'medium' | 'large' | 'oversized'
type CarType = 'sedan' | 'suv' | 'van' | 'minivan' | 'truck' | 'other'
type Flexibility = 'morning' | 'afternoon' | 'evening' | 'flexible'
type ConnStatus = 'pending' | 'accepted' | 'declined' | 'completed' | 'cancelled' | 'expired'

interface Listing {
  id: string; type: ListingType; apiId: string; ownerId: string
  user: { name: string; initials: string; verified: boolean }
  from: string; to: string; date: string; flexibility: Flexibility
  seats?: number; seatsUsed?: number; passengers?: number; estimatedGas?: number
  tags: RideTag[]; vehicle?: string; carType?: CarType; luggageSize?: LuggageSize
  luggageCapacity?: LuggageSize; status: 'open' | 'matched'; postedAt: string
}

interface MyListing {
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

const FLEX_LABEL: Record<Flexibility, string> = {
  morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', flexible: 'Flexible',
}

const CANNED_MESSAGES: Record<string, string> = {
  timing: 'Can we coordinate the exact timing?',
  pickup: 'Can we confirm the pickup area?',
  luggage: 'I have a luggage question.',
}

const LUGGAGE_LABELS: Record<LuggageSize, string> = {
  none: 'No luggage', small: 'Small bag', medium: 'Medium bag', large: 'Large bag', oversized: 'Oversized',
}

const CAR_TYPE_LABELS: Record<CarType, string> = {
  sedan: 'Sedan', suv: 'SUV', van: 'Van', minivan: 'Minivan', truck: 'Truck', other: 'Other',
}

const CAR_TYPE_EMOJI: Record<CarType, string> = {
  sedan: '🚗', suv: '🚙', van: '🚐', minivan: '🚐', truck: '🚚', other: '🚗',
}

const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }
const MONO: CSSProperties = { fontFamily: "'DM Mono', monospace" }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toInitials(name: string): string {
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
  return {
    id: trip.id, type: 'driver', apiId: trip.id, ownerId: trip.driver_id,
    user: { name: 'Driver', initials: 'DR', verified: false },
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
  return {
    id: req.id, type: 'rider', apiId: req.id, ownerId: req.rider_id,
    user: { name: 'Rider', initials: 'RD', verified: false },
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
  }
}

// ─── Small utility components ─────────────────────────────────────────────────

function Avatar({ initials, size = 'md', photoUrl }: { initials: string; size?: 'sm' | 'md' | 'lg'; photoUrl?: string | null }) {
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
          <Avatar initials={listing.user.initials} />
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

// ─── Feed view ────────────────────────────────────────────────────────────────

function FeedView({
  searchQuery, setSearchQuery, filterType, setFilterType, filterTag, setFilterTag,
  filterCarType, setFilterCarType, filterLuggage, setFilterLuggage,
  listings, onConnect, loading, currentUserId,
}: {
  searchQuery: string; setSearchQuery: (v: string) => void
  filterType: 'all' | 'driver' | 'rider'; setFilterType: (v: 'all' | 'driver' | 'rider') => void
  filterTag: '' | RideTag; setFilterTag: (v: '' | RideTag) => void
  filterCarType: '' | CarType; setFilterCarType: (v: '' | CarType) => void
  filterLuggage: '' | LuggageSize; setFilterLuggage: (v: '' | LuggageSize) => void
  listings: Listing[]; onConnect: (l: Listing) => void; loading: boolean; currentUserId: string
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)

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

function PostView({ onPost, userCoords }: { onPost: (listing: MyListing) => void; userCoords: { lat: number; lng: number } | null }) {
  const [type, setType] = useState<ListingType>('driver')
  const [from, setFrom] = useState<LocationValue | null>(null)
  const [to, setTo] = useState<LocationValue | null>(null)
  const [date, setDate] = useState('')
  const [flexibility, setFlexibility] = useState<Flexibility>('morning')
  const [seats, setSeats] = useState('3')
  const [passengers, setPassengers] = useState('1')
  const [gasEstimate, setGasEstimate] = useState('')
  const [tags, setTags] = useState<Set<RideTag>>(new Set())
  const [vehicle, setVehicle] = useState('')
  const [carType, setCarType] = useState<CarType | ''>('')
  const [luggageSize, setLuggageSize] = useState<LuggageSize>('none')
  const [luggageCapacity, setLuggageCapacity] = useState<LuggageSize>('medium')
  const [declared, setDeclared] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

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
          <button key={t} type="button" onClick={() => setType(t)} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${type === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
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
            <label className="text-sm font-medium">Vehicle</label>
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

function MyListingsView({ myListings, onCancel }: { myListings: MyListing[]; onCancel: (listing: MyListing) => Promise<void> }) {
  const [tab, setTab] = useState<'driver' | 'rider'>('driver')
  const [cancelling, setCancelling] = useState<string | null>(null)
  const shown = myListings.filter(l => l.type === tab)
  const handleCancel = async (listing: MyListing) => {
    setCancelling(listing.id); try { await onCancel(listing) } finally { setCancelling(null) }
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">My Rides</h1>
        <p className="text-muted-foreground mt-1">Your posted driver trips and ride requests.</p>
      </div>
      <div className="flex rounded-xl bg-muted p-1 gap-1">
        {(['driver', 'rider'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'driver' ? 'Driver Trips' : 'Ride Requests'}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
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
  connection, currentUserId, onAccept, onDecline, onCancel, onComplete, showToast, onViewRoute, onMarkRead,
}: {
  connection: Connection; currentUserId: string
  onAccept: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>; onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
  onViewRoute: (conn: Connection) => void
  onMarkRead: (id: string) => void
}) {
  const [expanded, setExpanded] = useState<'chat' | 'gassplit' | 'blockreport' | null>(null)
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
  const msgEndRef = useRef<HTMLDivElement>(null)

  const toggleSection = async (section: 'chat' | 'gassplit' | 'blockreport') => {
    const next = expanded === section ? null : section
    setExpanded(next)
    if (next === 'chat') {
      onMarkRead(connection.id)
      if (!msgsLoaded) {
        try { const fetched = await api.getMessages(connection.id); setMsgs(fetched); setMsgsLoaded(true) } catch { /* ignore */ }
      }
      setTimeout(() => msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
    if (next === 'gassplit' && !gasSuggestion) {
      try { const s = await api.suggestGasSplit(connection.id); setGasSuggestion(s); setSplitAmount(String((s.amount_cents / 100).toFixed(2))) } catch { /* ignore */ }
    }
  }

  // Append incoming WS messages from parent-updated connection (via unreadMessages bump)
  const prevUnread = useRef(connection.unreadMessages)
  useEffect(() => {
    if (connection.unreadMessages > prevUnread.current && expanded !== 'chat') {
      // message arrived while chat closed — will show count on badge
    }
    prevUnread.current = connection.unreadMessages
  }, [connection.unreadMessages, expanded])

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

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="bg-card rounded-3xl border border-border overflow-hidden">
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
          <span className="inline-flex items-center gap-1"><MessageCircle className="size-3.5" />{msgs.length || (msgsLoaded ? 0 : '…')} message{msgs.length !== 1 ? 's' : ''}</span>
          {splitDone && <span className="inline-flex items-center gap-1 text-green-700"><Check className="size-3.5" />Split confirmed</span>}
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-6 pb-4 flex flex-wrap gap-2">
        {status === 'pending' && (
          <>
            <button onClick={handleAccept} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"><Check className="size-4" />Accept</button>
            <button onClick={handleDecline} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60 transition-colors"><X className="size-4" />Decline</button>
            <button onClick={() => toggleSection('chat')} className={`relative inline-flex items-center gap-1.5 rounded-2xl px-4 py-2 text-sm font-medium transition-colors ${expanded === 'chat' ? 'bg-primary/10 text-primary' : 'border border-border text-foreground hover:bg-muted'}`}>
              <MessageCircle className="size-4" />Message
              {connection.unreadMessages > 0 && <span className="ml-1 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{connection.unreadMessages}</span>}
            </button>
            <button onClick={handleCancel} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-60 transition-colors">Cancel</button>
          </>
        )}
        {status === 'accepted' && (
          <>
            <button onClick={() => toggleSection('chat')} className={`relative inline-flex items-center gap-1.5 rounded-2xl px-4 py-2 text-sm font-medium transition-colors ${expanded === 'chat' ? 'bg-primary/10 text-primary' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}>
              <MessageCircle className="size-4" />Chat
              {connection.unreadMessages > 0 && <span className="ml-1 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">{connection.unreadMessages}</span>}
            </button>
            {hasRouteCoords && (
              <button onClick={() => onViewRoute(connection)} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                <Map className="size-4" />Route
              </button>
            )}
            <button onClick={() => toggleSection('gassplit')} className={`inline-flex items-center gap-1.5 rounded-2xl px-4 py-2 text-sm font-medium transition-colors ${expanded === 'gassplit' ? 'bg-accent/20 text-amber-800' : 'border border-border text-foreground hover:bg-muted'}`}><Fuel className="size-4" />Gas Split</button>
            <button onClick={handleComplete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60 transition-colors"><Check className="size-4" />Complete</button>
            <button onClick={handleCancel} disabled={busy} className="inline-flex items-center gap-1.5 rounded-2xl border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-60 transition-colors">Cancel</button>
          </>
        )}
      </div>

      {/* Chat panel */}
      {expanded === 'chat' && (
        <div className="border-t border-border bg-muted/30">
          <div className="px-6 py-4 space-y-3">
            <div className="flex items-center gap-2">
              <Avatar initials={connection.withUser.initials} photoUrl={connection.withUser.photoUrl} size="sm" />
              <span className="text-xs font-semibold text-foreground">{connection.withUser.name}</span>
              <span className="text-xs text-muted-foreground">· {status === 'pending' ? 'pending connection' : 'accepted'}</span>
            </div>

            {msgs.length > 0 && (
              <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
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
                <div ref={msgEndRef} />
              </div>
            )}

            {msgs.length === 0 && msgsLoaded && (
              <p className="text-xs text-muted-foreground text-center py-4">No messages yet. Say hi!</p>
            )}

            {status === 'pending' ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Quick messages while connection is pending:</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(CANNED_MESSAGES).map(([key, text]) => (
                    <button key={key} onClick={() => sendCanned(key)} disabled={sending} className="px-3 py-1.5 rounded-xl bg-card border border-border text-sm text-foreground hover:bg-muted disabled:opacity-50 transition-colors text-left">{text}</button>
                  ))}
                </div>
              </div>
            ) : status === 'accepted' ? (
              <div className="flex gap-2">
                <input type="text" value={msgText} onChange={e => setMsgText(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendFree()} placeholder={`Message ${connection.withUser.name}…`} className="flex-1 px-3.5 py-2.5 rounded-2xl bg-card border border-border text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors" />
                <button onClick={sendFree} disabled={sending || !msgText.trim()} className="px-3.5 py-2.5 rounded-2xl bg-primary text-primary-foreground disabled:opacity-50 transition-colors"><Send className="size-4" /></button>
              </div>
            ) : <p className="text-sm text-muted-foreground">Chat unavailable in this state.</p>}
          </div>
        </div>
      )}

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

// ─── Connections view ─────────────────────────────────────────────────────────

function ConnectionsView({ connections, currentUserId, onAccept, onDecline, onCancel, onComplete, showToast, onViewRoute, onMarkRead }: {
  connections: Connection[]; currentUserId: string
  onAccept: (id: string) => Promise<void>; onDecline: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>; onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
  onViewRoute: (conn: Connection) => void
  onMarkRead: (id: string) => void
}) {
  const totalUnread = connections.reduce((sum, c) => sum + c.unreadMessages, 0)
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
              showToast={showToast} onViewRoute={onViewRoute} onMarkRead={onMarkRead} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Notifications view ───────────────────────────────────────────────────────

function NotificationsView({ notifications, onRead }: { notifications: api.ApiNotification[]; onRead: () => void }) {
  useEffect(() => { onRead() }, [onRead])
  const iconForType = (type: string) => {
    if (type.includes('connection_received')) return <UserPlus className="size-4 text-primary" />
    if (type.includes('accepted') || type.includes('chat_unlocked')) return <Check className="size-4 text-green-600" />
    if (type.includes('chat')) return <MessageCircle className="size-4 text-primary" />
    if (type.includes('gas_split')) return <Fuel className="size-4 text-amber-600" />
    if (type.includes('declined') || type.includes('cancelled')) return <X className="size-4 text-red-500" />
    return <Bell className="size-4 text-muted-foreground" />
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Notifications</h1>
        <p className="text-muted-foreground mt-1">Stay up to date on your connections and activity.</p>
      </div>
      {notifications.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Bell className="size-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No notifications</p>
          <p className="text-sm mt-1">You're all caught up.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...notifications].reverse().map(n => (
            <motion.div key={n.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className={`flex items-start gap-4 p-4 rounded-2xl border border-border ${n.read ? 'bg-card' : 'bg-primary/5'}`}>
              <div className="mt-0.5 shrink-0">{iconForType(n.type)}</div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{n.title}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{n.body}</p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{relativeTime(n.created_at)}</span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Profile view ─────────────────────────────────────────────────────────────

function ProfileView({ currentUser, onProfileUpdate }: { currentUser: ApiUser; onProfileUpdate: (user: ApiUser) => void }) {
  const profile = currentUser.profile
  const vehicle = currentUser.vehicle
  const [displayName, setDisplayName] = useState(profile.display_name)
  const [bio, setBio] = useState(profile.bio ?? '')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ text: string; ok: boolean } | null>(null)
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
      const updated = await api.updateProfile(displayName, null, bio || null)
      onProfileUpdate({ ...currentUser, profile: { ...profile, display_name: updated.display_name, bio: updated.bio } })
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

      <div className="rounded-3xl bg-card border border-border p-6 space-y-4">
        <h3 className="text-base font-semibold text-foreground">Edit Profile</h3>
        <div className="space-y-3">
          <div className="space-y-1.5"><label className="text-sm font-medium">Display name</label><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} /></div>
          <div className="space-y-1.5"><label className="text-sm font-medium">Bio</label><textarea value={bio} onChange={e => setBio(e.target.value)} rows={3} placeholder="Tell others a bit about yourself…" className={`${inputCls} resize-none`} /></div>
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

function NeonAuthSync({ onAuthenticated, onUnauthenticated }: {
  onAuthenticated: (email: string, name: string) => Promise<void>
  onUnauthenticated: () => void
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
    lastSyncedId.current = uid
    const email = session.user.email
    const name = (session.user as { name?: string }).name || email.split('@')[0]
    onAuthenticated(email, name).catch(() => { lastSyncedId.current = null })
  }, [session?.user?.id, isPending, onAuthenticated, onUnauthenticated])

  return null
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function TopBar({ setView, currentUser, unreadCount, onSignOut, initials, darkMode, onToggleDark }: {
  setView: (v: View) => void; currentUser: ApiUser | null; unreadCount: number
  onSignOut: () => void; initials: string; darkMode: boolean; onToggleDark: () => void
}) {
  return (
    <header className="sticky top-0 z-40 bg-background/90 backdrop-blur border-b border-border">
      <div className="max-w-[1240px] mx-auto px-4 lg:px-8 h-14 flex items-center justify-between gap-4">
        <button onClick={() => setView('feed')} className="text-sm font-semibold text-foreground hover:text-primary transition-colors xl:text-base">Let's Carpool</button>
        {currentUser ? (
          <div className="flex items-center gap-2">
            <button onClick={onToggleDark} className="p-2 rounded-xl hover:bg-muted text-muted-foreground transition-colors" aria-label="Toggle dark mode">
              {darkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
            <button onClick={() => setView('notifications')} className="relative p-2 rounded-xl hover:bg-muted text-muted-foreground transition-colors" aria-label="Notifications">
              <Bell className="size-5" />
              {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 size-4 flex items-center justify-center rounded-full bg-destructive text-white text-[10px] font-bold">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
            <button onClick={() => setView('profile')} className="size-8 rounded-full bg-secondary text-secondary-foreground text-xs font-semibold flex items-center justify-center hover:ring-2 hover:ring-primary/20 transition-all" aria-label="Account" style={MONO}>{initials}</button>
            <button onClick={onSignOut} className="hidden xl:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" aria-label="Sign out"><LogOut className="size-4" /><span>Sign out</span></button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={onToggleDark} className="p-2 rounded-xl hover:bg-muted text-muted-foreground transition-colors" aria-label="Toggle dark mode">
              {darkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </button>
            <button onClick={() => setView('feed')} className="px-4 py-2 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Sign in</button>
          </div>
        )}
      </div>
    </header>
  )
}

function BottomNav({ view, setView, unreadMessages }: { view: View; setView: (v: View) => void; unreadMessages: number }) {
  const items: Array<{ id: View; label: string; icon: React.ReactNode }> = [
    { id: 'feed', label: 'Feed', icon: <Search className="size-5" /> },
    { id: 'map', label: 'Map', icon: <Map className="size-5" /> },
    { id: 'pools', label: 'Pools', icon: <Users className="size-5" /> },
    { id: 'post', label: 'New', icon: <span className="text-xl font-light leading-none">+</span> },
    { id: 'connections', label: 'Inbox', icon: <MessageCircle className="size-5" /> },
    { id: 'profile', label: 'Me', icon: <Shield className="size-5" /> },
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
          <p className="text-sm text-muted-foreground">Carpooling app</p>
          <h1 className="mt-2 text-2xl font-semibold text-foreground">Let's Carpool</h1>
        </div>
        <div className="rounded-3xl bg-primary px-3 py-2 text-primary-foreground text-xs font-semibold">MVP</div>
      </div>
      <div className="mt-8 space-y-1.5">
        {items.map(item => (
          <button key={item.id} type="button" onClick={() => setView(item.id)} className={`w-full rounded-3xl px-4 py-3 text-left text-sm font-medium transition-all ${view === item.id ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/10' : 'text-muted-foreground hover:bg-muted'}`}>
            {item.label}
          </button>
        ))}
        <button type="button" onClick={onSignOut} className="w-full rounded-3xl px-4 py-3 text-left text-sm font-medium text-muted-foreground hover:bg-muted transition-all flex items-center gap-2"><LogOut className="size-4" />Sign out</button>
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

  // ── Auth ──
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  // ── Dark mode ──
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('carpool_dark') === 'true')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('carpool_dark', String(darkMode))
  }, [darkMode])

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

  // ── Feed ──
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'driver' | 'rider'>('all')
  const [filterTag, setFilterTag] = useState<'' | RideTag>('')
  const [filterCarType, setFilterCarType] = useState<'' | CarType>('')
  const [filterLuggage, setFilterLuggage] = useState<'' | LuggageSize>('')
  const [allListings, setAllListings] = useState<Listing[]>([])
  const [feedLoading, setFeedLoading] = useState(false)

  // ── My Listings ──
  const [myListings, setMyListings] = useState<MyListing[]>([])

  // ── Connections ──
  const [connections, setConnections] = useState<Connection[]>([])
  const connectionsRef = useRef<Connection[]>([])
  useEffect(() => { connectionsRef.current = connections }, [connections])

  // ── Trip route (for Map view) ──
  const [tripRoute, setTripRoute] = useState<TripRoute | null>(null)

  // ── Notifications ──
  const [notifications, setNotifications] = useState<api.ApiNotification[]>([])
  const [notifRead, setNotifRead] = useState(false)

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
        setConnections(prev => prev.map(c => c.id === msg.connection_id ? { ...c, unreadMessages: c.unreadMessages + 1 } : c))
        const conn = connectionsRef.current.find(c => c.id === msg.connection_id)
        const senderName = conn?.withUser.name ?? 'Someone'
        const preview = msg.message.content.length > 45 ? msg.message.content.slice(0, 45) + '…' : msg.message.content
        showToastRef.current(`💬 ${senderName}: ${preview}`, 'success')
        setNotifications(prev => [{ id: `ws_${Date.now()}`, user_id: currentUser.id, type: 'chat_message', title: `${senderName} sent a message`, body: msg.message.content, created_at: new Date().toISOString(), read: false }, ...prev])
        setNotifRead(false)
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
  const handleAuthenticated = useCallback(async (email: string, name: string) => {
    try {
      const existingToken = localStorage.getItem('carpool_token')
      if (existingToken) {
        try { const user = await api.getMe(); setCurrentUser(user); requestLocation(); return }
        catch { localStorage.removeItem('carpool_token') }
      }
      const user = await api.login(name, email)
      setCurrentUser(user); requestLocation()
    } finally { setAuthLoading(false) }
  }, [requestLocation])

  const handleUnauthenticated = useCallback(() => {
    api.logout(); setCurrentUser(null); setAuthLoading(false)
  }, [])

  // ── Redirect when not authenticated ──
  useEffect(() => {
    if (!authLoading && !currentUser) {
      navigate('/auth/sign-in', { replace: true })
    }
  }, [authLoading, currentUser, navigate])

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
  const filteredListings = useMemo(() => allListings.filter(listing => {
    const matchType = filterType === 'all' || listing.type === filterType
    const matchTag = filterTag === '' || listing.tags.includes(filterTag)
    const matchSearch = searchQuery.trim() === '' || listing.to.toLowerCase().includes(searchQuery.toLowerCase()) || listing.from.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCarType = filterCarType === '' || (listing.type === 'driver' && listing.carType === filterCarType)
    const matchLuggage = filterLuggage === '' || listing.type !== 'driver' || (listing.luggageCapacity != null && LUGGAGE_ORDER.indexOf(listing.luggageCapacity) >= LUGGAGE_ORDER.indexOf(filterLuggage))
    return matchType && matchTag && matchSearch && matchCarType && matchLuggage
  }), [allListings, filterTag, filterType, searchQuery, filterCarType, filterLuggage]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const onViewRoute = useCallback((conn: Connection) => {
    if (!conn.pickupLat || !conn.pickupLng || !conn.destLat || !conn.destLng) return
    setTripRoute({
      pickupLat: conn.pickupLat, pickupLng: conn.pickupLng, pickupLabel: conn.pickupLabel ?? 'Pickup',
      destLat: conn.destLat, destLng: conn.destLng, destLabel: conn.destLabel ?? 'Destination',
      partnerName: conn.withUser.name, date: conn.date,
    })
    setView('map')
  }, [])

  const onNotifRead = useCallback(() => {
    setNotifRead(true); setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }, [])

  const unreadCount = notifRead ? 0 : notifications.filter(n => !n.read).length
  const unreadMessages = connections.reduce((sum, c) => sum + c.unreadMessages, 0)

  const onSignOut = useCallback(() => {
    authClient.signOut().catch(() => {})
    api.logout(); setCurrentUser(null); setConnections([]); setMyListings([]); setNotifications([]); setTripRoute(null)
    navigate('/auth/sign-in', { replace: true })
  }, [navigate])

  const AUTH_VIEWS: View[] = ['feed', 'post', 'my-listings', 'connections', 'notifications', 'profile', 'map', 'pools']
  const guardedView: View = !currentUser && AUTH_VIEWS.includes(view) ? 'feed' : view
  const displayName = currentUser?.profile?.display_name ?? 'You'
  const initials = toInitials(displayName)

  // Show loading while session is resolving
  if (authLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        <NeonAuthSync onAuthenticated={handleAuthenticated} onUnauthenticated={handleUnauthenticated} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      </div>
    )
  }

  // Not authenticated — redirect effect fires above, render nothing while redirecting
  if (!currentUser) {
    return <NeonAuthSync onAuthenticated={handleAuthenticated} onUnauthenticated={handleUnauthenticated} />
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <NeonAuthSync onAuthenticated={handleAuthenticated} onUnauthenticated={handleUnauthenticated} />
      <Toast toast={toast} />

      <TopBar setView={setView} currentUser={currentUser} unreadCount={unreadCount} onSignOut={onSignOut} initials={initials} darkMode={darkMode} onToggleDark={() => setDarkMode(d => !d)} />

      <div className="flex-1 max-w-[1240px] mx-auto w-full px-4 py-6 lg:px-8 pb-24 xl:pb-6">
        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="hidden xl:block">
            <Sidebar view={guardedView} setView={setView} onSignOut={onSignOut} />
          </div>
          <main className="min-w-0">
            {guardedView === 'feed' && (
              <FeedView searchQuery={searchQuery} setSearchQuery={setSearchQuery} filterType={filterType} setFilterType={setFilterType} filterTag={filterTag} setFilterTag={setFilterTag} filterCarType={filterCarType} setFilterCarType={setFilterCarType} filterLuggage={filterLuggage} setFilterLuggage={setFilterLuggage} listings={filteredListings} onConnect={onConnect} loading={feedLoading} currentUserId={currentUser.id} />
            )}
            {guardedView === 'map' && <MapView userCoords={userCoords} currentUserId={currentUser.id} tripRoute={tripRoute} onClearRoute={() => setTripRoute(null)} />}
            {guardedView === 'pools' && <PoolView userCoords={userCoords} currentUserId={currentUser.id} showToast={showToast} />}
            {guardedView === 'post' && <PostView onPost={onPost} userCoords={userCoords} />}
            {guardedView === 'my-listings' && <MyListingsView myListings={myListings} onCancel={onCancelListing} />}
            {guardedView === 'connections' && <ConnectionsView connections={connections} currentUserId={currentUser.id} onAccept={onAccept} onDecline={onDecline} onCancel={onCancel} onComplete={onComplete} showToast={showToast} onViewRoute={onViewRoute} onMarkRead={onMarkRead} />}
            {guardedView === 'notifications' && <NotificationsView notifications={notifications} onRead={onNotifRead} />}
            {guardedView === 'profile' && <ProfileView currentUser={currentUser} onProfileUpdate={setCurrentUser} />}
          </main>
        </div>
      </div>

      <BottomNav view={guardedView} setView={setView} unreadMessages={unreadMessages} />
    </div>
  )
}
