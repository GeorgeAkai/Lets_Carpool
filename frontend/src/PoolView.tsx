import { useState, useEffect, useRef, type CSSProperties } from "react"
import { MapPin, Calendar, Clock, Plus, ChevronRight, ArrowRight, MessageCircle, Send, MoreHorizontal, Flag, UserX } from "lucide-react"
import { motion } from "motion/react"
import * as api from "./api"
import type { ApiPool, ApiPoolMembership, ApiPoolMessage } from "./api"

const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }
const MONO: CSSProperties = { fontFamily: "'DM Mono', monospace" }

const COMMUNITY_TAGS = ["church", "college", "work", "event", "family", "sports"] as const
type CommunityTag = (typeof COMMUNITY_TAGS)[number]

const TAG_EMOJI: Record<string, string> = {
  church: "⛪", college: "🎓", work: "💼", event: "🎉", family: "👨‍👩‍👧", sports: "⚽",
}

// Category badge colors, from the Figma Make pool cards.
const TAG_BADGE: Record<string, string> = {
  church: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  college: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  work: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  event: "bg-red-500/15 text-red-700 dark:text-red-300",
  family: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  sports: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
}

const inputCls = "w-full px-4 py-3 rounded-xl bg-input-background border border-border text-sm focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15 transition-colors"
const iconInputCls = "pl-10 " + inputCls

function toInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?"
}

