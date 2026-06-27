import { useState, useEffect, type CSSProperties } from "react"
import { MapPin, Calendar, Users, ArrowRight, Plus, ChevronRight } from "lucide-react"
import { motion } from "motion/react"
import * as api from "./api"
import type { ApiPool } from "./api"

const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }
const MONO: CSSProperties = { fontFamily: "'DM Mono', monospace" }

const COMMUNITY_TAGS = ["church", "college", "work", "event", "family", "sports"] as const
type CommunityTag = (typeof COMMUNITY_TAGS)[number]

const TAG_EMOJI: Record<string, string> = {
  church: "⛪", college: "🎓", work: "💼", event: "🎉", family: "👨‍👩‍👧", sports: "⚽",
}

const inputCls = "w-full px-3 py-2.5 rounded-xl bg-input-background border border-transparent text-sm focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors"
const iconInputCls = "pl-9 " + inputCls

interface Props {
  userCoords: { lat: number; lng: number } | null
  currentUserId: string
  showToast: (msg: string, type: "success" | "error") => void
}

type PoolTab = "browse" | "create"

export function PoolView({ userCoords, currentUserId, showToast }: Props) {
  const [tab, setTab] = useState<PoolTab>("browse")
  const [pools, setPools] = useState<ApiPool[]>([])
  const [loading, setLoading] = useState(false)
  const [filterTag, setFilterTag] = useState<CommunityTag | "">("")

  // ── Create form ─────────────────────────────────────────────────────────────
  const [name, setName] = useState("")
  const [communityTag, setCommunityTag] = useState<CommunityTag>("event")
  const [tripDate, setTripDate] = useState("")
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
        name, community_tag: communityTag, trip_date: tripDate,
        pickup_location_id: pickupLoc.id, destination_location_id: destLoc.id,
        max_participants: parseInt(maxParticipants, 10),
        description: description || undefined,
        seats_per_vehicle: parseInt(seatsPerVehicle, 10),
      })
      setPools(prev => [pool, ...prev])
      showToast("Pool created!", "success")
      setTab("browse")
      setName(""); setFrom(""); setTo(""); setTripDate(""); setDescription("")
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
      loadPools()
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to leave", "error")
    }
  }

  const isMember = (pool: ApiPool) => pool.members.some(m => m.user_id === currentUserId)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Community Pools</h1>
          <p className="text-muted-foreground mt-1">Organize group trips — church outings, college rides, work commutes.</p>
        </div>
        <button
          onClick={() => setTab(tab === "create" ? "browse" : "create")}
          className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          <Plus className="size-4" />{tab === "create" ? "Browse" : "Create"}
        </button>
      </div>

      {tab === "browse" && (
        <>
          {/* Tag filter */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setFilterTag("")} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterTag === "" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>All</button>
            {COMMUNITY_TAGS.map(tag => (
              <button key={tag} onClick={() => setFilterTag(tag)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${filterTag === tag ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
                {TAG_EMOJI[tag]} {tag.charAt(0).toUpperCase() + tag.slice(1)}
              </button>
            ))}
          </div>

          {loading && <p className="text-sm text-muted-foreground animate-pulse">Loading pools…</p>}

          {!loading && pools.length === 0 && (
            <div className="text-center py-24 text-muted-foreground">
              <p className="text-5xl mb-4">🚐</p>
              <p className="font-medium">No pools yet</p>
              <p className="text-sm mt-1">Create the first pool for your group.</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {pools.map(pool => {
              const member = isMember(pool)
              const spotsLeft = pool.max_participants - pool.member_count
              return (
                <motion.div
                  key={pool.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-card border border-border rounded-3xl p-5 space-y-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{TAG_EMOJI[pool.community_tag] ?? "🚗"}</span>
                        <h3 className="text-base font-semibold text-foreground">{pool.name}</h3>
                      </div>
                      {pool.description && <p className="text-sm text-muted-foreground mt-1">{pool.description}</p>}
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${pool.status === "full" ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
                      {pool.status === "full" ? "Full" : "Open"}
                    </span>
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-center gap-2">
                      <MapPin className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{pool.pickup.label}</span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                      <span className="font-medium">{pool.destination.label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground pl-5">
                      <span className="flex items-center gap-1"><Calendar className="size-3" />{pool.trip_date}</span>
                      <span className="flex items-center gap-1"><Users className="size-3" /><span style={MONO}>{pool.member_count}/{pool.max_participants}</span></span>
                      <span>{spotsLeft} spot{spotsLeft !== 1 ? "s" : ""} left</span>
                    </div>
                  </div>

                  {/* Organizer seats info */}
                  <div className="flex flex-wrap gap-1">
                    {Array.from({ length: pool.max_participants }, (_, i) => (
                      <div key={i} className={`size-2.5 rounded-full ${i < pool.member_count ? "bg-primary" : "bg-muted"}`} />
                    ))}
                  </div>

                  {member ? (
                    <div className="flex gap-2">
                      <span className="flex-1 text-center py-2 rounded-xl bg-green-100 text-green-800 text-sm font-medium">✓ Joined</span>
                      <button onClick={() => handleLeave(pool)} className="px-3 py-2 rounded-xl border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Leave</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleJoin(pool)}
                      disabled={pool.status === "full"}
                      className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-all flex items-center justify-center gap-1"
                    >
                      Join pool <ChevronRight className="size-4" />
                    </button>
                  )}
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
              <label className="text-sm font-medium">Pool name</label>
              <input required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Grace Church Sunday Trip" className={inputCls} />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Community type</label>
              <div className="flex flex-wrap gap-2">
                {COMMUNITY_TAGS.map(tag => (
                  <button key={tag} type="button" onClick={() => setCommunityTag(tag)} className={`px-3 py-2 rounded-xl text-sm font-medium transition-colors ${communityTag === tag ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
                    {TAG_EMOJI[tag]} {tag.charAt(0).toUpperCase() + tag.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">From</label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input required value={from} onChange={e => setFrom(e.target.value)} placeholder="Pickup area" className={iconInputCls} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">To</label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <input required value={to} onChange={e => setTo(e.target.value)} placeholder="Destination" className={iconInputCls} />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Trip date</label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <input required type="date" value={tripDate} onChange={e => setTripDate(e.target.value)} className={iconInputCls} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Max participants</label>
                <input type="number" min="2" max="50" value={maxParticipants} onChange={e => setMaxParticipants(e.target.value)} className={inputCls} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Seats per vehicle</label>
                <input type="number" min="1" max="15" value={seatsPerVehicle} onChange={e => setSeatsPerVehicle(e.target.value)} className={inputCls} />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description (optional)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Tell the group what this trip is about…" className={`${inputCls} resize-none`} />
            </div>

            <button type="submit" disabled={creating} className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">
              {creating ? "Creating…" : "Create pool"}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
