import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Car, Check, Shield, X } from 'lucide-react'
import * as api from '../api'

// A read-only look at another user's public profile, opened from any avatar
// or name — so a rider can check out a driver before requesting, and a
// driver can check out a rider before accepting. Never shows contact details.

const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }
const MONO: CSSProperties = { fontFamily: "'DM Mono', monospace" }

const CAR_LABEL: Record<string, string> = {
  sedan: '🚗 Sedan', suv: '🚙 SUV', van: '🚐 Van', minivan: '🚐 Minivan', truck: '🚚 Truck', other: '🚗 Other',
}

export type ProfileTarget = {
  userId: string
  name: string
  photoUrl?: string | null
  // Which side of the ride they're on here — drivers get their vehicle shown.
  role: 'driver' | 'rider'
  // Optional primary action shown under the profile (e.g. "Request to join").
  action?: { label: string; onClick: () => void; disabled?: boolean }
}

const ProfileSheetContext = createContext<(target: ProfileTarget) => void>(() => {})

export function useOpenProfile() {
  return useContext(ProfileSheetContext)
}

export function ProfileSheetProvider({ myInterests, children }: { myInterests: string[]; children: ReactNode }) {
  const [target, setTarget] = useState<ProfileTarget | null>(null)
  const open = useCallback((t: ProfileTarget) => setTarget(t), [])
  return (
    <ProfileSheetContext.Provider value={open}>
      {children}
      {target && <ProfileSheet target={target} myInterests={myInterests} onClose={() => setTarget(null)} />}
    </ProfileSheetContext.Provider>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

// Avatar that opens the profile sheet — use anywhere a person is shown.
export function ProfileAvatar({ target, size = 40, className = '' }: { target: ProfileTarget; size?: number; className?: string }) {
  const open = useOpenProfile()
  return (
    <button
      type="button" onClick={e => { e.stopPropagation(); open(target) }}
      aria-label={`View ${target.name}'s profile`}
      className={`shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      style={{ width: size, height: size }}
    >
      <PersonPhoto name={target.name} photoUrl={target.photoUrl} size={size} />
    </button>
  )
}

export function PersonPhoto({ name, photoUrl, size }: { name: string; photoUrl?: string | null; size: number }) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) }
  return photoUrl ? (
    <img src={photoUrl} alt="" style={style} className="rounded-full object-cover ring-1 ring-border" />
  ) : (
    <span style={{ ...style, ...MONO }} className="rounded-full bg-secondary text-secondary-foreground font-semibold flex items-center justify-center">
      {initialsOf(name)}
    </span>
  )
}

function memberSince(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString([], { month: 'long', year: 'numeric' })
}

function ProfileSheet({ target, myInterests, onClose }: { target: ProfileTarget; myInterests: string[]; onClose: () => void }) {
  const [profile, setProfile] = useState<api.ApiPublicProfile | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    api.getUserProfile(target.userId).then(p => { if (active) setProfile(p) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [target.userId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const name = profile?.display_name ?? target.name
  const photo = profile?.photo_url ?? target.photoUrl
  const mine = new Set(myInterests.map(i => i.toLowerCase()))
  const rides = profile?.completed_rides
  const totalRides = rides ? rides.as_driver + rides.as_rider : null
  const v = profile?.vehicle
  const vehicleName = v ? [v.color, v.make, v.model].filter(Boolean).join(' ') : ''
  const since = memberSince(profile?.member_since)

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={`${name}'s profile`}>
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[85vh] overflow-y-auto bg-card border border-border rounded-t-3xl sm:rounded-2xl shadow-xl p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <button onClick={onClose} aria-label="Close profile" className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors">
          <X className="size-5" />
        </button>

        <div className="flex flex-col items-center text-center">
          <PersonPhoto name={name} photoUrl={photo} size={88} />
          <h2 style={SERIF} className="mt-3 text-2xl text-foreground">{name}</h2>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-0.5">{target.role === 'driver' ? 'Driver' : 'Rider'}</p>
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">
            {profile?.email_domain && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                <Check className="size-3" />Email verified · @{profile.email_domain}
              </span>
            )}
            {profile?.photo_verified && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                <Check className="size-3" />Photo verified
              </span>
            )}
          </div>
        </div>

        {error ? (
          <p className="mt-6 text-sm text-center text-muted-foreground">Couldn't load this profile.</p>
        ) : !profile ? (
          <p className="mt-6 text-sm text-center text-muted-foreground animate-pulse">Loading profile…</p>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-muted p-3">
                <p style={MONO} className="text-lg font-bold text-foreground">{totalRides ?? '–'}</p>
                <p className="text-xs text-muted-foreground">rides completed</p>
              </div>
              <div className="rounded-xl bg-muted p-3">
                <p className="text-sm font-bold text-foreground">{since ?? '–'}</p>
                <p className="text-xs text-muted-foreground">member since</p>
              </div>
            </div>

            {profile.bio && <p className="text-sm text-foreground whitespace-pre-wrap">{profile.bio}</p>}

            {(profile.nationality || profile.interests.length > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {profile.nationality && <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">{profile.nationality}</span>}
                {profile.interests.map(i => (
                  <span key={i} className={`text-xs px-2 py-0.5 rounded-full font-medium ${mine.has(i.toLowerCase()) ? 'bg-secondary text-secondary-foreground ring-1 ring-primary' : 'bg-muted text-muted-foreground'}`}>
                    {mine.has(i.toLowerCase()) ? '★ ' : ''}{i}
                  </span>
                ))}
              </div>
            )}

            {target.role === 'driver' && (
              <div className="rounded-xl border border-border p-4 space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Car className="size-3.5" />Vehicle</p>
                {v && (vehicleName || v.car_type) ? (
                  <p className="text-sm font-semibold text-foreground">
                    {vehicleName || 'Vehicle'}{v.car_type && CAR_LABEL[v.car_type] ? ` · ${CAR_LABEL[v.car_type]}` : ''}{v.seats ? ` · ${v.seats} seats` : ''}
                  </p>
                ) : <p className="text-sm text-muted-foreground">No vehicle details added yet.</p>}
                {v && (
                  <ul className="space-y-1 text-sm">
                    {([["Valid driver's license", v.has_license], ['Car insurance', v.has_insurance], ['Good driving record', v.has_good_driving_record]] as const).map(([label, ok]) => (
                      <li key={label} className={`flex items-center gap-2 ${ok ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {ok ? <Check className="size-4 text-emerald-600" /> : <X className="size-4" />}{label}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Shield className="size-3" />Self-declared by the driver.</p>
              </div>
            )}
          </div>
        )}

        {target.action && (
          <button
            onClick={() => { target.action!.onClick(); onClose() }}
            disabled={target.action.disabled}
            className="mt-6 w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {target.action.label}
          </button>
        )}
      </div>
    </div>
  )
}
