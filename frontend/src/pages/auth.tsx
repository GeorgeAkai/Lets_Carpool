import { Car, Fuel, MapPin, Shield } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useState, type CSSProperties } from 'react'
import { supabase } from '../lib/auth'

const SERIF: CSSProperties = { fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontWeight: 700, letterSpacing: '-0.02em' }

const FEATURES = [
  { Icon: MapPin, title: 'Nearby matches', desc: 'Rides near your location' },
  { Icon: Fuel,   title: 'Gas split',      desc: 'Automated cost sharing'  },
  { Icon: Shield, title: 'Verified passengers', desc: 'Email-verified community' },
] as const

const INPUT = 'w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary'

type Mode = 'sign-in' | 'sign-up' | 'forgot-password'

function AuthForm({ mode }: { mode: Mode }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(null); setNotice(null)
    try {
      if (mode === 'sign-in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        navigate('/', { replace: true })
      } else if (mode === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({
          email, password, options: { data: { name }, emailRedirectTo: window.location.origin },
        })
        if (error) throw error
        // With email confirmation enabled Supabase returns no session yet.
        if (data.session) navigate('/', { replace: true })
        else setNotice('Check your email to confirm your account, then sign in.')
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/account/settings` })
        if (error) throw error
        setNotice('If that email has an account, a reset link is on its way.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : 'Reset password'
  return (
    <form onSubmit={submit} className="grid w-full gap-4">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {mode === 'sign-up' && (
        <input aria-label="Name" placeholder="Name" required className={INPUT} value={name} onChange={e => setName(e.target.value)} />
      )}
      <input aria-label="Email" type="email" placeholder="you@example.com" required autoComplete="email" className={INPUT}
        value={email} onChange={e => setEmail(e.target.value)} />
      {mode !== 'forgot-password' && (
        <input aria-label="Password" type="password" placeholder="Password" required minLength={8}
          autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} className={INPUT}
          value={password} onChange={e => setPassword(e.target.value)} />
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
      <button type="submit" disabled={busy} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60">
        {busy ? 'Please wait…' : title}
      </button>
      <div className="flex justify-between text-xs text-muted-foreground">
        {mode === 'sign-in' ? (
          <>
            <Link className="underline underline-offset-2" to="/auth/sign-up">Create account</Link>
            <Link className="underline underline-offset-2" to="/auth/forgot-password">Forgot password?</Link>
          </>
        ) : (
          <Link className="underline underline-offset-2" to="/auth/sign-in">Back to sign in</Link>
        )}
      </div>
    </form>
  )
}

export function Auth() {
  const { pathname } = useParams()

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">

      {/* Decorative blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-48 -left-48 size-[36rem] rounded-full bg-primary/[0.07] blur-3xl" />
        <div className="absolute -bottom-48 -right-48 size-[36rem] rounded-full bg-primary/[0.05] blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '28px 28px' }}
        />
      </div>

      {/* Centered content column */}
      <div className="relative w-full max-w-sm mx-auto flex flex-col gap-6">

        {/* Brand header */}
        <div className="text-center">
          <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary mb-4 shadow-lg shadow-primary/20">
            <Car className="size-6 text-primary-foreground" />
          </div>
          <h1 style={SERIF} className="text-3xl sm:text-4xl text-foreground leading-tight">Let's Carpool</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Connect with drivers and passengers near you.</p>
        </div>

        {/* Auth card */}
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="p-7">
            <AuthForm mode={pathname === 'sign-up' || pathname === 'forgot-password' ? pathname : 'sign-in'} />
          </div>
        </div>

        {/* Feature tiles */}
        <div className="grid grid-cols-3 gap-3">
          {FEATURES.map(({ Icon, title, desc }) => (
            <div key={title} className="flex flex-col items-center gap-2 rounded-xl bg-secondary p-3 text-center">
              <div className="flex size-8 items-center justify-center rounded-xl bg-card/70">
                <Icon className="size-4 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground">{title}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          By continuing you agree to our{' '}
          <span className="underline underline-offset-2 cursor-pointer hover:text-foreground transition-colors">Terms</span>
          {' & '}
          <span className="underline underline-offset-2 cursor-pointer hover:text-foreground transition-colors">Privacy Policy</span>.
        </p>

      </div>
    </div>
  )
}
