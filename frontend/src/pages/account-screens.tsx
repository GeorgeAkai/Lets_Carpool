import { useEffect, useState, type ReactNode } from 'react'
import {
  BadgeDollarSign, Calendar, Check, ChevronLeft, ChevronRight, Download, Fuel, Mail, MapPin,
  Plus, Receipt, Share2, ShieldCheck, SlidersHorizontal, Star, Trash2, X,
} from 'lucide-react'
import * as api from '../api'
import type {
  ApiUser, EmergencyContact, RatingTag, ReportCategory, RidePreferences, RideVibe, SavedPlace,
  SettlementMethod, SettlementPreference, ShareMode, TripReceipt, UserImpact, UserStats,
} from '../api'
import { formatPlace } from '../lib/places'
import { Avatar, LocationInput, toInitials, type Connection, type LocationValue } from './home'
import { BottomSheet } from './discover-mobile'
import { IconButton, PrimaryButton, StickyFooter, dayLabel, fmtMoney, fmtTime } from './ride-flow'

// ─── Shared vocabulary ────────────────────────────────────────────────────────

export const VIBE_LABELS: Record<RideVibe, string> = {
  quiet: 'Quiet ride', music_ok: 'Music OK', chatty: 'Happy to chat',
  pets_ok: 'Pets OK', room_for_bags: 'Room for bags', no_smoking: 'No smoking',
}

export const RATING_TAG_LABELS: Record<RatingTag, string> = {
  on_time: 'On time', safe_driving: 'Safe driving', clean_car: 'Clean car',
  great_chat: 'Great chat', friendly: 'Friendly', easy_pickup: 'Easy pickup',
}

export const SETTLEMENT_LABELS: Record<SettlementMethod, string> = {
  cash: 'Cash', venmo: 'Venmo', zelle: 'Zelle', paypal: 'PayPal', cash_app: 'Cash App', other: 'Other',
}

const SHARE_MODE_LABELS: Record<ShareMode, string> = {
  every_trip: 'Every trip', night_only: 'Night trips only', off: 'Not sharing',
}

const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  safety: 'I felt unsafe', driving: 'Unsafe driving', no_show: 'No-show or very late',
  payment: 'Gas split problem', conduct: 'Rude or inappropriate', other: 'Something else',
}

export function settlementLine(s: SettlementPreference | null | undefined): string | null {
  if (!s) return null
  return s.handle ? `${SETTLEMENT_LABELS[s.method]} · ${s.handle}` : SETTLEMENT_LABELS[s.method]
}

// A selectable chip: 2px outline in the accent colour when on.
function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" aria-pressed={on} aria-label={label} onClick={onClick}
      className={`min-h-11 px-3.5 rounded-[14px] border-2 text-sm font-bold text-foreground transition-colors ${on ? 'border-primary bg-secondary/40' : 'border-border bg-card hover:border-muted-foreground/40'}`}>
      {children}
    </button>
  )
}

function ToggleRow({ title, sub, checked, onChange, disabled, last }: {
  title: string; sub?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; last?: boolean
}) {
  return (
    <label className={`flex items-center justify-between gap-3 min-h-[60px] ${last ? '' : 'border-b border-border'} ${disabled ? 'opacity-60' : ''}`}>
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-bold">{title}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="size-6 shrink-0 accent-[var(--primary)]" />
    </label>
  )
}

function ScreenHeader({ title, onBack, backLabel = 'Back', icon, action }: {
  title: string; onBack: () => void; backLabel?: string; icon?: ReactNode; action?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5">
      <IconButton label={backLabel} onClick={onBack}>{icon ?? <ChevronLeft className="size-5" />}</IconButton>
      <h1 className="flex-1 text-xl font-extrabold">{title}</h1>
      {action}
    </div>
  )
}

const inputCls = 'w-full h-11 px-3 rounded-xl bg-input-background border border-border text-sm text-foreground'

// ─── Welcome (first run) ──────────────────────────────────────────────────────

