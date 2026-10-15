import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpDown, Check, ChevronLeft, ChevronRight, Clock, Footprints, MessageCircle, Minus,
  Phone, Plus, Share2, ShieldCheck, Star, Users, X, Bell, Navigation, Map as MapIcon,
} from 'lucide-react'
import * as api from '../api'
import type { ApiDriverTrip, ApiUser, SavedRoute, TripDayStatus } from '../api'
import { formatPlace } from '../lib/places'
import {
  Avatar, LocationInput, reverseGeocode, toInitials, todayLocalISO, tripToMyListing, FLEX_LABEL,
  type Connection, type Flexibility, type LocationValue, type MyListing,
} from './home'
import { BottomSheet } from './discover-mobile'

// ─── Shared search state (Home → Results → Ride details) ──────────────────────

export interface RideSearch {
  // null = the rider's current location
  from: LocationValue | null
  to: LocationValue | null
  date: string   // YYYY-MM-DD
  time: string   // HH:MM, '' = leave now / any time
  seats: number
}

export function defaultRideSearch(): RideSearch {
  return { from: null, to: null, date: todayLocalISO(), time: '', seats: 1 }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function fmtTime(hhmm: string | null | undefined): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h)) return ''
  const suffix = h >= 12 ? 'pm' : 'am'
  return `${((h + 11) % 12) + 1}:${String(m ?? 0).padStart(2, '0')} ${suffix}`
}

function fmtTimeShort(hhmm: string | null | undefined): string {
  return fmtTime(hhmm).replace(/ (am|pm)$/, '')
}

