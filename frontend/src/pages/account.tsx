import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, useAuthSession } from '../lib/auth'

const INPUT = 'w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary'

export function Account() {
  const { session } = useAuthSession()
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setMessage(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setMessage(error.message)
    else { setMessage('Password updated.'); setPassword('') }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-start justify-center py-10 px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-card p-7">
        <div>
          <h1 className="text-xl font-semibold">Account</h1>
          <p className="mt-1 text-sm text-muted-foreground">{session?.user.email ?? 'Not signed in'}</p>
        </div>
        {session && (
          <form onSubmit={changePassword} className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="new-password">New password</label>
            <input id="new-password" type="password" minLength={8} required autoComplete="new-password"
              className={INPUT} value={password} onChange={e => setPassword(e.target.value)} />
            <button disabled={busy} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60">Update password</button>
            {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
          </form>
        )}
        <Link to="/" className="inline-block text-sm underline underline-offset-2 text-muted-foreground hover:text-foreground">Back to app</Link>
      </div>
    </div>
  )
}
