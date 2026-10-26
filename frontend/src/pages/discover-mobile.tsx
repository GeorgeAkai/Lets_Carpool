import { useEffect, useState, type ReactNode } from 'react'
import {
  Search, SlidersHorizontal, X, MapPin, ArrowRight, Users, Package,
  Pencil, Map as MapIcon, Plus, Calendar, ChevronDown, Check, LocateFixed,
} from 'lucide-react'
import {
  Avatar, FLEX_LABEL, FLEX_DOT, CAR_TYPE_LABELS, CAR_TYPE_EMOJI, LUGGAGE_LABELS,
} from './home'
import type { Listing, RideTag, CarType, LuggageSize } from './home'

// ─── Mobile Discover screen primitives ─────────────────────────────────────────
// Shared by both mode branches (passenger's FeedView and driver's DriverHomeView) so
// neither duplicates the search/filter/card logic the other already has.

// Uber-style two-stop search: the origin is always the passenger's current
// location (the feed is already sorted around it), so only the destination is
// editable — one prominent "Where to?" field instead of a page header.
export function MobileSearchBar({ value, onChange, hasLocation }: {
  value: string; onChange: (v: string) => void; hasLocation: boolean
}) {
  return (
    <div className="rounded-2xl bg-card border border-border shadow-sm focus-within:ring-2 focus-within:ring-ring/25 focus-within:border-primary/30 transition-colors">
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2 text-xs text-muted-foreground">
        <LocateFixed className={`size-3.5 shrink-0 ${hasLocation ? 'text-primary' : ''}`} />
        <span className="truncate">{hasLocation ? 'Current Location' : 'Current Location · location off, showing all areas'}</span>
      </div>
      <div className="mx-4 border-t border-border" />
      <label className="flex items-center gap-2.5 px-4 py-3">
        <Search className="size-5 shrink-0 text-foreground" />
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Where to?"
          aria-label="Where to?"
          className="flex-1 min-w-0 bg-transparent text-base font-medium text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {value && (
          <button type="button" onClick={() => onChange('')} aria-label="Clear destination" className="p-1 -mr-1 rounded-full text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </label>
    </div>
  )
}