function formatTime(hhmmss: string): string {
  const [h, m] = hhmmss.split(":").map(Number)
  const period = h >= 12 ? "PM" : "AM"
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`
}

interface Props {
  userCoords: { lat: number; lng: number } | null
  currentUserId: string
  showToast: (msg: string, type: "success" | "error") => void
}

type PoolTab = "browse" | "create"

// ─── Roster ─────────────────────────────────────────────────────────────────────

function RosterMember({ member, isOrganizer, onReport, onBlock }: {
  member: ApiPoolMembership; isOrganizer: boolean
  onReport: (userId: string, reason: string) => void; onBlock: (userId: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [reportMode, setReportMode] = useState(false)
  const [reason, setReason] = useState("")

  return (
    <div className="flex items-center gap-2 group relative">
      {member.photo_url ? (
        <img src={member.photo_url} alt="" className="size-6 rounded-full object-cover ring-1 ring-border shrink-0" />
      ) : (
        <div style={MONO} className="size-6 rounded-full bg-secondary text-secondary-foreground text-[10px] font-semibold flex items-center justify-center shrink-0">
          {toInitials(member.display_name ?? "?")}
        </div>
      )}
      <span className="text-sm font-medium truncate">{member.display_name ?? "Member"}</span>
      {isOrganizer && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground tracking-wide">ORGANIZER</span>
      )}
      <button
        onClick={() => setMenuOpen(v => !v)}
        className="ml-auto opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-muted text-muted-foreground transition-opacity"
        aria-label={`More actions for ${member.display_name ?? "member"}`}
      >
        <MoreHorizontal className="size-3.5" />
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-7 z-20 w-48 bg-card border border-border rounded-xl shadow-lg p-2 space-y-1">
          {!reportMode ? (
            <>
              <button onClick={() => { onBlock(member.user_id); setMenuOpen(false) }} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-sm text-foreground hover:bg-muted transition-colors">
                <UserX className="size-3.5" />Block
              </button>
              <button onClick={() => setReportMode(true)} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-sm text-foreground hover:bg-muted transition-colors">
                <Flag className="size-3.5" />Report
              </button>
            </>
          ) : (
            <div className="space-y-1.5 p-1">
              <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason…" className="w-full px-2.5 py-1.5 rounded-lg bg-input-background border border-transparent text-xs focus:outline-none focus:ring-2 focus:ring-ring/20" />
              <div className="flex gap-1.5">
                <button onClick={() => { if (reason.trim()) { onReport(member.user_id, reason.trim()); setReportMode(false); setMenuOpen(false); setReason("") } }} className="flex-1 px-2 py-1.5 rounded-lg bg-destructive text-white text-xs font-medium">Submit</button>
                <button onClick={() => { setReportMode(false); setMenuOpen(false) }} className="px-2 py-1.5 rounded-lg border border-border text-xs text-muted-foreground">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Group chat ───────────────────────────────────────────────────────────────

function PoolChat({ pool, currentUserId, showToast }: {
  pool: ApiPool; currentUserId: string; showToast: (msg: string, type: "success" | "error") => void
}) {
  const [msgs, setMsgs] = useState<ApiPoolMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const memberByUserId = new Map(pool.members.map(m => [m.user_id, m]))

  useEffect(() => {
    let cancelled = false
    api.getPoolMessages(pool.id).then(fetched => {
      if (cancelled) return
      setMsgs(fetched); setLoaded(true)
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50)
    }).catch(() => setLoaded(true))
    return () => { cancelled = true }
  }, [pool.id])

  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      const msg = await api.sendPoolMessage(pool.id, text.trim())
      setMsgs(prev => [...prev, msg]); setText("")
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to send", "error")
    } finally { setSending(false) }
  }

  return (
    <div className="border-t border-border bg-muted/40 px-5 py-4 space-y-3">
      <div className="flex items-center gap-2">
        <MessageCircle className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Group chat</span>
        <span className="text-xs text-muted-foreground">· {pool.member_count} member{pool.member_count !== 1 ? "s" : ""}</span>
      </div>

      {msgs.length > 0 && (
        <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
          {msgs.map(m => {
            const isMine = m.sender_id === currentUserId
            const sender = memberByUserId.get(m.sender_id)
            const name = isMine ? "You" : (sender?.display_name ?? "Member")
            return (
              <div key={m.id} className={`flex items-end gap-2 ${isMine ? "flex-row-reverse" : "flex-row"}`}>
                {!isMine && (
                  sender?.photo_url
                    ? <img src={sender.photo_url} alt="" className="size-6 rounded-full object-cover shrink-0" />
                    : <div style={MONO} className="size-6 rounded-full bg-secondary text-secondary-foreground text-[10px] font-semibold flex items-center justify-center shrink-0">{toInitials(name)}</div>
                )}
                <div className={`max-w-[75%] space-y-0.5 flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                  {!isMine && <span className="text-[10px] text-muted-foreground pl-1">{name}</span>}
                  <div className={`px-3 py-2 rounded-2xl text-sm leading-snug ${isMine ? "bg-primary text-primary-foreground rounded-br-[4px]" : "bg-card text-foreground border border-border rounded-bl-[4px]"}`}>
                    {m.content}
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}

      {msgs.length === 0 && loaded && (
        <p className="text-xs text-muted-foreground text-center py-4">No messages yet. Say hi to the group!</p>
      )}

      <div className="flex gap-2">
        <input
          type="text" value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Message the group…"
          className="flex-1 px-4 py-2.5 rounded-xl bg-card border border-border text-sm focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15 transition-colors"
        />
        <button onClick={send} disabled={sending || !text.trim()} aria-label="Send" className="size-10 shrink-0 rounded-xl bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 transition-colors">
          <Send className="size-4" />
        </button>
      </div>
    </div>
  )
}

