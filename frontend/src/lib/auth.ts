import { createClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
if (!url || !anonKey) {
  console.warn('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — sign-in will not work.')
}

// createClient throws on an empty URL, which would white-screen the whole app
// instead of just failing sign-in, so fall back to inert placeholders.
export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'missing-anon-key')

export type AuthSession = { user: { id: string; email: string } } | null

export function useAuthSession(): { session: AuthSession; isPending: boolean } {
  const [state, setState] = useState<{ session: AuthSession; isPending: boolean }>({ session: null, isPending: true })

  useEffect(() => {
    const toSession = (s: { user: { id: string; email?: string } } | null): AuthSession =>
      s ? { user: { id: s.user.id, email: s.user.email ?? '' } } : null
    supabase.auth.getSession().then(({ data }) => setState({ session: toSession(data.session), isPending: false }))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setState({ session: toSession(s), isPending: false }))
    return () => sub.subscription.unsubscribe()
  }, [])

  return state
}

// The backend verifies this JWT's signature itself (see /auth/login).
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}
