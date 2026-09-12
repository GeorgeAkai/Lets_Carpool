import { createAuthClient } from '@neondatabase/neon-js/auth'

export const authClient = createAuthClient(import.meta.env.VITE_NEON_AUTH_URL)

// The SDK's generic client.getJWTToken() RPC maps method names to URL path
// segments (e.g. "get-j-w-t-token"), which doesn't match the JWT plugin's
// actual route — confirmed against the real Neon Auth server, where that path
// 404s while GET {authUrl}/token (better-auth's real JWT plugin endpoint)
// returns 401 for an unauthenticated request, i.e. it exists. Call it directly.
export async function fetchNeonJWT(): Promise<string | null> {
  const base = String(import.meta.env.VITE_NEON_AUTH_URL ?? '').replace(/\/+$/, '')
  if (!base) return null
  const res = await fetch(`${base}/token`, { credentials: 'include' })
  if (!res.ok) return null
  const data: unknown = await res.json().catch(() => null)
  const token = (data as { token?: unknown } | null)?.token
  return typeof token === 'string' && token ? token : null
}