export function PoolView({ userCoords, currentUserId, showToast }: Props) {
  const [tab, setTab] = useState<PoolTab>("browse")
  const [pools, setPools] = useState<ApiPool[]>([])
  const [loading, setLoading] = useState(false)
  const [filterTag, setFilterTag] = useState<CommunityTag | "">("")
  const [openChatPoolId, setOpenChatPoolId] = useState<string | null>(null)

  // ── Create form ─────────────────────────────────────────────────────────────
  const [name, setName] = useState("")
  const [communityTag, setCommunityTag] = useState<CommunityTag>("event")
  const [tripDate, setTripDate] = useState("")
  const [departureTime, setDepartureTime] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [maxParticipants, setMaxParticipants] = useState("10")
  const [seatsPerVehicle, setSeatsPerVehicle] = useState("4")
  const [description, setDescription] = useState("")
  const [creating, setCreating] = useState(false)

  const loadPools = async () => {
    setLoading(true)
    try {
      const data = await api.listPools(filterTag || undefined)
      setPools(data)
    } catch { /* ignore */ } finally { setLoading(false) }
  }

  useEffect(() => { loadPools() }, [filterTag]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    try {
      const lat = userCoords?.lat ?? 0
      const lng = userCoords?.lng ?? 0
      const [pickupLoc, destLoc] = await Promise.all([
        api.createLocation(from, lat, lng),
        api.createLocation(to, lat, lng),
      ])
      const pool = await api.createPool({
        name, community_tag: communityTag, trip_date: tripDate, departure_time: departureTime,
        pickup_location_id: pickupLoc.id, destination_location_id: destLoc.id,
        max_participants: parseInt(maxParticipants, 10),
        description: description || undefined,
        seats_per_vehicle: parseInt(seatsPerVehicle, 10),
      })
      setPools(prev => [pool, ...prev])
      showToast("Pool created!", "success")
      setTab("browse")
      setName(""); setFrom(""); setTo(""); setTripDate(""); setDepartureTime(""); setDescription("")
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create pool", "error")
    } finally { setCreating(false) }
  }

  const handleJoin = async (pool: ApiPool) => {
    try {
      await api.joinPool(pool.id)
      showToast("Joined pool!", "success")
      loadPools()
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to join", "error")
    }
  }

  const handleLeave = async (pool: ApiPool) => {
    try {
      await api.leavePool(pool.id)
      showToast("Left pool", "success")
      if (openChatPoolId === pool.id) setOpenChatPoolId(null)
      loadPools()
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to leave", "error")
    }
  }

  const handleReport = async (targetUserId: string, reason: string) => {
    try { await api.reportUser(targetUserId, reason); showToast("Report submitted", "success") }
    catch (err) { showToast(err instanceof Error ? err.message : "Failed to report", "error") }
  }

  const handleBlock = async (targetUserId: string) => {
    try { await api.blockUser(targetUserId); showToast("User blocked", "success"); loadPools() }
    catch (err) { showToast(err instanceof Error ? err.message : "Failed to block", "error") }
  }

  const isMember = (pool: ApiPool) => pool.members.some(m => m.user_id === currentUserId)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Community Pools</h1>
          <p className="text-sm text-muted-foreground mt-1">Organize group trips — church outings, college rides, work commutes.</p>
        </div>
        <button
          onClick={() => setTab(tab === "create" ? "browse" : "create")}
          className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          <Plus className="size-4" />{tab === "create" ? "Browse" : "Create Pool"}
        </button>
      </div>

      {tab === "browse" && (
        <>
          {/* Tag filter */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setFilterTag("")} className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${filterTag === "" ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:text-foreground"}`}>All</button>
            {COMMUNITY_TAGS.map(tag => (
              <button key={tag} onClick={() => setFilterTag(tag)} className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${filterTag === tag ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:text-foreground"}`}>
                {TAG_EMOJI[tag]} {tag.charAt(0).toUpperCase() + tag.slice(1)}
              </button>
            ))}
          </div>

          {loading && <p className="text-sm text-muted-foreground animate-pulse">Loading pools…</p>}

          {!loading && pools.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-5xl mb-4">👥</p>
              <p className="font-bold text-base text-foreground mb-1">No pools yet</p>
              <p className="text-sm text-muted-foreground mb-5">Create the first pool for your group.</p>
              <button onClick={() => setTab("create")} className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Create Pool</button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {pools.map(pool => {
              const member = isMember(pool)
              const spotsLeft = pool.max_participants - pool.member_count
              const organizer = pool.members.find(m => m.role === "organizer") ?? pool.members.find(m => m.user_id === pool.organizer_id)
              const otherMembers = pool.members.filter(m => m.user_id !== organizer?.user_id)
              const chatOpen = openChatPoolId === pool.id
              return (
                <motion.div
                  key={pool.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-card border border-border rounded-2xl overflow-hidden hover:shadow-lg hover:shadow-foreground/10 transition-shadow"
                >
                  <div className="p-5 space-y-3">
                    <div className="flex items-start gap-3">
                      <span className="text-3xl leading-none">{TAG_EMOJI[pool.community_tag] ?? "🚗"}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-bold text-foreground">{pool.name}</h3>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${TAG_BADGE[pool.community_tag] ?? "bg-muted text-muted-foreground"}`}>{pool.community_tag}</span>
                        </div>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                          <Calendar className="size-3" />{pool.trip_date}
                          {pool.departure_time && <><Clock className="size-3 ml-1" />{formatTime(pool.departure_time)}</>}
                        </p>
                      </div>
                      {member ? (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">✓ Joined</span>
                      ) : pool.status === "full" ? (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-300">Full</span>
                      ) : null}
                    </div>

                    {pool.description && <p className="text-sm text-muted-foreground">{pool.description}</p>}

                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MapPin className="size-3 shrink-0" />
                      <span>{pool.pickup.label}</span>
                      <ArrowRight className="size-3 shrink-0" />
                      <span className="font-medium text-foreground">{pool.destination.label}</span>
                    </div>

                    <div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                        <span><span style={MONO} className="text-foreground font-medium">{pool.member_count}/{pool.max_participants}</span> members</span>
                        <span>{spotsLeft} spot{spotsLeft !== 1 ? "s" : ""} left</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, (pool.member_count / Math.max(1, pool.max_participants)) * 100)}%` }} />
                      </div>
                    </div>

                    {/* Named roster */}
                    {pool.members.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Riding</span>
                        <div className="flex flex-col gap-1.5">
                          {organizer && (
                            <RosterMember key={organizer.user_id} member={organizer} isOrganizer onReport={handleReport} onBlock={handleBlock} />
                          )}
                          {otherMembers.map(m => (
                            <RosterMember key={m.user_id} member={m} isOrganizer={false} onReport={handleReport} onBlock={handleBlock} />
                          ))}
                        </div>
                      </div>
                    )}

                    {member ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setOpenChatPoolId(chatOpen ? null : pool.id)}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold transition-colors ${chatOpen ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
                        >
                          {chatOpen ? <>Close chat</> : <><MessageCircle className="size-4" />Open group chat</>}
                        </button>
                        <button onClick={() => handleLeave(pool)} className="px-4 py-2.5 rounded-xl bg-input-background border border-border text-sm font-semibold text-muted-foreground hover:text-destructive transition-colors">Leave</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleJoin(pool)}
                        disabled={pool.status === "full"}
                        className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-all flex items-center justify-center gap-1"
                      >
                        Join pool <ChevronRight className="size-4" />
                      </button>
                    )}
                  </div>

                  {member && chatOpen && <PoolChat pool={pool} currentUserId={currentUserId} showToast={showToast} />}
                </motion.div>
              )
            })}
          </div>
        </>
      )}

      {tab === "create" && (
        <div className="max-w-lg">
          <form onSubmit={handleCreate} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Pool name</label>
              <input required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Grace Church Sunday Trip" className={inputCls} />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Community type</label>
              <div className="flex flex-wrap gap-2">
                {COMMUNITY_TAGS.map(tag => (
                  <button key={tag} type="button" onClick={() => setCommunityTag(tag)} className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${communityTag === tag ? "bg-primary text-primary-foreground border-primary" : "bg-input-background text-muted-foreground border-border hover:text-foreground"}`}>
                    {TAG_EMOJI[tag]} {tag.charAt(0).toUpperCase() + tag.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">From</label>
                <div className="relative">
                  <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input required value={from} onChange={e => setFrom(e.target.value)} placeholder="Pickup area" className={iconInputCls} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">To</label>
                <div className="relative">
                  <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input required value={to} onChange={e => setTo(e.target.value)} placeholder="Destination" className={iconInputCls} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">Trip date</label>
                <div className="relative">
                  <Calendar className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input required type="date" value={tripDate} onChange={e => setTripDate(e.target.value)} className={iconInputCls} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">Departure time</label>
                <div className="relative">
                  <Clock className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input required type="time" value={departureTime} onChange={e => setDepartureTime(e.target.value)} className={iconInputCls} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">Max participants</label>
                <input type="number" min="2" max="50" value={maxParticipants} onChange={e => setMaxParticipants(e.target.value)} className={inputCls} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">Seats per vehicle</label>
                <input type="number" min="1" max="15" value={seatsPerVehicle} onChange={e => setSeatsPerVehicle(e.target.value)} className={inputCls} />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-semibold">Description (optional)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Tell the group what this trip is about…" className={`${inputCls} resize-none`} />
            </div>

            <button type="submit" disabled={creating} className="w-full py-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold shadow-lg shadow-primary/30 hover:bg-primary/90 disabled:opacity-60 disabled:shadow-none transition-all">
              {creating ? "Creating…" : "Create pool"}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
