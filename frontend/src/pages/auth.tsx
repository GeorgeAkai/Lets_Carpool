import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, Car, Check, Eye, EyeOff, Fuel, MapPin, Shield } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { isAuthConfigured, sendPasswordReset, signIn, signUp, updatePassword } from '../lib/auth'

const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }

const FEATURES = [
  { Icon: MapPin, title: 'Nearby matches', desc: 'Rides near your location' },
  { Icon: Fuel,   title: 'Gas split',      desc: 'Automated cost sharing'  },
  { Icon: Shield, title: 'Verified riders', desc: 'Email-verified community' },
] as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const inputCls = (hasError: boolean) =>
  `w-full rounded-xl px-4 py-3 text-sm border transition-colors focus:outline-none focus:ring-3 ${
    hasError ? 'border-destructive bg-destructive/5 focus:ring-destructive/15' : 'bg-input-background border-border focus:border-primary focus:ring-primary/15'
  }`

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.'
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first — check your inbox for the link.'
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Try signing in.'
  return msg || 'Something went wrong. Please try again.'
}

function Field({ id, label, error, hint, right, children }: {
  id: string; label: ReactNode; error?: string; hint?: string; right?: ReactNode; children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-semibold text-foreground">{label}</label>
        {right}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-center gap-1.5 text-xs text-destructive"><AlertCircle className="size-3.5 shrink-0" />{error}</p>
      ) : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function PasswordInput({ id, value, onChange, placeholder, autoComplete, error }: {
  id: string; value: string; onChange: (v: string) => void; placeholder: string; autoComplete: string; error?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        id={id} type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} autoComplete={autoComplete} aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${inputCls(!!error)} pr-11`}
      />
      <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary transition-colors">
        {show ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
      </button>
    </div>
  )
}

function passwordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0
  if (pw.length >= 8) score++
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (score <= 1) return { score, label: 'Weak', color: 'bg-destructive' }
  if (score === 2) return { score, label: 'Fair', color: 'bg-amber-500' }
  if (score === 3) return { score, label: 'Good', color: 'bg-blue-600' }
  return { score, label: 'Strong', color: 'bg-emerald-600' }
}

function StrengthMeter({ password }: { password: string }) {
  if (!password) return null
  const { score, label, color } = passwordStrength(password)
  return (
    <div className="mt-1">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4].map(i => <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= score ? color : 'bg-border'}`} />)}
      </div>
      <p className="text-xs text-muted-foreground">{label} password</p>
    </div>
  )
}

