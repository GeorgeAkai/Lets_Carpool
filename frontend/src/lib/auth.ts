import { useEffect, useState } from 'react'
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

// Sign-in runs on Supabase Auth. The backend never trusts a client-supplied
// email/name: it verifies the Supabase access token's signature itself
// (see backend/app/auth.py) before issuing its own session token.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// createClient throws on an empty URL, which would blank the whole app — keep
// the client null instead and let the sign-in screen explain what's missing.
export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null

export const isAuthConfigured = supabase !== null

export type AuthUser = { id: string; email: string }

function toAuthUser(session: Session | null): AuthUser | null {
  const u = session?.user
  return u && u.email ? { id: u.id, email: u.email } : null
}

function requireClient(): SupabaseClient {
  if (!supabase) throw new Error('Sign-in is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).')
  return supabase
}

// Current Supabase session user, kept live across sign-in, sign-out and
// token refresh. isPending stays true until the stored session is restored.
export function useAuthSession(): { user: AuthUser | null; isPending: boolean } {
  const [state, setState] = useState<{ user: AuthUser | null; isPending: boolean }>({ user: null, isPending: isAuthConfigured })

  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ user: toAuthUser(data.session), isPending: false })
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setState({ user: toAuthUser(session), isPending: false })
    })
    return () => { active = false; sub.subscription.unsubscribe() }
  }, [])

  return state
}

// The Supabase access token the backend's /auth/login verifies.
export async function getAccessToken(): Promise<string | null> {
  const { data, error } = await requireClient().auth.getSession()
  if (error) throw error
  return data.session?.access_token ?? null
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await requireClient().auth.signInWithPassword({ email, password })
  if (error) throw error
}

// Resolves needsConfirmation when the Supabase project requires email
// confirmation — no session exists until the link in that email is opened.
export async function signUp(name: string, email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await requireClient().auth.signUp({
    email, password,
    options: { data: { full_name: name }, emailRedirectTo: window.location.origin },
  })
  if (error) throw error
  return { needsConfirmation: !data.session }
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await requireClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset-password`,
  })
  if (error) throw error
}

export async function updatePassword(password: string): Promise<void> {
  const { error } = await requireClient().auth.updateUser({ password })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  if (!supabase) return
  await supabase.auth.signOut()
}
