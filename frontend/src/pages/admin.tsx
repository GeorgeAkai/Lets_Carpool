import { useState, useEffect, useCallback } from 'react'
import {
  Users, Car, ShieldCheck, ShieldAlert, ScrollText, Flag, Ban, CheckCircle2,
  Trash2, MessageSquareWarning, RefreshCw, Route, Trophy,
} from 'lucide-react'
import * as api from '../api'
import type {
  ApiAdminStats, ApiAdminUser, ApiAdminReport, ApiPopularDestination,
  ApiActiveDriverTrip, ApiActiveRideRequest, ApiAuditLogEntry,
} from '../api'
import { SERIF, Avatar, toInitials, relativeTime } from './home'

type AdminTab = 'overview' | 'users' | 'routes' | 'logs'
type Toast = (msg: string, type: 'success' | 'error') => void

const TABS: Array<{ id: AdminTab; label: string; icon: typeof Users }> = [
  { id: 'overview', label: 'Overview', icon: ShieldCheck },
  { id: 'users', label: 'Users & Moderation', icon: Users },
  { id: 'routes', label: 'Rides & Routes', icon: Route },
  { id: 'logs', label: 'System Logs', icon: ScrollText },
]

const EVENT_TYPES = ['USER_REGISTERED', 'RIDE_PUBLISHED', 'USER_BLOCKED', 'USER_UNBLOCKED', 'WARNING_SENT', 'REPORT_DISMISSED', 'REPORT_ACTIONED', 'LISTING_REMOVED', 'LOGIN_FAILED']

function StatusBadge({ status }: { status: 'active' | 'suspended' }) {
  return status === 'suspended' ? (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-500">Suspended</span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-500/10 text-green-600">Active</span>
  )
}

function RoleBadge({ isDriver, isRider }: { isDriver: boolean; isRider: boolean }) {
  const label = isDriver && isRider ? 'Driver + Rider' : isDriver ? 'Driver' : isRider ? 'Rider' : 'New'
  return <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground">{label}</span>
}

