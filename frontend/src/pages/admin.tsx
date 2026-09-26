import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Ban, Car, CheckCircle2, Flag, MapPin, RefreshCw, Search, ShieldCheck, Users, UserCheck,
} from 'lucide-react'
import * as api from '../api'
import type { AdminDestination, AdminReport, AdminStats, AdminUserRow, AuditLogEntry, ApiUser } from '../api'
import { formatPlace } from '../lib/places'

// The backend is the real gate (every /admin/* endpoint 403s for anyone else);
// this constant only decides what the client renders before that check lands.
export const SUPERADMIN_EMAIL = 'ageorge@akihlee.com'

export function isSuperadmin(user: Pick<ApiUser, 'email' | 'is_admin'> | null | undefined): boolean {
  if (!user) return false
  return user.is_admin === true || user.email.toLowerCase() === SUPERADMIN_EMAIL
}

type Tab = 'users' | 'reports' | 'insights' | 'audit'

const EVENT_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All events' },
  { value: 'auth.', label: 'Sign-ins' },
  { value: 'listing.', label: 'Listings' },
  { value: 'connection.', label: 'Connections' },
  { value: 'user.', label: 'Blocks & reports' },
  { value: 'admin.', label: 'Admin actions' },
]

function fmtDate(iso: string, withTime = false): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return withTime
    ? d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export function AdminPage() {
  const navigate = useNavigate()
  const [me, setMe] = useState<ApiUser | null>(null)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [tab, setTab] = useState<Tab>('users')
  const [error, setError] = useState<string | null>(null)

  // Any 401 means the session is gone; any 403 means "not the superadmin".
  const handleError = useCallback((e: unknown) => {
    if (e instanceof api.ApiError && e.status === 401) { navigate('/auth/sign-in', { replace: true }); return }
    if (e instanceof api.ApiError && e.status === 403) { navigate('/403', { replace: true }); return }
    setError(e instanceof Error ? e.message : 'Something went wrong')
  }, [navigate])

  useEffect(() => {
    if (!localStorage.getItem('carpool_token')) { navigate('/auth/sign-in', { replace: true }); return }
    api.getMe()
      .then(user => {
        if (!isSuperadmin(user)) { navigate('/403', { replace: true }); return }
        setMe(user)
      })
      .catch(handleError)
  }, [navigate, handleError])

  const loadStats = useCallback(() => { api.getAdminStats().then(setStats).catch(handleError) }, [handleError])
  useEffect(() => { if (me) loadStats() }, [me, loadStats])

  if (!me) {
    return (
      <div className="min-h-screen bg-background text-muted-foreground flex items-center justify-center text-sm">
        {error ?? 'Checking access…'}
      </div>
    )
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'users', label: 'Users' },
    { id: 'reports', label: 'Reports', badge: stats?.open_reports },
    { id: 'insights', label: 'Route insights' },
    { id: 'audit', label: 'Audit logs' },
  ]

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
        <div className="max-w-[1440px] mx-auto px-4 lg:px-8 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => navigate('/discover')} aria-label="Back to app" className="p-2 -ml-2 rounded-xl hover:bg-sidebar-accent transition-colors">
              <ArrowLeft className="size-4" />
            </button>
            <ShieldCheck className="size-5 text-sidebar-primary shrink-0" />
            <span className="font-semibold truncate">Admin Console</span>
          </div>
          <span className="hidden sm:block text-xs text-sidebar-foreground/60 truncate">{me.email}</span>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-4 lg:px-8 py-6 space-y-6">
        {error && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-xs font-semibold">Dismiss</button>
          </div>
        )}

        <KpiGrid stats={stats} onRefresh={loadStats} />

        <div className="flex gap-1 overflow-x-auto rounded-2xl bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
          {tabs.map(t => (
            <button
              key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`shrink-0 flex-1 min-w-fit px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 ${tab === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
              {!!t.badge && <span className="min-w-5 h-5 px-1.5 rounded-full bg-destructive text-white text-[11px] font-bold flex items-center justify-center">{t.badge}</span>}
            </button>
          ))}
        </div>

        {tab === 'users' && <UsersPanel currentAdminId={me.id} onError={handleError} onChanged={loadStats} />}
        {tab === 'reports' && <ReportsPanel onError={handleError} onChanged={loadStats} />}
        {tab === 'insights' && <InsightsPanel onError={handleError} />}
        {tab === 'audit' && <AuditPanel onError={handleError} />}
      </main>
    </div>
  )
}

// ─── KPIs ───────────────────────────────────────────────────────────────────────

function KpiGrid({ stats, onRefresh }: { stats: AdminStats | null; onRefresh: () => void }) {
  const v = (n: number | undefined) => (stats ? n ?? 0 : '—')
  const cards: { label: string; value: ReactNode; sub: string; Icon: typeof Users; tone: string }[] = [
    { label: 'Total users', value: v(stats?.total_users), sub: stats ? `${stats.drivers} drivers · ${stats.passengers} passengers` : 'Loading…', Icon: Users, tone: 'bg-primary/10 text-primary' },
    { label: 'Active drivers', value: v(stats?.active_drivers), sub: 'With an open trip', Icon: Car, tone: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
    { label: 'Active riders', value: v(stats?.active_riders), sub: 'With an open request', Icon: UserCheck, tone: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
    { label: 'Completed rides', value: v(stats?.completed_rides), sub: 'All time', Icon: CheckCircle2, tone: 'bg-green-500/10 text-green-600 dark:text-green-400' },
    { label: 'Blocked / reported', value: stats ? `${stats.blocked_users} / ${stats.reported_users}` : '—', sub: stats ? `${stats.open_reports} open report${stats.open_reports === 1 ? '' : 's'}` : 'Loading…', Icon: Ban, tone: 'bg-destructive/10 text-destructive' },
  ]
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Platform overview</h1>
        <button onClick={onRefresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <RefreshCw className="size-3.5" /> Refresh
        </button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {cards.map(({ label, value, sub, Icon, tone }, i) => (
          <div key={label} className={`rounded-2xl border border-border bg-card p-4 ${i === 0 ? 'col-span-2 lg:col-span-1' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <span className={`size-7 rounded-lg flex items-center justify-center ${tone}`}><Icon className="size-3.5" /></span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{sub}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Shared table chrome ────────────────────────────────────────────────────────

function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="w-full pl-9 pr-3 py-2 rounded-xl bg-input-background text-sm focus:outline-none focus:ring-2 focus:ring-ring/20"
      />
    </div>
  )
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return <tr><td colSpan={colSpan} className="px-5 py-10 text-center text-sm text-muted-foreground">{children}</td></tr>
}

const TH = 'px-5 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap'
const TD = 'px-5 py-3 align-middle'

// ─── Users ──────────────────────────────────────────────────────────────────────

function UsersPanel({ currentAdminId, onError, onChanged }: { currentAdminId: string; onError: (e: unknown) => void; onChanged: () => void }) {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query)
  const [users, setUsers] = useState<AdminUserRow[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getAdminUsers(debounced).then(rows => { if (!cancelled) setUsers(rows) }).catch(onError)
    return () => { cancelled = true }
  }, [debounced, onError])

  const toggle = async (u: AdminUserRow) => {
    setBusyId(u.id)
    try {
      const res = await api.setAdminUserBlocked(u.id, !u.suspended)
      setUsers(prev => prev?.map(x => x.id === u.id ? { ...x, suspended: res.suspended } : x) ?? null)
      onChanged()
    } catch (e) { onError(e) } finally { setBusyId(null) }
  }

  return (
    <Panel title="User moderation" actions={<SearchInput value={query} onChange={setQuery} placeholder="Search name or email" />}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr><th className={TH}>User</th><th className={TH}>Role</th><th className={TH}>Joined</th><th className={TH}>Open reports</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Access</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users === null ? <EmptyRow colSpan={6}>Loading users…</EmptyRow>
              : users.length === 0 ? <EmptyRow colSpan={6}>No users match “{debounced}”.</EmptyRow>
              : users.map(u => (
                <tr key={u.id} className="hover:bg-muted/30">
                  <td className={TD}>
                    <div className="flex items-center gap-3 min-w-[200px]">
                      {u.photo_url
                        ? <img src={u.photo_url} alt="" className="size-8 rounded-full object-cover" />
                        : <div className="size-8 rounded-full bg-secondary text-secondary-foreground text-xs font-semibold flex items-center justify-center">{(u.display_name ?? u.email).slice(0, 2).toUpperCase()}</div>}
                      <div className="min-w-0">
                        <p className="font-medium truncate">{u.display_name ?? '—'}</p>
                        <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className={TD}>
                    <div className="flex gap-1">
                      {u.is_driver && <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">Driver</span>}
                      {u.is_rider && <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/15 text-amber-700 dark:text-amber-400 font-medium">Passenger</span>}
                      {!u.is_driver && !u.is_rider && <span className="text-xs text-muted-foreground">—</span>}
                    </div>
                  </td>
                  <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{fmtDate(u.created_at)}</td>
                  <td className={`${TD} tabular-nums`}>{u.open_reports > 0 ? <span className="font-semibold text-destructive">{u.open_reports}</span> : <span className="text-muted-foreground">0</span>}</td>
                  <td className={TD}>
                    {u.suspended
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium">Blocked</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400 font-medium">Active</span>}
                  </td>
                  <td className={`${TD} text-right`}>
                    <button
                      role="switch" aria-checked={!u.suspended} aria-label={`${u.suspended ? 'Unblock' : 'Block'} ${u.email}`}
                      disabled={busyId === u.id || u.id === currentAdminId}
                      onClick={() => toggle(u)}
                      title={u.id === currentAdminId ? "You can't block yourself" : undefined}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors disabled:opacity-40 ${u.suspended ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border border-border text-destructive hover:bg-destructive/10'}`}
                    >
                      {u.suspended ? 'Unblock' : 'Block'}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ─── Reports ────────────────────────────────────────────────────────────────────

function ReportsPanel({ onError, onChanged }: { onError: (e: unknown) => void; onChanged: () => void }) {
  const [status, setStatus] = useState<'open' | 'dismissed' | 'actioned' | 'all'>('open')
  const [reports, setReports] = useState<AdminReport[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => { api.getAdminReports(status).then(setReports).catch(onError) }, [status, onError])
  useEffect(() => { setReports(null); load() }, [load])

  const act = async (r: AdminReport, action: 'dismiss' | 'suspend') => {
    setBusyId(r.id)
    try { await api.resolveAdminReport(r.id, action); load(); onChanged() }
    catch (e) { onError(e) } finally { setBusyId(null) }
  }

  const statusPill = (s: AdminReport['status']) => ({
    open: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    dismissed: 'bg-muted text-muted-foreground',
    actioned: 'bg-destructive/10 text-destructive',
  }[s])

  return (
    <Panel
      title="Reported users queue"
      actions={
        <div className="flex gap-1 rounded-xl bg-muted p-0.5">
          {(['open', 'dismissed', 'actioned', 'all'] as const).map(s => (
            <button key={s} onClick={() => setStatus(s)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${status === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{s}</button>
          ))}
        </div>
      }
    >
      {reports === null ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading reports…</p>
        : reports.length === 0 ? (
          <div className="px-5 py-12 text-center text-muted-foreground">
            <Flag className="size-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">{status === 'open' ? 'No open reports — the queue is clear.' : 'Nothing here.'}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {reports.map(r => (
              <li key={r.id} className="px-5 py-4 flex flex-col lg:flex-row lg:items-center gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.reported_name ?? r.reported_email}</span>
                    <span className="text-xs text-muted-foreground">{r.reported_email}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium capitalize ${statusPill(r.status)}`}>{r.status}</span>
                    {r.reported_suspended && <span className="text-[11px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium">Account blocked</span>}
                  </div>
                  <p className="text-sm">“{r.reason}”</p>
                  <p className="text-xs text-muted-foreground">Reported by {r.reporter_name ?? r.reporter_email} · {fmtDate(r.created_at, true)}</p>
                </div>
                {r.status === 'open' && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => act(r, 'dismiss')} disabled={busyId === r.id} className="px-3.5 py-2 rounded-xl border border-border text-sm font-medium hover:bg-muted disabled:opacity-50 transition-colors">Dismiss</button>
                    <button onClick={() => act(r, 'suspend')} disabled={busyId === r.id} className="px-3.5 py-2 rounded-xl bg-destructive text-white text-sm font-semibold hover:bg-destructive/90 disabled:opacity-50 transition-colors">Suspend account</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
    </Panel>
  )
}

// ─── Route insights ─────────────────────────────────────────────────────────────

function InsightsPanel({ onError }: { onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AdminDestination[] | null>(null)
  useEffect(() => { api.getAdminDestinations(10).then(setRows).catch(onError) }, [onError])
  const max = useMemo(() => Math.max(1, ...(rows ?? []).map(r => r.total)), [rows])

  return (
    <Panel title="Top popular destinations">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr><th className={`${TH} w-12`}>#</th><th className={TH}>Destination</th><th className={`${TH} text-right`}>Driver trips</th><th className={`${TH} text-right`}>Ride requests</th><th className={`${TH} w-1/3`}>Total</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows === null ? <EmptyRow colSpan={5}>Loading…</EmptyRow>
              : rows.length === 0 ? <EmptyRow colSpan={5}>No rides have been posted yet.</EmptyRow>
              : rows.map((r, i) => (
                <tr key={r.label}>
                  <td className={`${TD} text-muted-foreground tabular-nums`}>{i + 1}</td>
                  <td className={TD}><span className="flex items-center gap-2 font-medium min-w-[160px]"><MapPin className="size-3.5 text-primary shrink-0" />{formatPlace(r.label)}</span></td>
                  <td className={`${TD} text-right tabular-nums`}>{r.trips}</td>
                  <td className={`${TD} text-right tabular-nums`}>{r.requests}</td>
                  <td className={TD}>
                    <div className="flex items-center gap-2 min-w-[120px]">
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${(r.total / max) * 100}%` }} /></div>
                      <span className="text-xs font-semibold tabular-nums w-6 text-right">{r.total}</span>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ─── Audit logs ─────────────────────────────────────────────────────────────────

function AuditPanel({ onError }: { onError: (e: unknown) => void }) {
  const [eventType, setEventType] = useState('')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query)
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getAuditLogs(eventType || undefined, debounced).then(rows => { if (!cancelled) setLogs(rows) }).catch(onError)
    return () => { cancelled = true }
  }, [eventType, debounced, onError])

  const tone = (t: string) =>
    t.startsWith('admin.') ? 'bg-destructive/10 text-destructive'
      : t.startsWith('auth.') ? 'bg-primary/10 text-primary'
      : t.startsWith('user.') ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
      : 'bg-muted text-muted-foreground'

  return (
    <Panel
      title="Audit logs"
      actions={
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <select value={eventType} onChange={e => setEventType(e.target.value)} aria-label="Event type" className="px-3 py-2 rounded-xl bg-input-background text-sm focus:outline-none focus:ring-2 focus:ring-ring/20">
            {EVENT_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <SearchInput value={query} onChange={setQuery} placeholder="Search actor, IP or details" />
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr><th className={TH}>Timestamp</th><th className={TH}>Event type</th><th className={TH}>Actor</th><th className={TH}>IP address</th><th className={TH}>Details</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logs === null ? <EmptyRow colSpan={5}>Loading…</EmptyRow>
              : logs.length === 0 ? <EmptyRow colSpan={5}>No events match these filters.</EmptyRow>
              : logs.map(l => (
                <tr key={l.id} className="hover:bg-muted/30">
                  <td className={`${TD} whitespace-nowrap text-muted-foreground tabular-nums`}>{fmtDate(l.created_at, true)}</td>
                  <td className={TD}><span className={`text-[11px] px-2 py-0.5 rounded-full font-mono whitespace-nowrap ${tone(l.event_type)}`}>{l.event_type}</span></td>
                  <td className={`${TD} whitespace-nowrap`}>{l.actor_email ?? <span className="text-muted-foreground">system</span>}</td>
                  <td className={`${TD} whitespace-nowrap font-mono text-xs text-muted-foreground`}>{l.ip_address ?? '—'}</td>
                  <td className={`${TD} text-muted-foreground min-w-[220px]`}>{l.details || '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
