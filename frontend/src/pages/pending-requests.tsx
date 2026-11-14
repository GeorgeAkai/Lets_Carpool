import { useMemo, useState } from 'react'
import { Calendar, Check, ChevronLeft, Inbox, MapPin, MessageCircle, Users, X } from 'lucide-react'
import { Avatar, SERIF } from './home'
import type { Connection, MyListing } from './home'

// Driver-side page listing every passenger who has asked for a seat, grouped
// by the trip they asked for. Only requests the passenger started count: a
// pending connection the driver started is an outgoing offer, not a request.
export function isPendingRequestFor(c: Connection, currentUserId: string): boolean {
  return c.myRole === 'driver' && c.status === 'pending' && c.initiatorUserId !== currentUserId
}

export function PendingRequestsView({
  connections, trips, currentUserId, tripId, onSelectTrip, onAccept, onDecline, onOpenChat, reload, showToast,
}: {
  connections: Connection[]
  trips: MyListing[]               // the driver's own trips, for the group headers
  currentUserId: string
  tripId: string | null            // null = every trip
  onSelectTrip: (id: string | null) => void
  onAccept: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
  onOpenChat: (c: Connection) => void
  reload: () => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const pending = useMemo(
    () => connections.filter(c => isPendingRequestFor(c, currentUserId)),
    [connections, currentUserId],
  )
  const groups = useMemo(() => {
    const byTrip = new Map<string, Connection[]>()
    for (const c of pending) byTrip.set(c.driverTripId, [...(byTrip.get(c.driverTripId) ?? []), c])
    return [...byTrip.entries()]
      .map(([id, requests]) => ({ id, requests, trip: trips.find(t => t.id === id) ?? null, date: requests[0].date }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [pending, trips])
  const shown = tripId ? groups.filter(g => g.id === tripId) : groups

  const run = async (c: Connection, action: 'accept' | 'decline') => {
    setBusyId(c.id)
    try {
      await (action === 'accept' ? onAccept(c.id) : onDecline(c.id))
      // Re-fetch so the list (and seats left) reflect the answer.
      await reload()
      showToast(action === 'accept' ? 'Request accepted' : 'Request declined', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Something went wrong', 'error')
    } finally { setBusyId(null) }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 style={SERIF} className="text-[2.25rem] xl:text-[2.75rem] leading-tight text-foreground">Pending requests</h1>
        <p className="text-muted-foreground mt-1">Passengers waiting for you to accept or decline their seat.</p>
      </div>

      {tripId && (
        <button type="button" onClick={() => onSelectTrip(null)}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
          <ChevronLeft className="size-4" />All trips
        </button>
      )}

      {shown.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground rounded-3xl border border-dashed border-border">
          <Inbox className="size-10 mx-auto mb-4 opacity-20" />
          <p className="font-medium">No pending requests</p>
          <p className="text-sm mt-1">When a passenger asks for a seat on one of your trips, they’ll show up here.</p>
        </div>
      ) : shown.map(g => {
        const seatsLeft = g.trip?.seats != null ? g.trip.seats - (g.trip.seatsReserved ?? 0) : null
        return (
          <section key={g.id} className="space-y-2.5" aria-label={`Requests for ${g.trip?.to ?? g.requests[0].to}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-[15px] font-semibold truncate">
                {(g.trip?.from ?? g.requests[0].from)} ➔ {(g.trip?.to ?? g.requests[0].to)}
              </h2>
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="size-3" />{g.date}</span>
              {seatsLeft != null && (
                <span className="text-xs text-muted-foreground flex items-center gap-1"><Users className="size-3" />{seatsLeft} seat{seatsLeft === 1 ? '' : 's'} free</span>
              )}
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400">
                {g.requests.length} pending
              </span>
              {!tripId && groups.length > 1 && (
                <button type="button" onClick={() => onSelectTrip(g.id)} className="ml-auto text-xs font-medium text-primary hover:underline">Only this trip</button>
              )}
            </div>

            {g.requests.map(c => {
              const seats = c.raw?.ride_request.passenger_count ?? 1
              const full = seatsLeft != null && seats > seatsLeft
              return (
                <div key={c.id} className="bg-card border border-border rounded-2xl p-3.5 flex items-center gap-3">
                  <Avatar initials={c.withUser.initials} photoUrl={c.withUser.photoUrl} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">
                      {c.withUser.name}
                      <span className="font-normal text-muted-foreground"> · {seats} seat{seats === 1 ? '' : 's'}</span>
                    </p>
                    <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                      <MapPin className="size-3 shrink-0" />{c.riderPickupLabel ?? c.from}
                    </p>
                    {full && <p className="text-xs text-destructive mt-0.5">Needs more seats than are free</p>}
                  </div>
                  <button onClick={() => onOpenChat(c)} aria-label={`Message ${c.withUser.name}`}
                    className="p-2 rounded-xl border border-border text-muted-foreground hover:bg-muted">
                    <MessageCircle className="size-4" />
                  </button>
                  <button onClick={() => run(c, 'decline')} disabled={busyId === c.id} aria-label={`Decline ${c.withUser.name}`}
                    className="p-2 rounded-xl border border-border text-muted-foreground hover:bg-muted disabled:opacity-50">
                    <X className="size-4" />
                  </button>
                  <button onClick={() => run(c, 'accept')} disabled={busyId === c.id || full} aria-label={`Accept ${c.withUser.name}`}
                    className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5">
                    <Check className="size-4" />Accept
                  </button>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