function StatTile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-3xl bg-card border border-border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p style={SERIF} className="mt-1 text-3xl text-foreground">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function AdminView({ showToast }: { showToast: Toast }) {
  const [tab, setTab] = useState<AdminTab>('overview')

  return (
    <div className="space-y-6">
      <div>
        <h1 style={SERIF} className="text-[2.75rem] leading-tight text-foreground">Admin Panel</h1>
        <p className="text-muted-foreground mt-1">Platform analytics, moderation, and audit trail.</p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id} onClick={() => setTab(id)}
            className={`shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold transition-colors ${tab === id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            <Icon className="size-4" />{label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab showToast={showToast} />}
      {tab === 'users' && <UsersTab showToast={showToast} />}
      {tab === 'routes' && <RoutesTab showToast={showToast} />}
      {tab === 'logs' && <LogsTab showToast={showToast} />}
    </div>
  )
}

// ─── Overview ───────────────────────────────────────────────────────────────

function OverviewTab({ showToast }: { showToast: Toast }) {
  const [stats, setStats] = useState<ApiAdminStats | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.getAdminStats().then(setStats).catch(e => showToast(e instanceof Error ? e.message : 'Failed to load stats', 'error')).finally(() => setLoading(false))
  }, [showToast])

  useEffect(() => { load() }, [load])

  if (loading && !stats) return <div className="py-24 text-center text-muted-foreground text-sm">Loading analytics…</div>
  if (!stats) return null

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Total Users" value={stats.total_users} sub={`${stats.total_drivers} drivers · ${stats.total_riders} riders`} />
        <StatTile label="Active Drivers" value={stats.active_drivers} sub="Published, open routes" />
        <StatTile label="Active Riders" value={stats.active_riders} sub="Open ride requests" />
        <StatTile label="Completed Rides" value={stats.completed_rides} sub="All-time" />
        <StatTile label="New Signups" value={stats.new_users_7d} sub="Last 7 days" />
        <StatTile label="Suspended Users" value={stats.suspended_users} sub="Locked out of the platform" />
        <StatTile label="Open Reports" value={stats.open_reports} sub="Awaiting moderation" />
      </div>
      <button onClick={load} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
        <RefreshCw className="size-3.5" />Refresh
      </button>
    </div>
  )
}

// ─── Users & Moderation ───────────────────────────────────────────────────────

function UsersTab({ showToast }: { showToast: Toast }) {
  const [section, setSection] = useState<'directory' | 'reports'>('directory')
  return (
    <div className="space-y-4">
      <div className="flex rounded-xl bg-muted p-1 gap-1 w-fit" role="group">
        {(['directory', 'reports'] as const).map(s => (
          <button key={s} onClick={() => setSection(s)} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${section === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {s === 'directory' ? 'User Directory' : 'Reports Queue'}
          </button>
        ))}
      </div>
      {section === 'directory' ? <UserDirectory showToast={showToast} /> : <ReportsQueue showToast={showToast} />}
    </div>
  )
}

const PAGE_SIZE = 20

function UserDirectory({ showToast }: { showToast: Toast }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'suspended'>('')
  const [users, setUsers] = useState<ApiAdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.getAdminUsers({ search: search || undefined, status: statusFilter || undefined, limit: PAGE_SIZE, offset })
      .then(res => { setUsers(res.users); setTotal(res.total) })
      .catch(e => showToast(e instanceof Error ? e.message : 'Failed to load users', 'error'))
      .finally(() => setLoading(false))
  }, [search, statusFilter, offset, showToast])

  useEffect(() => { load() }, [load])

  const toggleSuspend = async (u: ApiAdminUser) => {
    try {
      if (u.status === 'suspended') {
        await api.unsuspendUser(u.id)
        showToast(`${u.display_name || u.email} unblocked`, 'success')
      } else {
        const reason = window.prompt(`Reason for blocking ${u.display_name || u.email}? (optional)`) ?? undefined
        await api.suspendUser(u.id, reason)
        showToast(`${u.display_name || u.email} blocked`, 'success')
      }
      load()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Action failed', 'error') }
  }

  const warn = async (u: ApiAdminUser) => {
    const message = window.prompt(`Warning message to send to ${u.display_name || u.email}:`)
    if (!message) return
    try { await api.warnUser(u.id, message); showToast('Warning sent', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed to send warning', 'error') }
  }

  return (
    <div className="rounded-3xl bg-card border border-border overflow-hidden">
      <div className="p-4 flex flex-wrap gap-2 border-b border-border">
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setOffset(0); load() } }}
          placeholder="Search name or email…"
          className="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-input-background text-sm focus:outline-none focus:ring-2 focus:ring-ring/20"
        />
        <div className="flex rounded-xl bg-muted p-1 gap-1">
          {([['', 'All'], ['active', 'Active'], ['suspended', 'Suspended']] as const).map(([val, label]) => (
            <button key={val} onClick={() => { setStatusFilter(val); setOffset(0) }} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${statusFilter === val ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Registered</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Reports</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map(u => (
              <tr key={u.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar initials={toInitials(u.display_name || u.email)} size="sm" photoUrl={u.photo_url} />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground truncate">{u.display_name || '—'}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3"><RoleBadge isDriver={u.is_driver} isRider={u.is_rider} /></td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                <td className="px-4 py-3">
                  {u.open_report_count > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600"><Flag className="size-3" />{u.open_report_count}</span>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => warn(u)} title="Send warning" className="p-1.5 rounded-lg text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 transition-colors"><MessageSquareWarning className="size-4" /></button>
                    <button
                      onClick={() => toggleSuspend(u)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${u.status === 'suspended' ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20' : 'bg-red-500/10 text-red-500 hover:bg-red-500/20'}`}
                    >
                      {u.status === 'suspended' ? <><CheckCircle2 className="size-3.5" />Unblock</> : <><Ban className="size-3.5" />Block</>}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No users match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 flex items-center justify-between border-t border-border text-sm text-muted-foreground">
        <span>{total === 0 ? '0 users' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}</span>
        <div className="flex gap-2">
          <button disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))} className="px-3 py-1.5 rounded-xl border border-border disabled:opacity-40 hover:bg-muted transition-colors">Previous</button>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(o => o + PAGE_SIZE)} className="px-3 py-1.5 rounded-xl border border-border disabled:opacity-40 hover:bg-muted transition-colors">Next</button>
        </div>
      </div>
    </div>
  )
}