// Shared bottom-sheet shell for every mobile selector (full filters and the
// single-choice quick filters), so none of them expand inline and push the
// feed down.
export function BottomSheet({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card rounded-t-3xl border-t border-border shadow-xl px-5 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+2rem)] space-y-5 max-h-[80vh] overflow-y-auto">
        <div className="flex justify-center"><span className="block w-9 h-1 rounded-full bg-border" /></div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <button onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function OptionList<T extends string | number | null>({ options, value, onSelect }: {
  options: { value: T; label: string }[]; value: T; onSelect: (v: T) => void
}) {
  return (
    <div className="space-y-1" role="radiogroup">
      {options.map(o => (
        <button
          key={String(o.value)} role="radio" aria-checked={value === o.value} onClick={() => onSelect(o.value)}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-colors ${value === o.value ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'}`}
        >
          {o.label}
          {value === o.value && <Check className="size-4" />}
        </button>
      ))}
    </div>
  )
}

export function MobileFilterBar({
  onOpenFilters, activeCount, quickDate, onQuickDate, seatsNeeded, onSeatsNeeded, showSeats = true,
}: {
  showSeats?: boolean
  onOpenFilters: () => void
  activeCount: number
  quickDate: 'today' | 'any'; onQuickDate: (v: 'today' | 'any') => void
  seatsNeeded: number | null; onSeatsNeeded: (v: number | null) => void
}) {
  const [openSheet, setOpenSheet] = useState<'date' | 'seats' | null>(null)
  const pill = (active: boolean) =>
    `shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium transition-colors ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button onClick={onOpenFilters} className={pill(activeCount > 0)}>
          <SlidersHorizontal className="size-3.5" /> Filters
          {activeCount > 0 && (
            <span className="size-4 flex items-center justify-center rounded-full bg-primary-foreground text-primary text-[10px] font-bold">{activeCount}</span>
          )}
        </button>
        <button onClick={() => setOpenSheet('date')} className={pill(quickDate === 'today')} aria-haspopup="dialog">
          <Calendar className="size-3.5" /> Date: {quickDate === 'today' ? 'Today' : 'Any'} <ChevronDown className="size-3.5 opacity-70" />
        </button>
        {showSeats && (
          <button onClick={() => setOpenSheet('seats')} className={pill(seatsNeeded != null)} aria-haspopup="dialog">
            <Users className="size-3.5" /> {seatsNeeded ? `${seatsNeeded}+ seat${seatsNeeded > 1 ? 's' : ''}` : 'Seats Needed'} <ChevronDown className="size-3.5 opacity-70" />
          </button>
        )}
      </div>

      <BottomSheet open={openSheet === 'date'} onClose={() => setOpenSheet(null)} title="Date">
        <OptionList
          options={[{ value: 'today' as const, label: 'Today' }, { value: 'any' as const, label: 'Any date' }]}
          value={quickDate}
          onSelect={v => { onQuickDate(v); setOpenSheet(null) }}
        />
      </BottomSheet>
      <BottomSheet open={openSheet === 'seats'} onClose={() => setOpenSheet(null)} title="Seats needed">
        <OptionList<number | null>
          options={[{ value: null, label: 'Any' }, ...[1, 2, 3, 4].map(n => ({ value: n, label: `${n}+ seat${n > 1 ? 's' : ''}` }))]}
          value={seatsNeeded}
          onSelect={v => { onSeatsNeeded(v); setOpenSheet(null) }}
        />
      </BottomSheet>
    </>
  )
}

export function FilterSheet({
  open, onClose,
  filterType, setFilterType, filterTag, setFilterTag, filterCarType, setFilterCarType, filterLuggage, setFilterLuggage,
}: {
  open: boolean; onClose: () => void
  filterType: 'all' | 'driver' | 'rider'; setFilterType: (v: 'all' | 'driver' | 'rider') => void
  filterTag: '' | RideTag; setFilterTag: (v: '' | RideTag) => void
  filterCarType: '' | CarType; setFilterCarType: (v: '' | CarType) => void
  filterLuggage: '' | LuggageSize; setFilterLuggage: (v: '' | LuggageSize) => void
}) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Filters">
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Showing</p>
          <div className="flex flex-wrap gap-2">
            {(['all', 'driver', 'rider'] as const).map(t => (
              <button key={t} onClick={() => setFilterType(t)} className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${filterType === t ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:text-foreground'}`}>
                {t === 'all' ? 'All' : t === 'driver' ? 'Offering rides' : 'Need rides'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Category</p>
          <div className="flex flex-wrap gap-2">
            {(['', 'airport', 'student', 'church', 'college'] as const).map(tag => (
              <button key={tag} onClick={() => setFilterTag(tag as '' | RideTag)} className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${filterTag === tag ? 'bg-secondary text-secondary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:text-foreground'}`}>
                {tag === '' ? 'All tags' : tag.charAt(0).toUpperCase() + tag.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Vehicle size</p>
          <div className="flex flex-wrap gap-2">
            {(['', 'sedan', 'suv', 'van', 'minivan', 'truck'] as const).map(ct => (
              <button key={ct} onClick={() => setFilterCarType(ct as '' | CarType)} className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${filterCarType === ct ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:text-foreground'}`}>
                {ct === '' ? 'Any' : `${CAR_TYPE_EMOJI[ct as CarType]} ${CAR_TYPE_LABELS[ct as CarType]}`}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Luggage I'm bringing</p>
          <div className="flex flex-wrap gap-2">
            {(['', 'small', 'medium', 'large', 'oversized'] as const).map(ls => (
              <button key={ls} onClick={() => setFilterLuggage(ls as '' | LuggageSize)} className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${filterLuggage === ls ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:text-foreground'}`}>
                {ls === '' ? 'Any' : LUGGAGE_LABELS[ls as LuggageSize]}
              </button>
            ))}
          </div>
        </div>

        <button onClick={onClose} className="w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
          Show results
        </button>
    </BottomSheet>
  )
}

export function SectionHeader({ label, count, noun }: { label: string; count: number; noun: string }) {
  return (
    <div className="flex items-baseline justify-between px-1">
      <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</h2>
      <span className="text-xs text-muted-foreground">{count} {noun} nearby</span>
    </div>
  )
}

export function MobileListingCard({ listing, onConnect, currentUserId, onEditOwn, alreadyConnected = false, extra }: {
  listing: Listing; onConnect: (l: Listing) => void; currentUserId: string; onEditOwn: () => void
  alreadyConnected?: boolean
  // Optional badges under the route, e.g. a driver's match score for a passenger.
  extra?: ReactNode
}) {
  const isDriver = listing.type === 'driver'
  const freeSeats = isDriver ? (listing.seats! - (listing.seatsUsed ?? 0)) : 0
  const isOwn = listing.ownerId === currentUserId

  return (
    <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar initials={listing.user.initials} photoUrl={listing.user.photoUrl} size="card" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{listing.user.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`size-1.5 rounded-full ${FLEX_DOT[listing.flexibility]}`} />{FLEX_LABEL[listing.flexibility]} · {listing.date}
            </p>
          </div>
        </div>
        {isOwn ? (
          <button onClick={onEditOwn} title="Manage in My Rides" className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-secondary-foreground text-xs font-semibold hover:opacity-90 transition-opacity">
            Your Listing <Pencil className="size-3" />
          </button>
        ) : (
          <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${isDriver ? 'bg-secondary text-secondary-foreground' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
            {isDriver ? `${freeSeats} seat${freeSeats !== 1 ? 's' : ''} left` : 'Needs ride'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <MapPin className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground truncate">{listing.from}</span>
        <ArrowRight className="size-3 text-muted-foreground shrink-0" />
        <span className="font-semibold text-foreground truncate">{listing.to}</span>
      </div>

      {extra}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {!isDriver && (
          <span className="flex items-center gap-1"><Users className="size-3" />{listing.passengers} passenger{(listing.passengers ?? 0) > 1 ? 's' : ''}</span>
        )}
        {isDriver && listing.carType && (
          <span className="flex items-center gap-1">{CAR_TYPE_EMOJI[listing.carType]} {CAR_TYPE_LABELS[listing.carType]}</span>
        )}
        {isDriver && listing.luggageCapacity && listing.luggageCapacity !== 'none' && (
          <span className="flex items-center gap-1"><Package className="size-3" />Up to {LUGGAGE_LABELS[listing.luggageCapacity]}</span>
        )}
        {!isDriver && listing.luggageSize && listing.luggageSize !== 'none' && (
          <span className="flex items-center gap-1"><Package className="size-3" />{LUGGAGE_LABELS[listing.luggageSize]}</span>
        )}
      </div>

      {listing.notes && (
        <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">“{listing.notes}”</p>
      )}

      {!isOwn && (
        alreadyConnected ? (
          <div className="mt-1 w-full py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-medium flex items-center justify-center gap-1.5">
            <Check className="size-4" />{isDriver ? 'Request sent' : 'Offer sent'}
          </div>
        ) : (
          <button
            onClick={() => onConnect(listing)}
            className="mt-1 w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all"
          >
            {/* Driver listings are seats you can ask for; passenger listings are
                people you can pick up. */}
            {isDriver ? 'Request Ride' : 'Offer Ride'}
          </button>
        )
      )}
    </div>
  )
}

// Navigates to the standalone Map tab (which already has its own full mobile
// search/sheet/driver-list experience) rather than toggling an embedded map
// inline — avoids running two different "search for a ride" UIs at once.
export function ViewToggleFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Switch to map view"
      className="fixed bottom-[calc(var(--bottom-nav-h)+1rem)] left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-5 py-3 rounded-full bg-foreground text-background text-sm font-semibold shadow-xl active:scale-95 transition-transform"
    >
      <MapIcon className="size-4" /> Map View
    </button>
  )
}

// Icon-only (not a labeled pill like ViewToggleFab): on narrow phones a
// second full-width text pill at the same bottom-20 row would overlap the
// centered map-toggle pill's bounding box. A compact circle stays clear of
// it regardless of screen width, at the cost of relying on aria-label alone
// for accessible naming.
export function OfferRideFab({ mode, onClick }: { mode: 'rider' | 'driver'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={mode === 'driver' ? 'Offer a ride' : 'Request a ride'}
      title={mode === 'driver' ? 'Offer a ride' : 'Request a ride'}
      className="fixed bottom-[calc(var(--bottom-nav-h)+1rem)] right-4 z-30 size-14 rounded-full bg-primary text-primary-foreground shadow-xl active:scale-95 transition-transform flex items-center justify-center"
    >
      <Plus className="size-6" />
    </button>
  )
}