export function WelcomeScreen({ onStart }: { onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const features: { icon: ReactNode; label: string }[] = [
    { icon: <ShieldCheck className="size-[22px]" />, label: 'Verified drivers' },
    { icon: <Fuel className="size-[22px]" />, label: 'Fair gas split' },
    { icon: <Share2 className="size-[22px]" />, label: 'Live trip sharing' },
  ]
  return (
    <div className="min-h-screen bg-background text-foreground flex justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.75rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-md flex flex-col gap-[22px]">
        <div className="relative h-[min(400px,46vh)] rounded-[32px] bg-[#0c2a30] overflow-hidden shrink-0">
          <svg viewBox="0 0 358 400" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 w-full h-full" aria-hidden="true">
            <path d="M-20 330 C80 300 120 220 180 210 S300 150 380 80" stroke="#1d4a52" strokeWidth="44" fill="none" strokeLinecap="round" />
            <path d="M-20 330 C80 300 120 220 180 210 S300 150 380 80" stroke="#f4fbf8" strokeWidth="2" strokeDasharray="10 12" fill="none" opacity="0.6" />
            {[[70, 300], [180, 210], [290, 140]].map(([cx, cy]) => (
              <g key={cx}>
                <circle cx={cx} cy={cy} r="22" fill="#5fd3a2" />
                <circle cx={cx} cy={cy - 6} r="6" fill="#0c2a30" />
                <path d={`M${cx - 10} ${cy + 12}a10 9 0 0 1 20 0z`} fill="#0c2a30" />
              </g>
            ))}
          </svg>
          <div className="absolute top-7 left-6 flex items-center gap-2 text-[17px] font-extrabold text-[#f4fbf8]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5fd3a2" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="17" r="3" /><circle cx="17" cy="7" r="3" /><path d="M9.5 15.5l5-7" /></svg>
            Let's Carpool
          </div>
        </div>

        <div className="flex flex-col gap-2 px-1.5">
          <h1 className="text-[30px] font-extrabold tracking-[-0.02em] leading-[1.12]">Share the ride.<br />Split the gas.</h1>
          <p className="text-[15px] text-muted-foreground leading-[1.45]">Ride with neighbors and coworkers heading your way, and pay only your fair share.</p>
        </div>

        <ul className="grid grid-cols-3 gap-2">
          {features.map(f => (
            <li key={f.label} className="bg-card border border-border rounded-2xl px-2 py-3 flex flex-col items-center gap-1.5 text-center">
              <span className="text-primary" aria-hidden="true">{f.icon}</span>
              <span className="text-xs font-bold">{f.label}</span>
            </li>
          ))}
        </ul>

        <div className="mt-auto">
          <PrimaryButton disabled={busy} onClick={async () => { setBusy(true); try { await onStart() } finally { setBusy(false) } }}>
            Get started
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}

// ─── Ride preferences ─────────────────────────────────────────────────────────

const DEFAULT_PREFS: RidePreferences = {
  max_walk_minutes: null, vibes: [], verified_only: false, women_only: false, coworkers_first: false, route_checkins: true,
}

export function PreferencesScreen({ canWomenOnly, onClose, onApplied, showToast }: {
  // Only someone who declared "woman" on their profile can turn women-only on.
  canWomenOnly: boolean
  onClose: () => void
  onApplied: () => void
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [prefs, setPrefs] = useState<RidePreferences | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getPreferences().then(p => { if (!cancelled) setPrefs(p) }).catch(() => { if (!cancelled) setPrefs(DEFAULT_PREFS) })
    return () => { cancelled = true }
  }, [])

  const set = (patch: Partial<RidePreferences>) => setPrefs(p => ({ ...(p ?? DEFAULT_PREFS), ...patch }))
  const toggleVibe = (v: RideVibe) => set({ vibes: prefs?.vibes.includes(v) ? prefs.vibes.filter(x => x !== v) : [...(prefs?.vibes ?? []), v] })

  const save = async () => {
    if (!prefs) return
    setBusy(true)
    try {
      const { route_checkins: _keep, ...changes } = prefs
      await api.updatePreferences({ ...changes, women_only: canWomenOnly && prefs.women_only })
      onApplied()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save preferences', 'error') }
    finally { setBusy(false) }
  }

  return (
    <div className="max-w-md mx-auto flex flex-col gap-[18px] pb-36 xl:pb-6">
      <ScreenHeader title="Ride preferences" onBack={onClose} backLabel="Close" icon={<X className="size-5" />}
        action={<button type="button" onClick={() => setPrefs(p => ({ ...DEFAULT_PREFS, route_checkins: p?.route_checkins ?? true }))}
          className="min-h-11 px-2 text-sm font-bold text-primary">Reset</button>} />

      {!prefs ? <p className="text-sm text-muted-foreground animate-pulse py-6 text-center">Loading your preferences…</p> : (
        <>
          <section className="flex flex-col gap-2.5">
            <h2 className="text-sm font-extrabold">Max walk to pickup</h2>
            <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Max walk to pickup">
              {[5, 10, 15, null].map(m => (
                <button key={m ?? 'any'} type="button" role="radio" aria-checked={prefs.max_walk_minutes === m} onClick={() => set({ max_walk_minutes: m })}
                  className={`min-h-11 rounded-[14px] border-2 text-sm font-bold text-foreground ${prefs.max_walk_minutes === m ? 'border-primary bg-secondary/40' : 'border-border bg-card'}`}>
                  {m ? `${m} min` : 'Any'}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <h2 className="text-sm font-extrabold">Ride vibe</h2>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(VIBE_LABELS) as RideVibe[]).map(v => (
                <Chip key={v} on={prefs.vibes.includes(v)} onClick={() => toggleVibe(v)}>{VIBE_LABELS[v]}</Chip>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Rides that match your vibe show first. If you drive, riders see it on your trips.</p>
          </section>

          <section className="bg-card border border-border rounded-[18px] px-4 py-0.5 flex flex-col">
            <ToggleRow title="Verified drivers only" sub="ID checked by our team" checked={prefs.verified_only} onChange={v => set({ verified_only: v })} />
            <ToggleRow title="Women-only rides" checked={canWomenOnly && prefs.women_only} disabled={!canWomenOnly}
              sub={canWomenOnly ? 'Only see rides with women drivers and riders' : 'Available to women — add your gender in your profile'}
              onChange={v => set({ women_only: v })} />
            <ToggleRow title="Coworkers first" sub="Show people from your workplace or school at the top" checked={prefs.coworkers_first}
              onChange={v => set({ coworkers_first: v })} last />
          </section>
        </>
      )}

      <StickyFooter>
        <PrimaryButton onClick={save} disabled={!prefs || busy}>{busy ? 'Saving…' : 'Show matching rides'}</PrimaryButton>
      </StickyFooter>
    </div>
  )
}

// ─── Report an issue (shared by Safety and Receipt) ───────────────────────────

function ReportSheet({ open, onClose, connectionId, partnerFirst, showToast, defaultCategory = 'other' }: {
  open: boolean; onClose: () => void; connectionId: string; partnerFirst: string
  showToast: (msg: string, type: 'success' | 'error') => void; defaultCategory?: ReportCategory
}) {
  const [category, setCategory] = useState<ReportCategory>(defaultCategory)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setCategory(defaultCategory); setReason('') } }, [open, defaultCategory])
  return (
    <BottomSheet open={open} onClose={onClose} title="Report an issue">
      <form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); if (!reason.trim()) return
        setBusy(true)
        try { await api.reportTrip(connectionId, reason.trim(), category); showToast('Thanks — our team will review it within 24 hours', 'success'); onClose() }
        catch (err) { showToast(err instanceof Error ? err.message : 'Could not send report', 'error') }
        finally { setBusy(false) }
      }}>
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">What happened?</legend>
          {(Object.keys(REPORT_CATEGORY_LABELS) as ReportCategory[]).map(c => (
            <Chip key={c} on={category === c} onClick={() => setCategory(c)}>{REPORT_CATEGORY_LABELS[c]}</Chip>
          ))}
        </fieldset>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">Tell us more</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4} maxLength={1000} required
            placeholder={`What happened on your ride with ${partnerFirst}?`}
            className="w-full px-3 py-2.5 rounded-xl bg-input-background border border-border text-sm text-foreground resize-none" />
        </label>
        <PrimaryButton type="submit" disabled={busy || !reason.trim()}>{busy ? 'Sending…' : 'Send report'}</PrimaryButton>
      </form>
    </BottomSheet>
  )
}

