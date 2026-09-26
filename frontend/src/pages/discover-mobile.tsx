import { useEffect } from 'react'
import {
  Search, SlidersHorizontal, X, MapPin, ArrowRight, Users, Package,
  Pencil, Map as MapIcon, Plus, Check,
} from 'lucide-react'
import {
  Avatar, FLEX_LABEL, CAR_TYPE_LABELS, CAR_TYPE_EMOJI, LUGGAGE_LABELS,
} from './home'
import type { Listing, RideTag, CarType, LuggageSize } from './home'

// ─── Mobile Discover screen primitives ─────────────────────────────────────────
// Shared by both mode branches (rider's FeedView and driver's DriverHomeView) so
// neither duplicates the search/filter/card logic the other already has.

export function MobileSearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-card border border-border px-4 py-3.5 shadow-sm focus-within:ring-2 focus-within:ring-ring/25 focus-within:border-primary/30 transition-colors">
      <Search className="size-5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Where to? (e.g. San Francisco, Airport)"
        className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
    </div>
  )
}

export function MobileFilterBar({
  onOpenFilters, activeCount, quickDate, onQuickDate, seatsNeeded, onSeatsNeeded,
}: {
  onOpenFilters: () => void
  activeCount: number
  quickDate: 'today' | 'any'; onQuickDate: (v: 'today' | 'any') => void
  seatsNeeded: number | null; onSeatsNeeded: (v: number | null) => void
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <button
        onClick={onOpenFilters}
        className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
      >
        <SlidersHorizontal className="size-3.5" /> Filters
        {activeCount > 0 && (
          <span className="size-4 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold">{activeCount}</span>
        )}
      </button>
      <button
        onClick={() => onQuickDate(quickDate === 'today' ? 'any' : 'today')}
        className={`shrink-0 px-3.5 py-2 rounded-full text-sm font-medium transition-colors ${quickDate === 'today' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
      >
        Date: {quickDate === 'today' ? 'Today' : 'Any'}
      </button>
      <select
        aria-label="Seats needed"
        value={seatsNeeded ?? ''}
        onChange={e => onSeatsNeeded(e.target.value ? Number(e.target.value) : null)}
        className={`shrink-0 appearance-none px-3.5 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer border-none focus:outline-none ${seatsNeeded ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
      >
        <option value="">Seats needed</option>
        {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}+ seat{n > 1 ? 's' : ''}</option>)}
      </select>
    </div>
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Filters">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card rounded-t-3xl border-t border-border shadow-xl p-5 pb-8 space-y-5 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Filters</h2>
          <button onClick={onClose} aria-label="Close filters" className="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors">
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Showing</p>
          <div className="flex flex-wrap gap-2">
            {(['all', 'driver', 'rider'] as const).map(t => (
              <button key={t} onClick={() => setFilterType(t)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterType === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                {t === 'all' ? 'All' : t === 'driver' ? 'Offering rides' : 'Need rides'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category</p>
          <div className="flex flex-wrap gap-2">
            {(['', 'airport', 'student', 'church', 'college'] as const).map(tag => (
              <button key={tag} onClick={() => setFilterTag(tag as '' | RideTag)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterTag === tag ? 'bg-accent/20 text-amber-800 ring-1 ring-accent/40' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                {tag === '' ? 'All tags' : tag.charAt(0).toUpperCase() + tag.slice(1)}
              </button>
            ))}
          </div>
        </div>

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

        <button onClick={onClose} className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
          Show results
        </button>
      </div>
    </div>
  )
}

export function SectionHeader({ label, count, noun }: { label: string; count: number; noun: string }) {
  return (
    <div className="flex items-baseline justify-between px-1">
      <h2 className="text-lg font-semibold text-foreground">{label}</h2>
      <span className="text-xs text-muted-foreground">{count} {noun} nearby</span>
    </div>
  )
}

export function MobileListingCard({ listing, onConnect, currentUserId, onEditOwn, alreadyConnected }: {
  listing: Listing; onConnect: (l: Listing) => void; currentUserId: string; onEditOwn: () => void
  alreadyConnected: boolean
}) {
  const isDriver = listing.type === 'driver'
  const freeSeats = isDriver ? (listing.seats! - (listing.seatsUsed ?? 0)) : 0
  const isOwn = listing.ownerId === currentUserId

  return (
    <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar initials={listing.user.initials} photoUrl={listing.user.photoUrl} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{listing.user.name}</p>
            <p className="text-xs text-muted-foreground">{FLEX_LABEL[listing.flexibility]}</p>
          </div>
        </div>
        {isOwn ? (
          <button onClick={onEditOwn} className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium hover:text-foreground transition-colors">
            Your Listing <Pencil className="size-3" />
          </button>
        ) : (
          <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${isDriver ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-amber-700'}`}>
            {isDriver ? 'Offering' : 'Needs ride'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <MapPin className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground truncate">{listing.from}</span>
        <ArrowRight className="size-3 text-muted-foreground shrink-0" />
        <span className="font-semibold text-foreground truncate">{listing.to}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {isDriver ? (
          <span className="flex items-center gap-1"><Users className="size-3" />{freeSeats} seat{freeSeats !== 1 ? 's' : ''} left</span>
        ) : (
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

      {!isOwn && (
        alreadyConnected ? (
          <div className="mt-1 w-full py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-medium flex items-center justify-center gap-1.5">
            <Check className="size-4" />{isDriver ? 'Request sent' : 'Offer sent'}
          </div>
        ) : (
          <button
            onClick={() => onConnect(listing)}
            className="mt-1 w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 active:scale-[0.98] transition-all"
          >
            {isDriver ? 'Request to join' : 'Offer a ride'}
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
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-5 py-3 rounded-full bg-foreground text-background text-sm font-semibold shadow-xl active:scale-95 transition-transform"
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
      className="fixed bottom-20 right-4 z-30 size-14 rounded-full bg-primary text-primary-foreground shadow-xl active:scale-95 transition-transform flex items-center justify-center"
    >
      <Plus className="size-6" />
    </button>
  )
}