function ReportsQueue({ showToast }: { showToast: Toast }) {
  const [reports, setReports] = useState<ApiAdminReport[]>([])
  const [statusFilter, setStatusFilter] = useState<'' | 'open' | 'dismissed' | 'actioned'>('open')
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.getAdminReports(statusFilter || undefined)
      .then(setReports)
      .catch(e => showToast(e instanceof Error ? e.message : 'Failed to load reports', 'error'))
      .finally(() => setLoading(false))
  }, [statusFilter, showToast])

  useEffect(() => { load() }, [load])

  const dismiss = async (id: string) => {
    try { await api.dismissReport(id); showToast('Report dismissed', 'success'); load() }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') }
  }
  const block = async (r: ApiAdminReport) => {
    if (!window.confirm(`Block ${r.reported_name || r.reported_email}? This suspends their account.`)) return
    try { await api.blockFromReport(r.id); showToast('User blocked', 'success'); load() }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') }
  }
  const warn = async (r: ApiAdminReport) => {
    const message = window.prompt(`Warning message to send to ${r.reported_name || r.reported_email}:`)
    if (!message) return
    try { await api.warnUser(r.reported_user_id, message); showToast('Warning sent', 'success') }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') }
  }

  return (
    <div className="rounded-3xl bg-card border border-border overflow-hidden">
      <div className="p-4 flex items-center gap-2 border-b border-border">
        <div className="flex rounded-xl bg-muted p-1 gap-1">
          {(['open', 'dismissed', 'actioned', ''] as const).map(s => (
            <button key={s || 'all'} onClick={() => setStatusFilter(s)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${statusFilter === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>
      <div className="divide-y divide-border">
        {reports.map(r => (
          <div key={r.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">
                <span className="font-semibold text-foreground">{r.reported_name || r.reported_email}</span>
                <span className="text-muted-foreground"> reported by </span>
                <span className="font-medium text-foreground">{r.reporter_name || r.reporter_email}</span>
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">{r.reason}</p>
              <p className="text-xs text-muted-foreground mt-1">{relativeTime(r.created_at)} · <StatusBadge status={r.reported_status} /></p>
            </div>
            {r.status === 'open' ? (
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => warn(r)} className="p-1.5 rounded-lg text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 transition-colors" title="Send warning"><MessageSquareWarning className="size-4" /></button>
                <button onClick={() => dismiss(r.id)} className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-muted text-muted-foreground hover:text-foreground transition-colors">Dismiss</button>
                <button onClick={() => block(r)} className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors">Block user</button>
              </div>
            ) : (
              <span className="text-xs font-medium text-muted-foreground capitalize shrink-0">{r.status}</span>
            )}
          </div>
        ))}
        {!loading && reports.length === 0 && (
          <p className="p-10 text-center text-muted-foreground text-sm">No reports in this queue.</p>
        )}
      </div>
    </div>
  )
}

// ─── Rides & Routes ───────────────────────────────────────────────────────────

function RoutesTab({ showToast }: { showToast: Toast }) {
  const [destinations, setDestinations] = useState<ApiPopularDestination[]>([])
  const [driverTrips, setDriverTrips] = useState<ApiActiveDriverTrip[]>([])
  const [rideRequests, setRideRequests] = useState<ApiActiveRideRequest[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([api.getPopularDestinations(10), api.getActiveRoutes()])
      .then(([dest, routes]) => { setDestinations(dest); setDriverTrips(routes.driver_trips); setRideRequests(routes.ride_requests) })
      .catch(e => showToast(e instanceof Error ? e.message : 'Failed to load routes', 'error'))
      .finally(() => setLoading(false))
  }, [showToast])

  useEffect(() => { load() }, [load])

  const removeRideRequest = async (id: string) => {
    if (!window.confirm('Remove this ride request?')) return
    try { await api.adminRemoveRideRequest(id); showToast('Listing removed', 'success'); load() }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') }
  }
  const removeDriverTrip = async (id: string) => {
    if (!window.confirm('Remove this driver trip?')) return
    try { await api.adminRemoveDriverTrip(id); showToast('Listing removed', 'success'); load() }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') }
  }

  const maxCount = Math.max(1, ...destinations.map(d => d.trip_count))

  if (loading && destinations.length === 0 && driverTrips.length === 0 && rideRequests.length === 0) {
    return <div className="py-24 text-center text-muted-foreground text-sm">Loading routes…</div>
  }

  return (
    <div className="space-y-6">
      <div className="rounded-3xl bg-card border border-border p-6">
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2"><Trophy className="size-4 text-primary" />Popular Destinations</h3>
        <div className="mt-4 space-y-2.5">
          {destinations.map(d => (
            <div key={d.label} className="flex items-center gap-3">
              <span className="text-sm text-foreground w-40 truncate shrink-0">{d.label}</span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(d.trip_count / maxCount) * 100}%` }} />
              </div>
              <span className="text-xs text-muted-foreground w-8 text-right shrink-0">{d.trip_count}</span>
            </div>
          ))}
          {destinations.length === 0 && <p className="text-sm text-muted-foreground">No destination activity yet.</p>}
        </div>
      </div>

      <div className="rounded-3xl bg-card border border-border overflow-hidden">
        <h3 className="p-6 pb-0 text-base font-semibold text-foreground flex items-center gap-2"><Car className="size-4 text-primary" />Active Driver Trips</h3>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {driverTrips.map(t => (
                <tr key={t.id}>
                  <td className="px-6 py-3">
                    <p className="font-medium text-foreground">{t.driver_name || 'Driver'}</p>
                    <p className="text-xs text-muted-foreground">{t.pickup_label} → {t.destination_label}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs">{t.target_date} · {t.seats_reserved}/{t.seats_available} seats</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => removeDriverTrip(t.id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"><Trash2 className="size-3.5" />Remove</button>
                  </td>
                </tr>
              ))}
              {driverTrips.length === 0 && <tr><td className="px-6 py-8 text-center text-muted-foreground text-sm">No active driver trips.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-3xl bg-card border border-border overflow-hidden">
        <h3 className="p-6 pb-0 text-base font-semibold text-foreground flex items-center gap-2"><Users className="size-4 text-primary" />Active Ride Requests</h3>
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {rideRequests.map(r => (
                <tr key={r.id}>
                  <td className="px-6 py-3">
                    <p className="font-medium text-foreground">{r.rider_name || 'Rider'}</p>
                    <p className="text-xs text-muted-foreground">{r.pickup_label} → {r.destination_label}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs">{r.target_date} · {r.passenger_count} pax</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => removeRideRequest(r.id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"><Trash2 className="size-3.5" />Remove</button>
                  </td>
                </tr>
              ))}
              {rideRequests.length === 0 && <tr><td className="px-6 py-8 text-center text-muted-foreground text-sm">No active ride requests.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── System Logs ────────────────────────────────────────────────────────────

function LogsTab({ showToast }: { showToast: Toast }) {
  const [logs, setLogs] = useState<ApiAuditLogEntry[]>([])
  const [eventType, setEventType] = useState('')
  const [actorEmail, setActorEmail] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.getAuditLogs({
      event_type: eventType || undefined,
      actor_email: actorEmail || undefined,
      date_from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
      date_to: dateTo ? new Date(dateTo).toISOString() : undefined,
    }).then(setLogs).catch(e => showToast(e instanceof Error ? e.message : 'Failed to load logs', 'error')).finally(() => setLoading(false))
  }, [eventType, actorEmail, dateFrom, dateTo, showToast])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps -- only auto-load once; Filter button re-runs with current inputs

  return (
    <div className="rounded-3xl bg-card border border-border overflow-hidden">
      <div className="p-4 flex flex-wrap gap-2 border-b border-border items-center">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-muted-foreground shrink-0" />
          <select value={eventType} onChange={e => setEventType(e.target.value)} className="px-3 py-2 rounded-xl bg-input-background text-sm focus:outline-none focus:ring-2 focus:ring-ring/20">
            <option value="">All event types</option>
            {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <input value={actorEmail} onChange={e => setActorEmail(e.target.value)} placeholder="Filter by actor email…" className="px-3 py-2 rounded-xl bg-input-background text-sm flex-1 min-w-[160px] focus:outline-none focus:ring-2 focus:ring-ring/20" />
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="px-3 py-2 rounded-xl bg-input-background text-sm focus:outline-none focus:ring-2 focus:ring-ring/20" />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="px-3 py-2 rounded-xl bg-input-background text-sm focus:outline-none focus:ring-2 focus:ring-ring/20" />
        <button onClick={load} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Filter</button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Timestamp</th>
              <th className="px-4 py-3 font-medium">Event</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="px-4 py-3 font-medium">IP Address</th>
              <th className="px-4 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logs.map(l => (
              <tr key={l.id}>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-4 py-3"><span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-muted text-foreground">{l.event_type}</span></td>
                <td className="px-4 py-3 text-foreground">{l.actor_email || 'system'}</td>
                <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{l.ip_address || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs truncate">{Object.keys(l.detail).length > 0 ? JSON.stringify(l.detail) : '—'}</td>
              </tr>
            ))}
            {!loading && logs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">No matching log entries.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