// ─── Safety ───────────────────────────────────────────────────────────────────

export function SafetyScreen({ connection, onBack, showToast }: {
  // The ride this was opened from (Trip day), if any: enables the PIN, trip
  // sharing and reporting.
  connection: Connection | null
  onBack: () => void
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [contacts, setContacts] = useState<EmergencyContact[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [draft, setDraft] = useState({ name: '', relationship: '', phone: '', share_mode: 'every_trip' as ShareMode })
  const raw = connection?.raw
  const trip = raw?.driver_trip
  const partnerFirst = connection?.withUser.name.split(' ')[0] ?? ''
  const isRider = connection?.myRole === 'rider'
  const plate = trip?.vehicle?.plate

  useEffect(() => {
    api.getEmergencyContacts().then(setContacts).catch(() => setContacts([]))
  }, [])

  const tripText = connection
    ? `I'm carpooling with ${connection.withUser.name} on ${dayLabel(connection.date)}${trip?.departure_time ? ` at ${fmtTime(trip.departure_time)}` : ''}: ${connection.from} → ${connection.to}${plate ? ` (plate ${plate})` : ''}.`
    : ''

  const shareTrip = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'My carpool trip', text: tripText })
      else { await navigator.clipboard.writeText(tripText); showToast('Trip details copied', 'success') }
    } catch { /* share sheet dismissed */ }
  }

  const addContact = async () => {
    try {
      const c = await api.addEmergencyContact({ ...draft, relationship: draft.relationship.trim() || undefined })
      setContacts(prev => [...(prev ?? []), c]); setAdding(false)
      setDraft({ name: '', relationship: '', phone: '', share_mode: 'every_trip' })
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not add contact', 'error') }
  }

  const setMode = async (c: EmergencyContact, mode: ShareMode) => {
    setContacts(prev => prev?.map(x => x.id === c.id ? { ...x, share_mode: mode } : x) ?? null)
    try { await api.updateEmergencyContact(c.id, mode) }
    catch (e) { setContacts(prev => prev?.map(x => x.id === c.id ? c : x) ?? null); showToast(e instanceof Error ? e.message : 'Could not update', 'error') }
  }

  const remove = async (c: EmergencyContact) => {
    try { await api.deleteEmergencyContact(c.id); setContacts(prev => prev?.filter(x => x.id !== c.id) ?? null) }
    catch (e) { showToast(e instanceof Error ? e.message : 'Could not remove contact', 'error') }
  }

  const sharing = (contacts ?? []).filter(c => c.share_mode !== 'off')
  const smsHref = sharing.length && tripText
    ? `sms:${sharing.map(c => c.phone.replace(/[^+\d]/g, '')).join(',')}?&body=${encodeURIComponent(tripText)}`
    : null

  return (
    <div className="max-w-md mx-auto flex flex-col gap-3.5 pb-10">
      <ScreenHeader title="Safety" onBack={onBack} />

      <a href="tel:911" className="min-h-[76px] rounded-[20px] bg-[#c62f2f] text-[#fffaf5] flex items-center gap-3.5 px-[18px] hover:brightness-105">
        <span aria-hidden="true" className="size-12 rounded-full bg-[#fffaf5] text-[#c62f2f] flex items-center justify-center text-[13px] font-extrabold shrink-0">SOS</span>
        <span className="flex flex-col gap-0.5">
          <span className="text-[17px] font-extrabold">Call emergency services</span>
          <span className="text-xs text-[#ffe3dc]">Calls 911{plate ? ` · the car's plate is ${plate}` : ''}</span>
        </span>
      </a>

      {connection && isRider && raw?.ride_pin && (
        <div className="bg-card border border-border rounded-[18px] p-4 flex items-center gap-3.5">
          <div className="flex-1 flex flex-col gap-0.5">
            <span className="text-xs font-semibold text-muted-foreground">Your ride PIN</span>
            <span className="text-[13px] text-muted-foreground">
              {raw.pin_verified_at ? `${partnerFirst} confirmed it` : `Tell ${partnerFirst} before you get in`}
            </span>
          </div>
          <span className="text-[28px] font-extrabold tracking-[0.2em] tabular-nums" aria-label={`PIN ${raw.ride_pin.split('').join(' ')}`}>{raw.ride_pin}</span>
          {raw.pin_verified_at && <Check aria-hidden className="size-5 text-primary" />}
        </div>
      )}

      <section className="bg-card border border-border rounded-[18px] px-4 py-3.5 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-extrabold">Trusted contacts</h2>
          <button type="button" onClick={() => setAdding(true)} disabled={(contacts?.length ?? 0) >= 5}
            className="min-h-9 px-1 text-[13px] font-bold text-primary disabled:opacity-50">+ Add</button>
        </div>
        {contacts === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : contacts.length === 0 ? <p className="text-sm text-muted-foreground">Add someone you'd like to share your trips with.</p>
          : (
            <ul className="flex flex-col">
              {contacts.map(c => (
                <li key={c.id} className="flex items-center gap-3 min-h-12">
                  <span aria-hidden className="size-9 rounded-full bg-muted flex items-center justify-center font-extrabold text-sm shrink-0">{c.name.slice(0, 1).toUpperCase()}</span>
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="text-sm font-bold truncate">{c.name}{c.relationship ? ` (${c.relationship})` : ''}</span>
                    <select value={c.share_mode} onChange={e => setMode(c, e.target.value as ShareMode)} aria-label={`When to share trips with ${c.name}`}
                      className="self-start -ml-1 bg-transparent text-xs text-muted-foreground py-0.5">
                      {(Object.keys(SHARE_MODE_LABELS) as ShareMode[]).map(m => <option key={m} value={m}>{SHARE_MODE_LABELS[m]}</option>)}
                    </select>
                  </span>
                  <button type="button" onClick={() => remove(c)} aria-label={`Remove ${c.name}`}
                    className="size-11 rounded-xl text-muted-foreground hover:text-destructive flex items-center justify-center"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          )}
        {connection && (
          <div className="flex gap-2 pt-1">
            {smsHref && <a href={smsHref} className="flex-1 min-h-11 rounded-xl bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center gap-2"><Share2 className="size-4" />Text this trip to {sharing.length === 1 ? sharing[0].name : `${sharing.length} contacts`}</a>}
            <button type="button" onClick={shareTrip} className={`${smsHref ? '' : 'flex-1'} min-h-11 px-3.5 rounded-xl border border-border text-sm font-bold flex items-center justify-center gap-2`}>
              {smsHref ? 'More…' : <><Share2 className="size-4" />Share trip details</>}
            </button>
          </div>
        )}
      </section>

      {connection && (
        <button type="button" onClick={() => setReporting(true)}
          className="bg-card border border-border rounded-[18px] px-4 min-h-[62px] flex items-center justify-between gap-3 text-left">
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-bold">Report a safety issue</span>
            <span className="text-xs text-muted-foreground">Reviewed by our team within 24 hours</span>
          </span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      )}
      {connection && (
        <p className="text-xs text-muted-foreground text-center">To block {partnerFirst}, use the ⋯ menu in your conversation.</p>
      )}

      <BottomSheet open={adding} onClose={() => setAdding(false)} title="Add a trusted contact">
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); addContact() }}>
          <label className="block space-y-1.5"><span className="text-sm font-semibold">Name</span>
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} required maxLength={60} className={inputCls} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-semibold">Relationship <span className="text-muted-foreground font-normal">(optional)</span></span>
            <input value={draft.relationship} onChange={e => setDraft({ ...draft, relationship: e.target.value })} maxLength={30} placeholder="e.g. partner" className={inputCls} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-semibold">Phone</span>
            <input type="tel" autoComplete="tel" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} required placeholder="+1 555 123 4567" className={inputCls} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-semibold">Share trips</span>
            <select value={draft.share_mode} onChange={e => setDraft({ ...draft, share_mode: e.target.value as ShareMode })} className={inputCls}>
              {(Object.keys(SHARE_MODE_LABELS) as ShareMode[]).map(m => <option key={m} value={m}>{SHARE_MODE_LABELS[m]}</option>)}
            </select></label>
          <PrimaryButton type="submit" disabled={!draft.name.trim() || !draft.phone.trim()}>Add contact</PrimaryButton>
        </form>
      </BottomSheet>

      {connection && (
        <ReportSheet open={reporting} onClose={() => setReporting(false)} connectionId={connection.id}
          partnerFirst={partnerFirst} showToast={showToast} defaultCategory="safety" />
      )}
    </div>
  )
}

