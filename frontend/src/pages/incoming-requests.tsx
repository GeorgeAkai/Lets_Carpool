import { useState } from 'react'
import { Car, Check, MapPin, MessageCircle, X } from 'lucide-react'
import { Avatar } from './home'
import type { Connection } from './home'

// One-tap handling of ride requests from anywhere in the app: whoever receives
// a pending connection (the driver for a rider's request, or the rider for a
// driver's offer) sees it here with the pickup and Accept / Decline, instead
// of having to open the inbox thread first. After accepting, the card offers
// the next action (navigate to the pickup, or open the chat).
export function IncomingRequests({
  connections, currentUserId, onAccept, onDecline, onStartDriving, onOpenChat, reload, showToast,
}: {
  connections: Connection[]
  currentUserId: string
  onAccept: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
  onStartDriving: (conn: Connection) => void
  onOpenChat: (conn: Connection) => void
  reload: () => Promise<void>
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [justAccepted, setJustAccepted] = useState<string[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])

  const incoming = connections.filter(c => c.status === 'pending' && c.initiatorUserId !== currentUserId)
  const accepted = connections.filter(c => justAccepted.includes(c.id) && c.status === 'accepted' && !dismissed.includes(c.id))
  if (incoming.length === 0 && accepted.length === 0) return null

  const run = async (c: Connection, action: 'accept' | 'decline') => {
    setBusyId(c.id)
    try {
      await (action === 'accept' ? onAccept(c.id) : onDecline(c.id))
      if (action === 'accept') {
        setJustAccepted(prev => [...prev, c.id])
        // Re-fetch so the accepted record carries the revealed pickup details.
        await reload()
      }
      showToast(action === 'accept' ? 'Request accepted' : 'Request declined', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Something went wrong', 'error')
    } finally { setBusyId(null) }
  }

  return (
    <div className="sticky top-2 z-40 mb-3 space-y-2" aria-live="polite">
      {incoming.map(c => {
        const pickup = c.myRole === 'driver' ? c.riderPickupLabel : c.pickupLabel
        return (
          <div key={c.id} className="rounded-2xl border border-primary/30 bg-card shadow-lg p-3 flex items-center gap-3">
            <Avatar initials={c.withUser.initials} photoUrl={c.withUser.photoUrl} size="md" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">
                {c.withUser.name} {c.myRole === 'driver' ? 'wants a ride' : 'offered you a ride'}
              </p>
              <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                <MapPin className="size-3 shrink-0" />{pickup ?? c.from} · {c.date}
              </p>
            </div>
            <button onClick={() => run(c, 'decline')} disabled={busyId === c.id} aria-label={`Decline ${c.withUser.name}`}
              className="p-2 rounded-xl border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"><X className="size-4" /></button>
            <button onClick={() => run(c, 'accept')} disabled={busyId === c.id}
              className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5">
              <Check className="size-4" />Accept
            </button>
          </div>
        )
      })}
      {accepted.map(c => {
        const canNavigate = c.myRole === 'driver' && !!c.riderPickupLat && !!c.riderPickupLng
        return (
          <div key={c.id} className="rounded-2xl border border-green-500/40 bg-card shadow-lg p-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">Accepted · {c.withUser.name}</p>
              <p className="text-xs text-muted-foreground truncate">Pickup: {c.riderPickupLabel ?? c.from}</p>
            </div>
            {canNavigate && (
              <button onClick={() => { onStartDriving(c); setDismissed(p => [...p, c.id]) }}
                className="px-3 py-2 rounded-xl bg-green-600 text-white text-sm font-semibold hover:bg-green-700 flex items-center gap-1.5">
                <Car className="size-4" />Go to pickup
              </button>
            )}
            <button onClick={() => { onOpenChat(c); setDismissed(p => [...p, c.id]) }} aria-label="Open chat"
              className="p-2 rounded-xl border border-border hover:bg-muted"><MessageCircle className="size-4" /></button>
            <button onClick={() => setDismissed(p => [...p, c.id])} aria-label="Dismiss"
              className="p-2 rounded-xl text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
          </div>
        )
      })}
    </div>
  )
}