function SubmitButton({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={loading}
      className="w-full py-3.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold shadow-lg shadow-primary/30 hover:bg-primary/90 disabled:opacity-60 disabled:shadow-none transition-all flex items-center justify-center gap-2">
      {loading && <span className="size-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />}
      {loading ? 'Please wait…' : children}
    </button>
  )
}

function FormAlert({ tone = 'error', children }: { tone?: 'error' | 'success'; children: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2.5 rounded-xl px-4 py-3 mb-5 text-sm border ${
      tone === 'error' ? 'bg-destructive/10 text-destructive border-destructive/20' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20'
    }`}>
      {tone === 'error' ? <AlertCircle className="size-4 shrink-0 mt-0.5" /> : <Check className="size-4 shrink-0 mt-0.5" />}
      <span>{children}</span>
    </div>
  )
}

function CardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-bold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
    </div>
  )
}

function SignInForm() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({})
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!email) next.email = 'Email is required.'
    else if (!EMAIL_RE.test(email)) next.email = 'Enter a valid email address.'
    if (!password) next.password = 'Password is required.'
    setErrors(next)
    if (Object.keys(next).length) return
    setLoading(true)
    try { await signIn(email.trim(), password); navigate('/', { replace: true }) }
    catch (err) { setErrors({ form: errorMessage(err) }) }
    finally { setLoading(false) }
  }

  return (
    <>
      <CardHeader title="Sign In" subtitle="Welcome back — enter your credentials to continue." />
      {errors.form && <FormAlert>{errors.form}</FormAlert>}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="signin-email" label="Email" error={errors.email}>
          <input id="signin-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
            autoComplete="email" aria-invalid={!!errors.email} className={inputCls(!!errors.email)} />
        </Field>
        <Field id="signin-password" label="Password" error={errors.password}
          right={<Link to="/auth/forgot-password" className="text-xs font-medium text-primary hover:underline">Forgot your password?</Link>}>
          <PasswordInput id="signin-password" value={password} onChange={setPassword} placeholder="Enter your password" autoComplete="current-password" error={errors.password} />
        </Field>
        <SubmitButton loading={loading}>Sign In</SubmitButton>
      </form>
      <p className="text-center text-sm text-muted-foreground mt-5">
        Don't have an account? <Link to="/auth/sign-up" className="font-semibold text-primary hover:underline">Sign Up</Link>
      </p>
    </>
  )
}

function SignUpForm() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string; form?: string }>({})
  const [loading, setLoading] = useState(false)
  const [confirmSentTo, setConfirmSentTo] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Full name is required.'
    if (!email) next.email = 'Email is required.'
    else if (!EMAIL_RE.test(email)) next.email = 'Enter a valid email address.'
    if (!password) next.password = 'Password is required.'
    else if (password.length < 8) next.password = 'Password must be at least 8 characters.'
    setErrors(next)
    if (Object.keys(next).length) return
    setLoading(true)
    try {
      const { needsConfirmation } = await signUp(name.trim(), email.trim(), password)
      if (needsConfirmation) setConfirmSentTo(email.trim())
      else navigate('/', { replace: true })
    } catch (err) { setErrors({ form: errorMessage(err) }) }
    finally { setLoading(false) }
  }

  if (confirmSentTo) {
    return (
      <>
        <CardHeader title="Check your email" subtitle={`We sent a confirmation link to ${confirmSentTo}.`} />
        <p className="text-sm text-muted-foreground">Open the link to activate your account, then come back and sign in.</p>
        <Link to="/auth/sign-in" className="mt-6 block text-center w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">Back to sign in</Link>
      </>
    )
  }

  return (
    <>
      <CardHeader title="Create your account" subtitle="Join commuters sharing rides near you." />
      {errors.form && <FormAlert>{errors.form}</FormAlert>}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="signup-name" label="Full name" error={errors.name}>
          <input id="signup-name" value={name} onChange={e => setName(e.target.value)} placeholder="Alex Johnson"
            autoComplete="name" aria-invalid={!!errors.name} className={inputCls(!!errors.name)} />
        </Field>
        <Field id="signup-email" label="Email" error={errors.email}>
          <input id="signup-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
            autoComplete="email" aria-invalid={!!errors.email} className={inputCls(!!errors.email)} />
        </Field>
        <Field id="signup-password" label="Password" error={errors.password}>
          <PasswordInput id="signup-password" value={password} onChange={setPassword} placeholder="Minimum 8 characters" autoComplete="new-password" error={errors.password} />
          {!errors.password && <StrengthMeter password={password} />}
        </Field>
        <SubmitButton loading={loading}>Create account</SubmitButton>
      </form>
      <p className="text-center text-sm text-muted-foreground mt-5">
        Already have an account? <Link to="/auth/sign-in" className="font-semibold text-primary hover:underline">Sign In</Link>
      </p>
    </>
  )
}

function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!EMAIL_RE.test(email)) { setError('Enter a valid email address.'); return }
    setError(undefined); setLoading(true)
    try { await sendPasswordReset(email.trim()); setSent(true) }
    catch (err) { setError(errorMessage(err)) }
    finally { setLoading(false) }
  }

  return (
    <>
      <CardHeader title="Reset your password" subtitle="We'll email you a link to choose a new one." />
      {sent ? (
        <FormAlert tone="success">If an account exists for {email}, a reset link is on its way.</FormAlert>
      ) : (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="forgot-email" label="Email" error={error}>
            <input id="forgot-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
              autoComplete="email" aria-invalid={!!error} className={inputCls(!!error)} />
          </Field>
          <SubmitButton loading={loading}>Send reset link</SubmitButton>
        </form>
      )}
      <p className="text-center text-sm text-muted-foreground mt-5">
        <Link to="/auth/sign-in" className="font-semibold text-primary hover:underline">Back to sign in</Link>
      </p>
    </>
  )
}

// Landing page for the emailed reset link — Supabase signs the user in from
// the link's token, so all that's left is choosing the new password.
function ResetPasswordForm() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setError(undefined); setLoading(true)
    try { await updatePassword(password); navigate('/', { replace: true }) }
    catch (err) { setError(errorMessage(err)) }
    finally { setLoading(false) }
  }

  return (
    <>
      <CardHeader title="Choose a new password" subtitle="Enter a new password for your account." />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="reset-password" label="New password" error={error}>
          <PasswordInput id="reset-password" value={password} onChange={setPassword} placeholder="Minimum 8 characters" autoComplete="new-password" error={error} />
          {!error && <StrengthMeter password={password} />}
        </Field>
        <SubmitButton loading={loading}>Update password</SubmitButton>
      </form>
    </>
  )
}

export function Auth() {
  const { pathname } = useParams()

  const form = !isAuthConfigured ? (
    <FormAlert>Sign-in isn't configured yet: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for the frontend.</FormAlert>
  ) : pathname === 'sign-up' ? <SignUpForm />
    : pathname === 'forgot-password' ? <ForgotPasswordForm />
    : pathname === 'reset-password' ? <ResetPasswordForm />
    : <SignInForm />

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
          <p className="mt-1.5 text-sm text-muted-foreground">Connect with drivers and riders near you.</p>
        </div>

        {/* Auth card */}
        <div className="rounded-2xl border border-border bg-card shadow-sm p-7">
          {form}
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