// ─── Trip receipt ─────────────────────────────────────────────────────────────

export function ReceiptScreen({ connectionId, currentUserId, onBack, showToast }: {
  connectionId: string
  currentUserId: string
  onBack: () => void
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [receipt, setReceipt] = useState<TripReceipt | null | 'missing'>(null)
  const [reporting, setReporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getReceipt(connectionId).then(r => { if (!cancelled) setReceipt(r) }).catch(() => { if (!cancelled) setReceipt('missing') })
    return () => { cancelled = true }
  }, [connectionId])

  if (receipt === null) return <div className="max-w-md mx-auto"><ScreenHeader title="Trip receipt" onBack={onBack} /><p className="text-sm text-muted-foreground animate-pulse py-8 text-center">Loading receipt…</p></div>
  if (receipt === 'missing') return (
    <div className="max-w-md mx-auto flex flex-col gap-4"><ScreenHeader title="Trip receipt" onBack={onBack} />
      <p className="text-sm text-muted-foreground py-8 text-center">A receipt is ready once the ride is marked complete.</p></div>
  )

  const isRider = receipt.rider_id === currentUserId
  const completed = new Date(receipt.completed_at)
  const endTime = completed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const startTime = receipt.departure_time ? fmtTime(receipt.departure_time) : null
  const dateLine = `${new Date(`${receipt.trip_date}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${startTime ? ` · ${startTime}–${endTime}` : ` · arrived ${endTime}`}`
  const miles = Math.round(receipt.distance_km * 0.621371)
  const settle = receipt.settlement_method ? SETTLEMENT_LABELS[receipt.settlement_method] : 'Agreed with your driver'
  const partnerFirst = isRider ? (receipt.driver_name ?? 'your driver').split(' ')[0] : 'your rider'

  const emailBody = [
    `Let's Carpool trip receipt ${receipt.receipt_number}`,
    dateLine,
    `${formatPlace(receipt.pickup_label)} → ${formatPlace(receipt.dropoff_label)}`,
    `Gas for ${miles} mi: ${fmtMoney(receipt.gas_cost_cents)}, split ${receipt.split_between} ways`,
    `Total (${receipt.seats} seat${receipt.seats === 1 ? '' : 's'}): ${fmtMoney(receipt.amount_cents)}`,
    `Driver: ${receipt.driver_name ?? '—'}${receipt.vehicle_label ? ` · ${receipt.vehicle_label}` : ''}`,
  ].join('\n')

  const row = 'flex justify-between gap-3'
  return (
    <div className="max-w-md mx-auto flex flex-col gap-3.5 pb-10">
      <ScreenHeader title="Trip receipt" onBack={onBack} />

      <article className="bg-card border border-border rounded-[20px] p-[18px] flex flex-col gap-4" aria-label={`Receipt ${receipt.receipt_number}`}>
        <div className="flex justify-between items-start gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground font-semibold">{dateLine}</span>
            <span className="text-[28px] font-extrabold">{fmtMoney(receipt.amount_cents)}</span>
          </div>
          <span className="text-xs font-extrabold px-2.5 py-1 rounded-lg bg-secondary text-secondary-foreground">Completed</span>
        </div>

        <div className="flex gap-3">
          <div aria-hidden className="flex flex-col items-center pt-1">
            <span className="size-3 rounded-full border-[3px] border-primary" />
            <span className="w-0.5 flex-1 bg-border my-1" />
            <MapPin className="size-3.5 fill-destructive text-destructive" />
          </div>
          <div className="flex flex-col gap-[18px] min-w-0">
            <span className="flex flex-col"><span className="text-xs text-muted-foreground">Pickup{startTime ? ` · ${startTime}` : ''}</span><span className="text-sm font-bold">{formatPlace(receipt.pickup_label)}</span></span>
            <span className="flex flex-col"><span className="text-xs text-muted-foreground">Drop-off · {endTime}</span><span className="text-sm font-bold">{formatPlace(receipt.dropoff_label)}</span></span>
          </div>
        </div>

        <div aria-hidden className="h-px bg-border" />
        <div className="flex flex-col gap-2 text-[13px]">
          <div className={`${row} text-muted-foreground`}><span>Gas for {miles} mi</span><span>{fmtMoney(receipt.gas_cost_cents)}</span></div>
          <div className={`${row} text-muted-foreground`}><span>Split {receipt.split_between} ways</span><span>÷ {receipt.split_between}</span></div>
          {receipt.seats > 1 && <div className={`${row} text-muted-foreground`}><span>{receipt.seats} seats × {fmtMoney(receipt.price_per_seat_cents)}</span><span /></div>}
          <div className={`${row} text-base font-extrabold`}><span>Total</span><span>{fmtMoney(receipt.amount_cents)}</span></div>
        </div>

        <div aria-hidden className="h-px bg-border" />
        <dl className="flex flex-col gap-2 text-[13px]">
          <div className={row}><dt className="text-muted-foreground">Driver</dt><dd className="font-bold text-right">{receipt.driver_name ?? '—'}{receipt.vehicle_label ? ` · ${receipt.vehicle_label}` : ''}</dd></div>
          <div className={row}><dt className="text-muted-foreground">Settle up via</dt><dd className="font-bold text-right">{settle}</dd></div>
          <div className={row}><dt className="text-muted-foreground">Trip ID</dt><dd className="font-bold">{receipt.receipt_number}</dd></div>
        </dl>
      </article>

      <div className="grid grid-cols-2 gap-2.5 print:hidden">
        <button type="button" onClick={() => window.print()}
          className="min-h-[52px] rounded-[14px] border border-border bg-card text-sm font-bold flex items-center justify-center gap-2"><Download className="size-[18px]" />PDF</button>
        <a href={`mailto:?subject=${encodeURIComponent(`Carpool receipt ${receipt.receipt_number}`)}&body=${encodeURIComponent(emailBody)}`}
          className="min-h-[52px] rounded-[14px] border border-border bg-card text-sm font-bold flex items-center justify-center gap-2"><Mail className="size-[18px]" />Email for expenses</a>
      </div>

      <button type="button" onClick={() => setReporting(true)} className="min-h-11 text-sm font-bold text-destructive print:hidden">Report an issue with this trip</button>
      <ReportSheet open={reporting} onClose={() => setReporting(false)} connectionId={connectionId} partnerFirst={partnerFirst} showToast={showToast} />
    </div>
  )
}