export function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function dayLabel(iso: string): string {
  const today = todayLocalISO()
  if (iso === today) return 'Today'
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  const t = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  if (iso === t) return 'Tomorrow'
  return parseISODate(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function weekdaysLabel(days: number[]): string {
  const set = [...new Set(days)].sort()
  if (set.length === 7) return 'Every day'
  if (set.join() === '0,1,2,3,4') return 'Weekdays'
  if (set.join() === '5,6') return 'Weekends'
  return set.map(d => WEEKDAY_SHORT[d]).join(', ')
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function kmToMi(km: number): number {
  return Math.round(km * 0.621371)
}

// Time of a trip: an exact departure if the driver set one, else its window.
function tripTimes(trip: ApiDriverTrip): { depart: string; arrive: string | null } {
  if (trip.departure_time) {
    return { depart: fmtTimeShort(trip.departure_time), arrive: fmtTimeShort(trip.estimated_arrival_time) || null }
  }
  return { depart: FLEX_LABEL[(trip.flexibility as Flexibility)] ?? 'Flexible', arrive: null }
}

function driverLine(trip: ApiDriverTrip): string {
  const s = trip.driver_stats
  const parts: string[] = []
  if (s?.rating_avg != null) parts.push(`★ ${s.rating_avg.toFixed(1)}`)
  else parts.push('New driver')
  if (s && s.completed_trips > 0) parts.push(`${s.completed_trips} trip${s.completed_trips === 1 ? '' : 's'}`)
  const car = trip.vehicle ? [trip.vehicle.color, trip.vehicle.model ?? trip.vehicle.make].filter(Boolean).join(' ') : ''
  if (car) parts.push(car)
  return parts.join(' · ')
}

// ─── Small primitives ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="text-[13px] font-semibold text-muted-foreground tracking-[0.05em] uppercase">{children}</h2>
}

function IconButton({ label, onClick, children, className = '' }: { label: string; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label}
      className={`size-11 shrink-0 rounded-xl bg-card border border-border text-foreground flex items-center justify-center hover:bg-muted transition-colors ${className}`}>
      {children}
    </button>
  )
}

function PrimaryButton({ children, onClick, disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className="w-full h-14 rounded-2xl bg-primary text-primary-foreground text-[17px] font-bold hover:brightness-105 active:scale-[0.99] disabled:opacity-50 transition-all">
      {children}
    </button>
  )
}

// A full-width action bar pinned to the bottom of the screen on phones (above
// the bottom nav when it's showing), and inline at the end of the column on desktop.
function StickyFooter({ children, aboveNav = false }: { children: ReactNode; aboveNav?: boolean }) {
  return (
    <div className={`fixed inset-x-0 z-30 bg-sidebar/95 backdrop-blur border-t border-border px-5 pt-3 ${aboveNav ? 'bottom-[var(--bottom-nav-h)] pb-3' : 'bottom-0 pb-[max(1.5rem,env(safe-area-inset-bottom))]'} xl:static xl:bg-transparent xl:border-0 xl:px-0 xl:pt-2 xl:pb-0 xl:backdrop-blur-none`}>
      <div className="max-w-md mx-auto space-y-2">{children}</div>
    </div>
  )
}

function VerifiedIcon({ size = 16 }: { size?: number }) {
  return <ShieldCheck aria-label="ID verified" role="img" className="text-info shrink-0" style={{ width: size, height: size }} />
}

// ─── 1 · Home ─────────────────────────────────────────────────────────────────

export function HomeScreen({
  mode, currentUser, hasLocation, search, setSearch, savedRoutes, onSaveRoute, onDeleteRoute,
  nextTrip, onPrimary, onOpenTrip, onOpenProfile, onOpenMap, onOpenNotifications, unreadNotifications = 0, children,
}: {
  onOpenMap?: () => void
  onOpenNotifications?: () => void
  unreadNotifications?: number
  mode: 'rider' | 'driver'
  currentUser: ApiUser
  hasLocation: boolean
  search: RideSearch
  setSearch: (s: RideSearch) => void
  savedRoutes: SavedRoute[]
  onSaveRoute: (label: string) => Promise<void>
  onDeleteRoute: (id: string) => Promise<void>
  nextTrip: Connection | null
  onPrimary: () => void
  onOpenTrip: (c: Connection) => void
  onOpenProfile: () => void
  children?: ReactNode
}) {
  const [sheet, setSheet] = useState<'when' | 'seats' | 'save' | null>(null)
  const [routeLabel, setRouteLabel] = useState('')
  const [editingRoutes, setEditingRoutes] = useState(false)
  const firstName = currentUser.profile.display_name.split(' ')[0]
  const isDriver = mode === 'driver'
  const fromLabel = search.from?.label ?? (hasLocation ? 'Current location' : 'Current location (off)')

  const swap = () => {
    // Swapping onto "current location" needs real coordinates on the other side.
    if (!search.to) return
    setSearch({ ...search, from: search.to, to: search.from })
  }

  const whenLabel = `${dayLabel(search.date)} · ${search.time ? fmtTime(search.time) : isDriver ? 'Set a time' : 'Leave now'}`
  const seatsLabel = isDriver ? `${search.seats} seat${search.seats === 1 ? '' : 's'} free` : `${search.seats} seat${search.seats === 1 ? '' : 's'}`

  return (
    <div className="max-w-md mx-auto flex flex-col gap-[22px] pb-6">
      <div className="flex flex-col gap-0.5">
      <div className="flex justify-between items-center gap-3">
        <p className="text-sm text-muted-foreground truncate">{greeting()}, {firstName}</p>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenMap && <IconButton label="Live map" onClick={onOpenMap} className="rounded-full"><MapIcon className="size-[18px]" /></IconButton>}
          {onOpenNotifications && (
            <IconButton label={unreadNotifications ? `Notifications, ${unreadNotifications} unread` : 'Notifications'} onClick={onOpenNotifications} className="rounded-full relative">
              <Bell className="size-5" />
              {unreadNotifications > 0 && <span aria-hidden className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-destructive ring-2 ring-card" />}
            </IconButton>
          )}
          <button type="button" onClick={onOpenProfile} aria-label="Profile"
            className="size-11 shrink-0 rounded-full border border-border bg-card text-foreground font-bold text-[15px] flex items-center justify-center overflow-hidden">
            {currentUser.profile.photo_url
              ? <img src={currentUser.profile.photo_url} alt="" className="size-full object-cover" />
              : toInitials(currentUser.profile.display_name).slice(0, 1)}
          </button>
        </div>
      </div>
      <h1 className="font-display text-[30px] leading-tight font-bold tracking-[-0.02em] text-foreground">
        {isDriver ? 'Where are you driving?' : 'Where are you headed?'}
      </h1>
      </div>

      <section aria-label="Plan a trip" className="bg-card border border-border rounded-[20px] p-1.5 flex flex-col">
        <div className="flex items-center gap-3 px-3 py-3.5">
          <span aria-hidden className="size-3 rounded-full border-[3px] border-info shrink-0" />
          {search.from ? (
            <LocationInput variant="bare" label="From" value={search.from} placeholder="Starting point"
              onChange={v => setSearch({ ...search, from: v })} />
          ) : (
            <div className="flex-1 min-w-0">
              <span className="block text-xs text-muted-foreground">From</span>
              <button type="button" onClick={() => setSearch({ ...search, from: { label: '', lat: NaN, lng: NaN } })}
                className="block w-full text-left text-[17px] text-foreground truncate">{fromLabel}</button>
            </div>
          )}
          <IconButton label="Swap start and destination" onClick={swap} className="bg-muted">
            <ArrowUpDown className="size-[18px]" />
          </IconButton>
        </div>
        <div aria-hidden className="h-px bg-border ml-9 mr-3" />
        <div className="flex items-center gap-3 px-3 py-3.5">
          <span aria-hidden className="size-3 rounded-[3px] bg-primary shrink-0" />
          <LocationInput variant="bare" label="To" value={search.to} placeholder="Search a destination"
            onChange={v => setSearch({ ...search, to: v })} />
        </div>
        <div className="flex gap-2 px-1.5 pt-1.5 pb-2">
          <button type="button" onClick={() => setSheet('when')}
            className="flex-1 min-w-0 h-11 rounded-xl border border-border bg-muted text-foreground text-sm font-semibold flex items-center justify-center gap-2">
            <Clock className="size-4 shrink-0" /><span className="truncate">{whenLabel}</span>
          </button>
          <button type="button" onClick={() => setSheet('seats')}
            className="h-11 px-3.5 rounded-xl border border-border bg-muted text-foreground text-sm font-semibold flex items-center gap-2">
            <Users className="size-4" />{seatsLabel}
          </button>
        </div>
        <div className="px-1.5 pb-1.5">
          <PrimaryButton onClick={onPrimary} disabled={isDriver && !search.to}>
            {isDriver ? 'Post this ride' : 'Find rides'}
          </PrimaryButton>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <SectionLabel>Your routes</SectionLabel>
          {savedRoutes.length > 0 && (
            <button type="button" onClick={() => setEditingRoutes(v => !v)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
              {editingRoutes ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
        <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {savedRoutes.map(r => (
            <div key={r.id} className="relative shrink-0 min-w-[150px] flex-1">
              <button type="button"
                onClick={() => setSearch({
                  ...search,
                  from: r.pickup.latitude != null ? { label: formatPlace(r.pickup.label), lat: r.pickup.latitude, lng: r.pickup.longitude! } : null,
                  to: r.destination.latitude != null ? { label: formatPlace(r.destination.label), lat: r.destination.latitude, lng: r.destination.longitude! } : null,
                  time: r.departure_time ? r.departure_time.slice(0, 5) : search.time,
                })}
                className="w-full min-h-14 rounded-[14px] border border-border bg-card text-foreground text-left px-3.5 py-2.5 flex flex-col gap-0.5 hover:bg-muted transition-colors">
                <span className="text-[15px] font-semibold truncate">{r.label}</span>
                <span className="text-xs text-muted-foreground truncate">
                  {[r.weekdays.length ? weekdaysLabel(r.weekdays) : null, r.departure_time ? fmtTime(r.departure_time) : null].filter(Boolean).join(' · ') || 'Tap to use'}
                </span>
              </button>
              {editingRoutes && (
                <button type="button" onClick={() => onDeleteRoute(r.id)} aria-label={`Delete ${r.label}`}
                  className="absolute -top-2 -right-2 size-7 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => { setRouteLabel(''); setSheet('save') }} disabled={!search.to}
            aria-label="Save route" title={search.to ? 'Save this route' : 'Pick a destination first'}
            className={`shrink-0 min-h-14 rounded-[14px] border border-dashed border-border text-muted-foreground text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50 ${savedRoutes.length ? 'w-14' : 'px-4'}`}>
            <Plus className="size-4" />{savedRoutes.length ? null : 'Save route'}
          </button>
        </div>
      </section>

      {nextTrip && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Next trip</SectionLabel>
          <button type="button" onClick={() => onOpenTrip(nextTrip)}
            className="text-left text-foreground bg-card border border-border rounded-2xl p-3.5 flex items-center gap-3 hover:bg-muted transition-colors">
            <div className="size-12 rounded-xl bg-muted flex flex-col items-center justify-center shrink-0">
              <span className="text-[11px] text-muted-foreground font-semibold uppercase">{parseISODate(nextTrip.date).toLocaleDateString([], { weekday: 'short' })}</span>
              <span className="text-[17px] font-bold">{parseISODate(nextTrip.date).getDate()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-semibold truncate">
                {nextTrip.raw?.driver_trip.departure_time ? `${fmtTime(nextTrip.raw.driver_trip.departure_time)} ` : ''}
                {nextTrip.myRole === 'driver' ? `picking up ${nextTrip.withUser.name}` : `with ${nextTrip.withUser.name}`}
              </p>
              <p className="text-[13px] text-muted-foreground truncate">
                {nextTrip.status === 'pending' ? 'Request pending · ' : ''}
                Pickup {nextTrip.myRole === 'rider' ? `at ${nextTrip.riderPickupLabel ?? nextTrip.from}` : `near ${nextTrip.riderPickupLabel ?? nextTrip.from}`}
              </p>
            </div>
            <ChevronRight className="size-5 text-muted-foreground shrink-0" />
          </button>
        </section>
      )}

      {children}

      <BottomSheet open={sheet === 'when'} onClose={() => setSheet(null)} title="When">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {[todayLocalISO(), (() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()].map(iso => (
              <button key={iso} type="button" onClick={() => setSearch({ ...search, date: iso })} aria-pressed={search.date === iso}
                className={`h-11 rounded-xl text-sm font-semibold border ${search.date === iso ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted border-border text-foreground'}`}>
                {dayLabel(iso)}
              </button>
            ))}
          </div>
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">Date</span>
            <input type="date" value={search.date} min={todayLocalISO()} onChange={e => e.target.value && setSearch({ ...search, date: e.target.value })}
              className="w-full h-11 px-3 rounded-xl bg-input-background border border-border text-sm text-foreground" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">{isDriver ? 'Departure time' : 'Leave at'}</span>
            <div className="flex gap-2">
              <input type="time" value={search.time} onChange={e => setSearch({ ...search, time: e.target.value })}
                className="flex-1 h-11 px-3 rounded-xl bg-input-background border border-border text-sm text-foreground" />
              {!isDriver && (
                <button type="button" onClick={() => setSearch({ ...search, time: '' })} aria-pressed={!search.time}
                  className={`h-11 px-4 rounded-xl text-sm font-semibold border ${!search.time ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted border-border'}`}>
                  Leave now
                </button>
              )}
            </div>
          </label>
          <PrimaryButton onClick={() => setSheet(null)}>Done</PrimaryButton>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === 'seats'} onClose={() => setSheet(null)} title={isDriver ? 'Seats to offer' : 'Seats needed'}>
        <div className="space-y-5">
          <Stepper value={search.seats} min={1} max={isDriver ? 8 : 4} onChange={n => setSearch({ ...search, seats: n })}
            label={isDriver ? 'Seats to offer' : 'Seats needed'} hint={isDriver ? 'Not counting you' : 'Including you'} />
          <PrimaryButton onClick={() => setSheet(null)}>Done</PrimaryButton>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === 'save'} onClose={() => setSheet(null)} title="Save this route">
        <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (!routeLabel.trim()) return; await onSaveRoute(routeLabel.trim()); setSheet(null) }}>
          <p className="text-sm text-muted-foreground">{search.from?.label ?? 'Current location'} → {search.to?.label}{search.time ? ` · ${fmtTime(search.time)}` : ''}</p>
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">Name</span>
            <input value={routeLabel} onChange={e => setRouteLabel(e.target.value)} maxLength={60} autoFocus placeholder="e.g. Home → Work"
              className="w-full h-11 px-3 rounded-xl bg-input-background border border-border text-sm text-foreground" />
          </label>
          <PrimaryButton type="submit" disabled={!routeLabel.trim()}>Save route</PrimaryButton>
        </form>
      </BottomSheet>
    </div>
  )
}

function Stepper({ value, min, max, onChange, label, hint }: {
  value: number; min: number; max: number; onChange: (n: number) => void; label: string; hint?: string
}) {
  return (
    <div className="bg-card border border-border rounded-[18px] p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-base font-semibold">{label}</p>
        {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex items-center gap-3.5">
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}
          className="size-11 rounded-full border border-border bg-muted text-foreground flex items-center justify-center disabled:opacity-40"><Minus className="size-5" /></button>
        <span className="font-display text-[26px] font-bold w-6 text-center tabular-nums" aria-live="polite">{value}</span>
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}
          className="size-11 rounded-full border border-border bg-muted text-foreground flex items-center justify-center disabled:opacity-40"><Plus className="size-5" /></button>
      </div>
    </div>
  )
}

// ─── 2 · Ride results ─────────────────────────────────────────────────────────

type SortKey = 'best' | 'soonest' | 'price' | 'verified'

export function ResultsScreen({
  search, userCoords, currentUserId, requestedTripIds, onBack, onOpenTrip, onNotify, showToast,
}: {
  search: RideSearch
  userCoords: { lat: number; lng: number } | null
  currentUserId: string
  requestedTripIds: Set<string>
  onBack: () => void
  onOpenTrip: (trip: ApiDriverTrip) => void
  onNotify: () => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [trips, setTrips] = useState<ApiDriverTrip[] | null>(null)
  const [sort, setSort] = useState<SortKey>('best')
  const [anyDate, setAnyDate] = useState(false)
  const [notified, setNotified] = useState(false)

  const origin = search.from && Number.isFinite(search.from.lat) ? search.from : userCoords ? { lat: userCoords.lat, lng: userCoords.lng } : null

  useEffect(() => {
    let cancelled = false
    setTrips(null)
    const q: api.SearchQuery = { target_date: anyDate ? undefined : search.date }
    if (search.to) {
      q.destination_latitude = search.to.lat; q.destination_longitude = search.to.lng
      if (origin) { q.pickup_latitude = origin.lat; q.pickup_longitude = origin.lng }
      else q.destination_radius_meters = 15000
    }
    api.searchDriverTrips(q)
      .then(rows => { if (!cancelled) setTrips(rows.filter(t => t.driver_id !== currentUserId)) })
      .catch(e => { if (!cancelled) { setTrips([]); showToast(e instanceof Error ? e.message : 'Search failed', 'error') } })
    return () => { cancelled = true }
  }, [search.to?.lat, search.to?.lng, origin?.lat, origin?.lng, search.date, anyDate, currentUserId]) // eslint-disable-line react-hooks/exhaustive-deps

  const fits = useMemo(() => (trips ?? []).filter(t => t.seats_available - t.seats_reserved >= search.seats), [trips, search.seats])

  const sorted = useMemo(() => {
    const list = sort === 'verified' ? fits.filter(t => t.driver_stats?.id_verified) : [...fits]
    const price = (t: ApiDriverTrip) => t.pricing?.price_per_seat_cents ?? Number.MAX_SAFE_INTEGER
    const when = (t: ApiDriverTrip) => `${t.target_date} ${t.departure_time ?? ({ morning: '09', afternoon: '14', evening: '19' } as Record<string, string>)[t.flexibility] ?? '12'}`
    // Best match: least detour first, then the target time, then trust.
    const score = (t: ApiDriverTrip) => (t.detour_minutes ?? 30) * 2
      + (search.time && t.departure_time ? Math.abs(minutesOf(t.departure_time) - minutesOf(search.time)) / 10 : 0)
      - (t.driver_stats?.rating_avg ?? 4) - (t.driver_stats?.id_verified ? 2 : 0)
    if (sort === 'soonest') list.sort((a, b) => when(a).localeCompare(when(b)))
    else if (sort === 'price') list.sort((a, b) => price(a) - price(b))
    else list.sort((a, b) => score(a) - score(b))
    return list
  }, [fits, sort, search.time])

  const chips: { id: SortKey; label: string }[] = [
    { id: 'best', label: 'Best match' }, { id: 'soonest', label: 'Leaves soonest' },
    { id: 'price', label: 'Lowest price' }, { id: 'verified', label: 'Verified' },
  ]

  return (
    <div className="max-w-md mx-auto flex flex-col gap-4 pb-8">
      <div className="flex items-center gap-2.5">
        <IconButton label="Back" onClick={onBack}><ChevronLeft className="size-5" /></IconButton>
        <button type="button" onClick={onBack}
          className="flex-1 min-w-0 min-h-11 rounded-xl bg-card border border-border text-left px-3.5 py-1.5 flex flex-col">
          <span className="text-[15px] font-semibold truncate">{search.from?.label || 'Current location'} → {search.to?.label ?? 'Anywhere'}</span>
          <span className="text-xs text-muted-foreground truncate">
            {anyDate ? 'Any date' : dayLabel(search.date)}{search.time ? `, around ${fmtTime(search.time)}` : ''} · {search.seats} seat{search.seats === 1 ? '' : 's'}
          </span>
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="radiogroup" aria-label="Sort rides">
        {chips.map(c => (
          <button key={c.id} type="button" role="radio" aria-checked={sort === c.id} onClick={() => setSort(c.id)}
            className={`shrink-0 h-9 px-3.5 rounded-full text-[13px] whitespace-nowrap transition-colors ${sort === c.id ? 'bg-foreground text-background font-bold' : 'bg-card border border-border text-foreground font-semibold'}`}>
            {c.label}
          </button>
        ))}
      </div>

      {trips === null ? (
        <p className="text-sm text-muted-foreground animate-pulse py-6 text-center">Finding drivers going your way…</p>
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">
            {sorted.length === 0 ? 'No drivers match yet' : `${sorted.length} driver${sorted.length === 1 ? '' : 's'} going your way`}
          </p>
          <ul className="flex flex-col gap-3">
            {sorted.map((t, i) => {
              const best = sort === 'best' && i === 0
              const { depart, arrive } = tripTimes(t)
              const free = t.seats_available - t.seats_reserved
              const name = t.driver_name ?? 'Driver'
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => onOpenTrip(t)}
                    className={`w-full text-left text-foreground bg-card rounded-[18px] p-4 flex flex-col gap-3.5 border hover:brightness-110 transition ${best ? 'border-primary' : 'border-border'}`}>
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex flex-col gap-1 min-w-0">
                        {best && <span className="self-start text-[11px] font-bold tracking-[0.04em] uppercase text-primary-foreground bg-primary px-2 py-[3px] rounded-md">Best match</span>}
                        <p className="font-display text-2xl font-bold tracking-[-0.01em]">
                          {depart}{arrive && <> <span className="text-muted-foreground font-medium">→</span> {arrive}</>}
                        </p>
                        <p className="text-[13px] text-secondary-foreground flex items-center gap-1.5 truncate">
                          <Footprints className="size-3.5 shrink-0" />
                          {t.detour_minutes != null ? `+${Math.round(t.detour_minutes)} min detour · ` : ''}Pickup near {formatPlace(t.pickup.label)}
                        </p>
                        {anyDate && <p className="text-xs text-muted-foreground">{dayLabel(t.target_date)}</p>}
                      </div>
                      <div className="text-right flex flex-col gap-0.5 shrink-0">
                        <span className="font-display text-2xl font-bold">{fmtMoney(t.pricing?.price_per_seat_cents)}</span>
                        <span className="text-xs text-muted-foreground">per seat</span>
                      </div>
                    </div>
                    <div aria-hidden className="h-px bg-border" />
                    <div className="flex items-center gap-3">
                      <Avatar initials={toInitials(name)} photoUrl={t.driver_photo_url} />
                      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <span className="text-[15px] font-semibold flex items-center gap-1.5">{name}{t.driver_stats?.id_verified && <VerifiedIcon />}</span>
                        <span className="text-[13px] text-muted-foreground truncate">{driverLine(t)}</span>
                      </div>
                      <span className={`text-[13px] font-semibold shrink-0 ${requestedTripIds.has(t.id) ? 'text-info' : free <= 1 ? 'text-[#ffb38a]' : 'text-muted-foreground'}`}>
                        {requestedTripIds.has(t.id) ? 'Requested' : `${free} left`}
                      </span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
          {!anyDate && (
            <button type="button" onClick={() => setAnyDate(true)} className="text-sm font-semibold text-info self-center">
              Show rides on other dates
            </button>
          )}
          <button type="button" disabled={notified || !search.to}
            onClick={async () => { try { await onNotify(); setNotified(true) } catch (e) { showToast(e instanceof Error ? e.message : 'Could not set alert', 'error') } }}
            className="mt-2 min-h-[52px] rounded-[14px] border border-dashed border-border bg-transparent text-secondary-foreground text-sm font-semibold flex items-center justify-center gap-2 px-4 disabled:opacity-60">
            {notified ? <><Check className="size-4" />We'll notify you when a ride is posted</> : <><Bell className="size-4" />Not seeing a fit? Get notified when a ride is posted</>}
          </button>
        </>
      )}
    </div>
  )
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

// ─── 3 · Ride details & request ───────────────────────────────────────────────

// Schematic route illustration (the exact pickup point stays private until a
// ride is accepted, so this deliberately doesn't plot real coordinates).
function RouteSketch() {
  return (
    <svg viewBox="0 0 390 300" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 w-full h-full" role="img" aria-label="Route preview">
      <rect width="390" height="300" fill="#101a2c" />
      <g stroke="#1b2740" strokeWidth="10" fill="none">
        <path d="M-10 70 H400" /><path d="M-10 170 H400" /><path d="M-10 250 H400" />
        <path d="M60 -10 V310" /><path d="M170 -10 V310" /><path d="M290 -10 V310" />
      </g>
      <path d="M40 250 L170 250 L170 170 L290 170 L290 90" stroke="#7cc4ff" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M110 205 L170 205" stroke="#eef2f8" strokeWidth="3" strokeDasharray="2 7" strokeLinecap="round" />
      <circle cx="110" cy="205" r="7" fill="#0b1220" stroke="#eef2f8" strokeWidth="3" />
      <circle cx="170" cy="205" r="9" fill="#7cc4ff" stroke="#0b1220" strokeWidth="3" />
      <rect x="280" y="80" width="20" height="20" rx="4" fill="#f5b544" stroke="#0b1220" strokeWidth="3" />
    </svg>
  )
}

function TimelineRow({ time, title, sub, tone = 'default' }: { time: string; title: string; sub?: string; tone?: 'default' | 'info' | 'accent' }) {
  const color = tone === 'info' ? 'text-info' : tone === 'accent' ? 'text-primary' : 'text-foreground'
  return (
    <div className="flex gap-3 items-start">
      <span className={`w-14 shrink-0 text-[15px] font-bold ${color}`}>{time}</span>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[15px] font-semibold">{title}</span>
        {sub && <span className="text-[13px] text-muted-foreground">{sub}</span>}
      </div>
    </div>
  )
}

export function RideDetailScreen({ trip, seats, requested, onBack, onRequest }: {
  trip: ApiDriverTrip
  seats: number
  requested: boolean
  onBack: () => void
  onRequest: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const name = trip.driver_name ?? 'Driver'
  const first = name.split(' ')[0]
  const pricing = trip.pricing
  const share = (pricing?.price_per_seat_cents ?? 0) * seats
  const stats = trip.driver_stats
  const car = trip.vehicle ? [trip.vehicle.color, trip.vehicle.make, trip.vehicle.model].filter(Boolean).join(' ') : ''
  const statLine = [
    stats?.rating_avg != null ? `★ ${stats.rating_avg.toFixed(1)}` : 'New driver',
    stats && stats.completed_trips > 0 ? `${stats.completed_trips} trips` : null,
    stats?.id_verified ? 'ID verified' : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="max-w-md mx-auto -mx-4 -mt-4 xl:mx-auto xl:mt-0 relative pb-40 xl:pb-6">
      <div className="relative h-[300px] xl:rounded-3xl overflow-hidden">
        <RouteSketch />
        <div className="absolute top-4 left-4"><IconButton label="Back" onClick={onBack} className="rounded-full bg-background"><ChevronLeft className="size-5" /></IconButton></div>
      </div>
      <div className="relative -mt-7 bg-background rounded-t-3xl border-t border-border px-5 pt-5 flex flex-col gap-[18px]">
        <div className="flex items-center gap-3">
          <Avatar initials={toInitials(name)} photoUrl={trip.driver_photo_url} size="lg" />
          <div className="flex-1 min-w-0">
            <p className="text-lg font-bold flex items-center gap-1.5">{name}{stats?.id_verified && <VerifiedIcon />}</p>
            <p className="text-[13px] text-muted-foreground">{statLine}</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl px-4 py-3.5 flex flex-col gap-3">
          <TimelineRow
            time={trip.departure_time ? fmtTimeShort(trip.departure_time) : dayLabel(trip.target_date)}
            title={`Pickup near ${formatPlace(trip.pickup.label)}`}
            sub={`${trip.departure_time ? dayLabel(trip.target_date) : FLEX_LABEL[trip.flexibility as Flexibility] ?? 'Flexible'}${car ? ` · ${car}` : ''} · exact spot shared once accepted`}
            tone="info"
          />
          <TimelineRow
            time={trip.estimated_arrival_time ? fmtTimeShort(trip.estimated_arrival_time) : `~${trip.duration_minutes ?? '—'}m`}
            title={`Drop-off · ${formatPlace(trip.destination.label)}`}
            sub={trip.duration_minutes ? `About ${trip.duration_minutes} min on the road` : undefined}
            tone="accent"
          />
        </div>

        {trip.notes && <p className="text-sm text-secondary-foreground bg-card border border-border rounded-2xl px-4 py-3">“{trip.notes}”</p>}

        {pricing && (
          <section className="flex flex-col gap-2">
            <SectionLabel>How the cost is split</SectionLabel>
            <div className="flex justify-between text-[15px]"><span className="text-secondary-foreground">Estimated gas, {kmToMi(pricing.distance_km)} mi</span><span>{fmtMoney(pricing.gas_cost_cents)}</span></div>
            <div className="flex justify-between text-[15px]"><span className="text-secondary-foreground">Shared by {pricing.split_between} people</span><span>÷ {pricing.split_between}</span></div>
            {pricing.price_per_seat_cents !== pricing.suggested_price_cents && (
              <div className="flex justify-between text-[15px]"><span className="text-secondary-foreground">{first} set the price per seat</span><span>{fmtMoney(pricing.price_per_seat_cents)}</span></div>
            )}
            <div className="flex justify-between text-base font-bold"><span>Your share{seats > 1 ? ` (${seats} seats)` : ''}</span><span>{fmtMoney(share)}</span></div>
          </section>
        )}
      </div>

      <StickyFooter>
        <PrimaryButton disabled={busy || requested} onClick={async () => { setBusy(true); try { await onRequest() } finally { setBusy(false) } }}>
          {requested ? 'Request sent' : busy ? 'Sending…' : `Request ${seats > 1 ? `${seats} seats` : 'seat'} · ${fmtMoney(share)}`}
        </PrimaryButton>
        <p className="text-xs text-muted-foreground text-center">Nothing is charged in the app — you settle the gas split with {first}. Cancel anytime before pickup.</p>
      </StickyFooter>
    </div>
  )
}

// ─── 4 · Trip day ─────────────────────────────────────────────────────────────

export function TripDayScreen({
  connection, currentUserId, onClose, onMessage, onStartDriving, onComplete, showToast,
}: {
  connection: Connection
  currentUserId: string
  onClose: () => void
  onMessage: (c: Connection) => void
  onStartDriving: (c: Connection) => void
  onComplete: (id: string) => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const raw = connection.raw
  const trip = raw?.driver_trip
  const partner = connection.myRole === 'rider' ? raw?.driver_profile : raw?.rider_profile
  const partnerFirst = connection.withUser.name.split(' ')[0]
  const [live, setLive] = useState<TripDayStatus | null>(null)
  const [checkedIn, setCheckedIn] = useState<string | null>(raw?.rider_at_pickup_at ?? null)
  const [safetyOpen, setSafetyOpen] = useState(false)
  const [rating, setRating] = useState<number | null>(raw?.my_rating ?? null)
  const [busy, setBusy] = useState(false)
  const accepted = connection.status === 'accepted'
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!accepted) return
    const load = () => api.getTripDayStatus(connection.id).then(s => { setLive(s); if (s.rider_at_pickup_at) setCheckedIn(s.rider_at_pickup_at) }).catch(() => {})
    load()
    pollRef.current = setInterval(load, 15000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [connection.id, accepted])

  const pickupLabel = live?.pickup.label ? formatPlace(live.pickup.label) : connection.riderPickupLabel ?? connection.from
  const departure = trip?.departure_time ? fmtTime(trip.departure_time) : null
  const eta = live?.driver?.eta_minutes
  const car = trip?.vehicle ? [trip.vehicle.color, trip.vehicle.make, trip.vehicle.model].filter(Boolean).join(' ') : ''
  const phone = partner && 'phone' in partner ? partner.phone : null

  const headline = connection.status === 'completed' ? `Ride with ${partnerFirst} complete`
    : !accepted ? `Waiting for ${partnerFirst} to accept`
    : connection.myRole === 'rider'
      ? (eta != null ? (eta <= 1 ? `${partnerFirst} is arriving now` : `${partnerFirst} arrives in ${eta} min`) : departure ? `Pickup at ${departure}` : `Pickup ${dayLabel(connection.date)}`)
      : (checkedIn ? `${partnerFirst} is at the pickup` : departure ? `Pick up ${partnerFirst} at ${departure}` : `Pick up ${partnerFirst} ${dayLabel(connection.date).toLowerCase()}`)
  const subline = connection.myRole === 'rider'
    ? (accepted ? (eta != null && eta <= 10 ? `Leave now to reach ${pickupLabel} on time` : `Meet at ${pickupLabel}`) : 'You’ll get a notification when they do')
    : `Pickup at ${pickupLabel}`

  const share = async () => {
    const text = `I'm carpooling with ${connection.withUser.name} on ${dayLabel(connection.date)}${departure ? ` at ${departure}` : ''}: ${connection.from} → ${connection.to}${car ? ` in a ${car}` : ''}${trip?.vehicle?.plate ? ` (${trip.vehicle.plate})` : ''}.`
    try {
      if (navigator.share) await navigator.share({ title: 'My carpool trip', text })
      else { await navigator.clipboard.writeText(text); showToast('Trip details copied', 'success') }
    } catch { /* share sheet dismissed */ }
  }

  const sendLate = async () => {
    try { await api.sendMessage(connection.id, 'Running a few minutes late — be there soon!'); showToast(`Let ${partnerFirst} know`, 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to send', 'error') }
  }

  const checkIn = async () => {
    setBusy(true)
    try { const c = await api.markAtPickup(connection.id); setCheckedIn(c.rider_at_pickup_at ?? new Date().toISOString()); showToast(`${partnerFirst} knows you're there`, 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') }
    finally { setBusy(false) }
  }

  const rate = async (stars: number) => {
    setRating(stars)
    try { await api.rateConnection(connection.id, stars); showToast('Thanks for rating', 'success') }
    catch (e) { setRating(raw?.my_rating ?? null); showToast(e instanceof Error ? e.message : 'Failed', 'error') }
  }

  const tile = 'min-h-[72px] rounded-2xl border border-border bg-card text-foreground text-[13px] font-semibold flex flex-col items-center justify-center gap-1.5 disabled:opacity-40'

  return (
    <div className="max-w-md mx-auto flex flex-col gap-[18px] pb-40 xl:pb-6">
      <div className="flex items-center justify-between">
        <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        <button type="button" onClick={() => setSafetyOpen(true)}
          className="min-h-11 px-3.5 rounded-xl bg-card border border-border text-foreground text-sm font-semibold flex items-center gap-2">
          <ShieldCheck className="size-4" />Safety
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {accepted && connection.myRole === 'rider' && (
          <span className="text-sm font-semibold text-info flex items-center gap-2">
            <span aria-hidden className="size-2 rounded-full bg-info" />
            {live?.driver ? 'Live · updated just now' : 'Live location appears when your driver starts sharing'}
          </span>
        )}
        <h1 className="font-display text-[34px] font-bold tracking-[-0.02em] leading-[1.05]">{headline}</h1>
        <p className="text-[15px] text-secondary-foreground">{subline}</p>
      </div>

      {connection.myRole === 'rider' && (car || trip?.vehicle?.plate) && (
        <div className="bg-card border border-border rounded-[20px] p-4 flex items-center gap-3.5">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-muted-foreground">Look for</p>
            <p className="text-[17px] font-semibold truncate">{car || 'Your driver’s car'}</p>
          </div>
          {trip?.vehicle?.plate && (
            <div className="border-2 border-foreground rounded-lg px-3 py-1.5 font-display text-[22px] font-bold tracking-[0.07em]">{trip.vehicle.plate}</div>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2.5">
        <button type="button" className={tile} onClick={() => onMessage(connection)}><MessageCircle className="size-[22px]" />Message</button>
        {phone
          ? <a className={tile} href={`tel:${phone.replace(/[^+\d]/g, '')}`}><Phone className="size-[22px]" />Call</a>
          : <button type="button" className={tile} disabled title={accepted ? `${partnerFirst} hasn't added a phone number` : 'Available once accepted'}><Phone className="size-[22px]" />Call</button>}
        <button type="button" className={tile} onClick={share}><Share2 className="size-[22px]" />Share trip</button>
      </div>

      <ol className="bg-card border border-border rounded-[20px] p-4 flex flex-col">
        <TimelineStep state="done" title={accepted || connection.status === 'completed' ? 'Booked · seat confirmed' : 'Requested · waiting to be accepted'}
          sub={trip?.pricing ? `${fmtMoney(trip.pricing.price_per_seat_cents)} per seat, settled with ${connection.myRole === 'rider' ? partnerFirst : 'your rider'}` : undefined} />
        <TimelineStep state={connection.status === 'completed' ? 'done' : 'current'}
          title={`Pickup ${departure ?? dayLabel(connection.date)} · ${pickupLabel}`}
          sub={checkedIn ? `${connection.myRole === 'rider' ? 'You' : partnerFirst} checked in at the pickup` : undefined} />
        <TimelineStep state={connection.status === 'completed' ? 'done' : 'next'} last
          title={`Drop-off${trip?.estimated_arrival_time ? ` ${fmtTime(trip.estimated_arrival_time)}` : ''} · ${connection.to}`} />
      </ol>

      {connection.status === 'completed' && (
        <section className="bg-card border border-border rounded-[20px] p-4 flex flex-col gap-3 items-center">
          <p className="text-[15px] font-semibold">{rating ? 'Your rating' : `How was the ride with ${partnerFirst}?`}</p>
          <StarRating value={rating} onChange={rate} />
        </section>
      )}

      {accepted && (
        <StickyFooter>
          {connection.myRole === 'rider' ? (
            <>
              <PrimaryButton onClick={checkIn} disabled={busy || !!checkedIn}>{checkedIn ? 'You’re checked in' : 'I’m at the pickup spot'}</PrimaryButton>
              <button type="button" onClick={sendLate} className="w-full h-12 rounded-[14px] text-secondary-foreground text-[15px] font-semibold">Running late? Let {partnerFirst} know</button>
            </>
          ) : (
            <>
              {connection.riderPickupLat != null && (
                <PrimaryButton onClick={() => onStartDriving(connection)}><span className="inline-flex items-center gap-2"><Navigation className="size-5" />Start driving</span></PrimaryButton>
              )}
              <button type="button" disabled={busy}
                onClick={async () => { setBusy(true); try { await onComplete(connection.id) } finally { setBusy(false) } }}
                className="w-full h-12 rounded-[14px] border border-border text-foreground text-[15px] font-semibold">
                Mark ride complete
              </button>
            </>
          )}
        </StickyFooter>
      )}

      <BottomSheet open={safetyOpen} onClose={() => setSafetyOpen(false)} title="Safety">
        <div className="space-y-2">
          <button type="button" onClick={share} className="w-full h-12 rounded-xl bg-muted border border-border text-sm font-semibold flex items-center justify-center gap-2"><Share2 className="size-4" />Share trip details with a friend</button>
          <a href="tel:911" className="w-full h-12 rounded-xl bg-destructive text-destructive-foreground text-sm font-bold flex items-center justify-center gap-2"><Phone className="size-4" />Call 911</a>
          <p className="text-xs text-muted-foreground text-center pt-1">To block or report {partnerFirst}, use the ⋯ menu in your conversation.</p>
        </div>
      </BottomSheet>
    </div>
  )
}

function TimelineStep({ state, title, sub, last = false }: { state: 'done' | 'current' | 'next'; title: string; sub?: string; last?: boolean }) {
  return (
    <li className="flex gap-3.5">
      <div aria-hidden className="flex flex-col items-center">
        <span className={`size-3.5 shrink-0 ${state === 'done' ? 'rounded-full bg-info' : state === 'current' ? 'rounded-full border-[3px] border-primary' : 'rounded-[3px] border-2 border-muted-foreground'}`} />
        {!last && <span className="w-0.5 flex-1 min-h-10 bg-border" />}
      </div>
      <div className={`flex flex-col gap-0.5 min-w-0 ${last ? '' : 'pb-3'}`}>
        <span className={`text-[15px] ${state === 'current' ? 'font-bold' : 'font-semibold'} ${state === 'next' ? 'text-secondary-foreground' : ''}`}>{title}</span>
        {sub && <span className="text-[13px] text-muted-foreground">{sub}</span>}
      </div>
    </li>
  )
}

export function StarRating({ value, onChange }: { value: number | null; onChange: (n: number) => void }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} onClick={() => onChange(n)}
          className="size-11 flex items-center justify-center">
          <Star className={`size-7 ${value != null && n <= value ? 'fill-primary text-primary' : 'text-muted-foreground'}`} />
        </button>
      ))}
    </div>
  )
}

// ─── 5 · Driver: offer a ride ─────────────────────────────────────────────────

export function OfferRideScreen({ initial, userCoords, vehicle, onBack, onPosted, showToast }: {
  initial: RideSearch
  // "Current location" on Home becomes a real, labelled start point here.
  userCoords: { lat: number; lng: number } | null
  vehicle: api.ApiVehicle
  onBack: () => void
  onPosted: (trips: MyListing[]) => void
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const startsAtCurrent = !(initial.from && Number.isFinite(initial.from.lat))
  const [step, setStep] = useState(initial.to && (!startsAtCurrent || userCoords) ? 2 : 1)
  const [from, setFrom] = useState<LocationValue | null>(startsAtCurrent ? null : initial.from)
  useEffect(() => {
    if (!startsAtCurrent || !userCoords) return
    let cancelled = false
    reverseGeocode(userCoords.lat, userCoords.lng)
      .then(label => { if (!cancelled) setFrom(prev => prev ?? { label: formatPlace(label), lat: userCoords.lat, lng: userCoords.lng }) })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [to, setTo] = useState<LocationValue | null>(initial.to)
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time || '08:00')
  const [flexibility, setFlexibility] = useState<Flexibility>('flexible')
  const [seats, setSeats] = useState(Math.max(1, Math.min(initial.seats, vehicle?.seats ? vehicle.seats - 1 || 1 : 8)))
  const [locIds, setLocIds] = useState<{ pickup: string; dest: string; key: string } | null>(null)
  const [pricing, setPricing] = useState<(api.TripPricing & { duration_minutes: number }) | null>(null)
  const [customPrice, setCustomPrice] = useState<string | null>(null)
  const [repeat, setRepeat] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4])
  const [autoAccept, setAutoAccept] = useState(false)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const submittingRef = useRef(false)

  // Locations are created once per from/to pair and reused for the preview and the post.
  const ensureLocations = useCallback(async () => {
    if (!from || !to) throw new Error('Pick both a start and a destination')
    const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`
    if (locIds?.key === key) return locIds
    const [p, d] = await Promise.all([api.createLocation(from.label, from.lat, from.lng), api.createLocation(to.label, to.lat, to.lng)])
    const ids = { pickup: p.id, dest: d.id, key }
    setLocIds(ids)
    return ids
  }, [from, to, locIds])

  useEffect(() => {
    if (step !== 2 || !from || !to) { setPricing(null); return }
    let cancelled = false
    ensureLocations()
      .then(ids => api.previewTripPrice(ids.pickup, ids.dest, seats))
      .then(p => { if (!cancelled) setPricing(p) })
      .catch(() => { if (!cancelled) setPricing(null) })
    return () => { cancelled = true }
  }, [step, seats, from?.lat, to?.lat]) // eslint-disable-line react-hooks/exhaustive-deps

  const priceCents = customPrice != null && customPrice !== '' ? Math.round(parseFloat(customPrice) * 100) : pricing?.suggested_price_cents ?? null
  const routeLine = `${from?.label ?? '…'} → ${to?.label ?? '…'} · ${dayLabel(date)}, ${fmtTime(time)}${pricing ? ` · ${kmToMi(pricing.distance_km)} mi` : ''}`

  const post = async () => {
    if (submittingRef.current) return
    submittingRef.current = true; setBusy(true)
    try {
      const ids = await ensureLocations()
      const trip = await api.createDriverTrip({
        pickup_location_id: ids.pickup, destination_location_id: ids.dest,
        target_date: date, flexibility, seats_available: seats, tags: [],
        car_type: vehicle?.car_type ?? undefined, notes: notes.trim() || undefined,
        departure_time: time || null,
        price_per_seat_cents: customPrice != null && customPrice !== '' && Number.isFinite(priceCents) ? priceCents : null,
        auto_accept_verified: autoAccept,
        repeat_weekdays: repeat ? weekdays : [],
      })
      const n = trip.series_trip_ids?.length ?? 1
      showToast(n > 1 ? `Posted ${n} rides this week` : 'Ride posted!', 'success')
      onPosted([tripToMyListing(trip)])
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to post', 'error')
    } finally { submittingRef.current = false; setBusy(false) }
  }

  const next = async () => {
    if (step === 1) {
      if (!from || !to) { showToast('Pick both a start and a destination', 'error'); return }
      setStep(2)
    } else if (step === 2) {
      if (priceCents != null && (!Number.isFinite(priceCents) || priceCents < 0)) { showToast('Enter a valid price', 'error'); return }
      setStep(3)
    } else {
      await post()
    }
  }

  const toggle = 'size-6 accent-[var(--primary)]'

  return (
    <div className="max-w-md mx-auto flex flex-col gap-[22px] pb-40 xl:pb-6">
      <div className="flex items-center justify-between">
        <IconButton label="Back" onClick={() => (step === 1 ? onBack() : setStep(step - 1))}><ChevronLeft className="size-5" /></IconButton>
        <span className="text-[13px] text-muted-foreground font-semibold">Step {step} of 3</span>
        <span className="w-11" />
      </div>
      <div aria-hidden className="grid grid-cols-3 gap-1.5">
        {[1, 2, 3].map(i => <span key={i} className={`h-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-border'}`} />)}
      </div>

      {step === 1 && (
        <>
          <h1 className="font-display text-[28px] font-bold tracking-[-0.02em]">Route &amp; time</h1>
          <div className="space-y-4">
            <LocationInput label="Leaving from" value={from} onChange={setFrom} placeholder="Your area" />
            <LocationInput label="Going to" value={to} onChange={setTo} placeholder="Destination" />
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="text-sm font-semibold">Date</span>
                <input type="date" value={date} min={todayLocalISO()} onChange={e => e.target.value && setDate(e.target.value)}
                  className="w-full h-12 px-3 rounded-xl bg-input-background border border-border text-sm text-foreground" />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-semibold">Departure</span>
                <input type="time" value={time} onChange={e => setTime(e.target.value)}
                  className="w-full h-12 px-3 rounded-xl bg-input-background border border-border text-sm text-foreground" />
              </label>
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-semibold">How flexible is the time?</span>
              <div className="flex flex-wrap gap-2">
                {(['flexible', 'morning', 'afternoon', 'evening'] as Flexibility[]).map(f => (
                  <button key={f} type="button" aria-pressed={flexibility === f} onClick={() => setFlexibility(f)}
                    className={`h-10 px-3.5 rounded-full text-sm font-semibold border ${flexibility === f ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground'}`}>
                    {f === 'flexible' ? 'Give or take' : `${FLEX_LABEL[f]} window`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[28px] font-bold tracking-[-0.02em]">Seats &amp; cost</h1>
            <span className="text-[15px] text-secondary-foreground">{routeLine}</span>
          </div>
          <Stepper value={seats} min={1} max={vehicle?.seats ? Math.max(1, vehicle.seats - 1) : 8} onChange={setSeats} label="Seats to offer" hint="Not counting you" />
          <div className="bg-card border border-border rounded-[18px] p-4 flex flex-col gap-3">
            <div className="flex justify-between items-baseline">
              <span className="text-base font-semibold">Each rider pays</span>
              <span className="font-display text-[30px] font-bold">{fmtMoney(priceCents)}</span>
            </div>
            <span className="text-[13px] text-secondary-foreground leading-[1.45]">
              {pricing
                ? <>Suggested from ~{fmtMoney(pricing.gas_cost_cents)} in gas, split evenly between you and {seats} {seats === 1 ? 'rider' : 'riders'}. You keep the trip cost-neutral — no profit, no loss.</>
                : 'Working out the gas cost for this route…'}
            </span>
            {customPrice == null ? (
              <button type="button" onClick={() => setCustomPrice(priceCents != null ? (priceCents / 100).toFixed(2) : '')}
                className="self-start min-h-11 px-3.5 rounded-xl border border-border bg-muted text-foreground text-sm font-semibold">Adjust price</button>
            ) : (
              <div className="flex items-center gap-2">
                <label className="relative flex-1">
                  <span className="sr-only">Price per seat</span>
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <input type="number" inputMode="decimal" min="0" step="0.25" value={customPrice} onChange={e => setCustomPrice(e.target.value)}
                    className="w-full h-11 pl-7 pr-3 rounded-xl bg-input-background border border-border text-sm text-foreground" />
                </label>
                <button type="button" onClick={() => setCustomPrice(null)} className="min-h-11 px-3.5 rounded-xl border border-border text-sm font-semibold">Use suggested</button>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center justify-between min-h-[52px] gap-3">
              <span className="flex flex-col gap-0.5"><span className="text-[15px] font-semibold">Repeat on weekdays</span><span className="text-[13px] text-muted-foreground">Riders can book any day this week</span></span>
              <input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} className={toggle} />
            </label>
            {repeat && (
              <div className="flex gap-1.5 pb-2" role="group" aria-label="Repeat on">
                {WEEKDAY_SHORT.map((d, i) => (
                  <button key={d} type="button" aria-pressed={weekdays.includes(i)} onClick={() => setWeekdays(w => w.includes(i) ? w.filter(x => x !== i) : [...w, i])}
                    className={`flex-1 h-10 rounded-lg text-xs font-bold border ${weekdays.includes(i) ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground'}`}>
                    {d.slice(0, 2)}
                  </button>
                ))}
              </div>
            )}
            <label className="flex items-center justify-between min-h-[52px] gap-3">
              <span className="flex flex-col gap-0.5"><span className="text-[15px] font-semibold">Auto-accept verified riders</span><span className="text-[13px] text-muted-foreground">Others still need your OK</span></span>
              <input type="checkbox" checked={autoAccept} onChange={e => setAutoAccept(e.target.checked)} className={toggle} />
            </label>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <h1 className="font-display text-[28px] font-bold tracking-[-0.02em]">Review</h1>
          <div className="bg-card border border-border rounded-[18px] p-4 flex flex-col gap-3 text-[15px]">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Route</span><span className="font-semibold text-right">{from?.label} → {to?.label}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Leaving</span><span className="font-semibold text-right">{dayLabel(date)}, {fmtTime(time)}{repeat && weekdays.length ? ` · ${weekdaysLabel(weekdays)}` : ''}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Seats</span><span className="font-semibold">{seats}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Each rider pays</span><span className="font-semibold">{fmtMoney(priceCents)}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Verified riders</span><span className="font-semibold">{autoAccept ? 'Accepted automatically' : 'Need your OK'}</span></div>
            {vehicle && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Car</span><span className="font-semibold text-right">{[vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'}</span></div>}
          </div>
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">Note for riders <span className="text-muted-foreground font-normal">(optional)</span></span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Room for a carry-on, no big suitcases"
              className="w-full px-3 py-2.5 rounded-xl bg-input-background border border-border text-sm text-foreground resize-none" />
          </label>
        </>
      )}

      <StickyFooter>
        <PrimaryButton onClick={next} disabled={busy}>{step === 3 ? (busy ? 'Posting…' : repeat && weekdays.length > 1 ? 'Post these rides' : 'Post ride') : 'Continue'}</PrimaryButton>
        <p className="text-xs text-muted-foreground text-center">You can edit or cancel until the first rider books</p>
      </StickyFooter>
    </div>
  )
}

// ─── Trips summary helpers ────────────────────────────────────────────────────

export function pickNextTrip(connections: Connection[], role: 'rider' | 'driver'): Connection | null {
  const today = todayLocalISO()
  const upcoming = connections
    .filter(c => c.myRole === role && (c.status === 'accepted' || c.status === 'pending') && c.date >= today)
    .sort((a, b) => (a.status === b.status ? a.date.localeCompare(b.date) : a.status === 'accepted' ? -1 : 1))
  return upcoming[0] ?? null
}