// ─── Profile hub (stats, mode, settings rows) ─────────────────────────────────

export function ProfileHub({ currentUser, mode, onSetMode, onOpen, showToast }: {
  currentUser: ApiUser
  mode: 'rider' | 'driver'
  onSetMode: (m: 'rider' | 'driver') => void
  onOpen: (v: 'my-listings' | 'preferences' | 'safety' | 'receipt', connectionId?: string) => void
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [impact, setImpact] = useState<UserImpact | null>(null)
  const [stats, setStats] = useState<UserStats | null>(null)
  const [settlement, setSettlement] = useState<SettlementPreference | null | undefined>(undefined)
  const [places, setPlaces] = useState<SavedPlace[]>([])
  const [contactsCount, setContactsCount] = useState<number | null>(null)
  const [receipts, setReceipts] = useState<TripReceipt[] | null>(null)
  const [sheet, setSheet] = useState<'settle' | 'places' | 'receipts' | null>(null)

  useEffect(() => {
    api.getImpact().then(setImpact).catch(() => {})
    api.getUserProfile(currentUser.id).then(p => setStats(p as UserStats)).catch(() => {})
    api.getSettlement().then(setSettlement).catch(() => setSettlement(null))
    api.getSavedPlaces().then(setPlaces).catch(() => {})
    api.getEmergencyContacts().then(c => setContactsCount(c.length)).catch(() => {})
  }, [currentUser.id])

  useEffect(() => {
    if (sheet === 'receipts' && receipts === null) api.getReceipts().then(setReceipts).catch(() => setReceipts([]))
  }, [sheet, receipts])

  const profile = currentUser.profile
  const rows: { label: string; meta?: string | null; icon: ReactNode; onClick: () => void }[] = [
    { label: 'My rides', meta: impact ? String(impact.shared_trips) : null, icon: <Calendar className="size-[18px]" />, onClick: () => onOpen('my-listings') },
    { label: 'Receipts', icon: <Receipt className="size-[18px]" />, onClick: () => setSheet('receipts') },
    { label: 'Settle up', meta: settlement ? SETTLEMENT_LABELS[settlement.method] : settlement === null ? 'Not set' : null, icon: <BadgeDollarSign className="size-[18px]" />, onClick: () => setSheet('settle') },
    { label: 'Saved places', meta: places.length ? places.map(p => p.label).slice(0, 2).join(', ') : null, icon: <MapPin className="size-[18px]" />, onClick: () => setSheet('places') },
    { label: 'Ride preferences', icon: <SlidersHorizontal className="size-[18px]" />, onClick: () => onOpen('preferences') },
    { label: 'Safety & emergency', meta: contactsCount ? `${contactsCount} contact${contactsCount === 1 ? '' : 's'}` : null, icon: <ShieldCheck className="size-[18px]" />, onClick: () => onOpen('safety') },
  ]

  return (
    <div className="flex flex-col gap-3.5 max-w-md xl:max-w-none">
      <div className="flex items-center gap-3.5">
        <Avatar initials={toInitials(profile.display_name)} photoUrl={profile.photo_url} size="lg" />
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-xl font-extrabold truncate">{profile.display_name}</span>
          <span className="text-[13px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
            {stats?.id_verified && <><ShieldCheck className="size-3.5 text-info" aria-hidden />ID verified ·</>}
            {stats?.rating_avg != null ? <><Star className="size-3.5 fill-accent text-accent" aria-hidden />{stats.rating_avg.toFixed(1)} ({stats.rating_count})</> : 'No ratings yet'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { value: impact ? String(impact.shared_trips) : '—', label: 'Shared trips' },
          { value: impact ? fmtMoney(impact.saved_cents).replace(/\.00$/, '') : '—', label: mode === 'driver' ? 'Gas covered' : 'Saved on gas' },
          { value: impact ? String(impact.regular_buddies) : '—', label: 'Regular buddies' },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border rounded-2xl p-3 flex flex-col gap-0.5">
            <span className="text-xl font-extrabold">{s.value}</span>
            <span className="text-xs text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>

      <label className="flex items-center justify-between gap-3 rounded-[18px] px-4 py-3.5 bg-[#0c2a30] text-[#f4fbf8]">
        <span className="flex flex-col gap-0.5">
          <span className="text-[15px] font-bold">Driver mode</span>
          <span className="text-xs text-[#a9c9c4]">Offer seats on your own commute</span>
        </span>
        <input type="checkbox" checked={mode === 'driver'} onChange={e => onSetMode(e.target.checked ? 'driver' : 'rider')} className="size-6 accent-[#5fd3a2]" />
      </label>

      <nav aria-label="Account" className="bg-card border border-border rounded-[18px] px-1.5 py-1 flex flex-col">
        {rows.map((r, i) => (
          <button key={r.label} type="button" onClick={r.onClick}
            className={`min-h-[52px] flex items-center gap-3 px-2.5 text-left ${i < rows.length - 1 ? 'border-b border-border' : ''}`}>
            <span aria-hidden className="size-[34px] rounded-[10px] bg-muted flex items-center justify-center">{r.icon}</span>
            <span className="flex-1 text-[15px] font-semibold">{r.label}</span>
            {r.meta && <span className="text-xs text-muted-foreground truncate max-w-[40%]">{r.meta}</span>}
            <ChevronRight className="size-4 text-muted-foreground shrink-0" />
          </button>
        ))}
      </nav>

      <SettleUpSheet open={sheet === 'settle'} onClose={() => setSheet(null)} current={settlement ?? null}
        onSaved={s => { setSettlement(s); setSheet(null); showToast('Saved', 'success') }} showToast={showToast} />
      <PlacesSheet open={sheet === 'places'} onClose={() => setSheet(null)} places={places} setPlaces={setPlaces} showToast={showToast} />
      <BottomSheet open={sheet === 'receipts'} onClose={() => setSheet(null)} title="Receipts">
        {receipts === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : receipts.length === 0 ? <p className="text-sm text-muted-foreground">Receipts appear here after each completed ride.</p>
          : (
            <ul className="flex flex-col gap-2">
              {receipts.map(r => (
                <li key={r.id}>
                  <button type="button" onClick={() => { setSheet(null); onOpen('receipt', r.connection_id) }}
                    className="w-full text-left bg-muted rounded-xl px-3.5 py-2.5 flex items-center gap-3">
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="text-sm font-bold truncate">{formatPlace(r.pickup_label)} → {formatPlace(r.dropoff_label)}</span>
                      <span className="text-xs text-muted-foreground">{dayLabel(r.trip_date)} · {r.receipt_number}</span>
                    </span>
                    <span className="text-sm font-extrabold">{fmtMoney(r.amount_cents)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </BottomSheet>
    </div>
  )
}

function SettleUpSheet({ open, onClose, current, onSaved, showToast }: {
  open: boolean; onClose: () => void; current: SettlementPreference | null
  onSaved: (s: SettlementPreference) => void; showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [method, setMethod] = useState<SettlementMethod>(current?.method ?? 'cash')
  const [handle, setHandle] = useState(current?.handle ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setMethod(current?.method ?? 'cash'); setHandle(current?.handle ?? '') } }, [open, current])
  const needsHandle = method !== 'cash'
  return (
    <BottomSheet open={open} onClose={onClose} title="Settle up">
      <form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); setBusy(true)
        try { onSaved(await api.setSettlement(method, needsHandle ? handle.trim() || null : null)) }
        catch (err) { showToast(err instanceof Error ? err.message : 'Could not save', 'error') }
        finally { setBusy(false) }
      }}>
        <p className="text-sm text-muted-foreground">Gas splits are settled between you and your ride partner — the app never takes payment. When you drive, riders see how you'd like to be paid back once you accept them.</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">How you settle up</legend>
          {(Object.keys(SETTLEMENT_LABELS) as SettlementMethod[]).map(m => (
            <label key={m} className={`flex items-center gap-3 px-3.5 py-2.5 rounded-2xl border-2 cursor-pointer ${method === m ? 'border-primary bg-secondary/40' : 'border-border bg-card'}`}>
              <span className="flex-1 text-[15px] font-bold">{SETTLEMENT_LABELS[m]}{m === 'cash' && <span className="block text-xs font-normal text-muted-foreground">Hand it over at drop-off</span>}</span>
              <input type="radio" name="settle" checked={method === m} onChange={() => setMethod(m)} className="size-5 accent-[var(--primary)]" />
            </label>
          ))}
        </fieldset>
        {needsHandle && (
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">{method === 'zelle' ? 'Email or phone for Zelle' : method === 'other' ? 'How to pay you' : `Your ${SETTLEMENT_LABELS[method]} handle`}</span>
            <input value={handle} onChange={e => setHandle(e.target.value)} maxLength={60} placeholder={method === 'venmo' || method === 'cash_app' ? '@yourname' : ''} className={inputCls} />
          </label>
        )}
        <PrimaryButton type="submit" disabled={busy}>Save</PrimaryButton>
      </form>
    </BottomSheet>
  )
}

function PlacesSheet({ open, onClose, places, setPlaces, showToast }: {
  open: boolean; onClose: () => void; places: SavedPlace[]; setPlaces: (p: SavedPlace[]) => void
  showToast: (msg: string, type: 'success' | 'error') => void
}) {
  const [editing, setEditing] = useState<SavedPlace['kind'] | null>(null)
  const [value, setValue] = useState<LocationValue | null>(null)
  const [label, setLabel] = useState('')
  useEffect(() => { if (!open) { setEditing(null); setValue(null); setLabel('') } }, [open])

  const save = async (loc: LocationValue) => {
    if (!editing) return
    try {
      const l = await api.createLocation(loc.label, loc.lat, loc.lng)
      const place = await api.savePlace(editing, l.id, editing === 'other' ? label.trim() || undefined : undefined)
      setPlaces([...places.filter(p => editing === 'other' || p.kind !== editing), place]
        .sort((a, b) => ['home', 'work', 'other'].indexOf(a.kind) - ['home', 'work', 'other'].indexOf(b.kind)))
      setEditing(null); setValue(null); setLabel('')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save place', 'error') }
  }

  const slot = (kind: 'home' | 'work') => places.find(p => p.kind === kind)
  return (
    <BottomSheet open={open} onClose={onClose} title="Saved places">
      {editing ? (
        <div className="space-y-3">
          {editing === 'other' && (
            <label className="block space-y-1.5"><span className="text-sm font-semibold">Name</span>
              <input value={label} onChange={e => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Gym" className={inputCls} /></label>
          )}
          <LocationInput label={editing === 'other' ? 'Address' : `${editing === 'home' ? 'Home' : 'Work'} address`} value={value}
            onChange={v => { setValue(v); if (v && Number.isFinite(v.lat)) save(v) }} placeholder="Search an address" />
          <button type="button" onClick={() => setEditing(null)} className="w-full min-h-11 text-sm font-semibold text-muted-foreground">Cancel</button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {(['home', 'work'] as const).map(kind => {
            const p = slot(kind)
            return (
              <li key={kind} className="flex items-center gap-2">
                <button type="button" onClick={() => setEditing(kind)} className="flex-1 min-w-0 text-left bg-muted rounded-xl px-3.5 py-2.5">
                  <span className="block text-sm font-bold">{kind === 'home' ? 'Home' : 'Work'}</span>
                  <span className="block text-xs text-muted-foreground truncate">{p ? formatPlace(p.location.label) : 'Add address'}</span>
                </button>
                {p && <PlaceDelete place={p} places={places} setPlaces={setPlaces} showToast={showToast} />}
              </li>
            )
          })}
          {places.filter(p => p.kind === 'other').map(p => (
            <li key={p.id} className="flex items-center gap-2">
              <div className="flex-1 min-w-0 bg-muted rounded-xl px-3.5 py-2.5">
                <span className="block text-sm font-bold">{p.label}</span>
                <span className="block text-xs text-muted-foreground truncate">{formatPlace(p.location.label)}</span>
              </div>
              <PlaceDelete place={p} places={places} setPlaces={setPlaces} showToast={showToast} />
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setEditing('other')}
              className="w-full min-h-12 rounded-xl border-2 border-dashed border-border text-primary text-sm font-bold flex items-center justify-center gap-2"><Plus className="size-4" />Add a place</button>
          </li>
        </ul>
      )}
    </BottomSheet>
  )
}

function PlaceDelete({ place, places, setPlaces, showToast }: {
  place: SavedPlace; places: SavedPlace[]; setPlaces: (p: SavedPlace[]) => void; showToast: (msg: string, type: 'success' | 'error') => void
}) {
  return (
    <button type="button" aria-label={`Remove ${place.label}`}
      onClick={async () => { try { await api.deleteSavedPlace(place.id); setPlaces(places.filter(x => x.id !== place.id)) } catch (e) { showToast(e instanceof Error ? e.message : 'Could not remove', 'error') } }}
      className="size-11 rounded-xl text-muted-foreground hover:text-destructive flex items-center justify-center shrink-0"><Trash2 className="size-4" /></button>
  )
}
