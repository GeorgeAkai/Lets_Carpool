// A small persistent cache so the app can show the last data it had the moment
// it opens, then swap in fresh data when the server answers. Everything is
// best-effort: private browsing, a full quota or corrupt JSON just mean "no cache".
const PREFIX = "carpool_cache:v1:"

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw == null ? null : (JSON.parse(raw) as T)
  } catch { return null }
}

export function writeCache(key: string, value: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)) }
  catch {
    // Quota exceeded (or storage unavailable): drop this entry rather than keep a stale one.
    try { localStorage.removeItem(PREFIX + key) } catch { /* nothing to do */ }
  }
}

/** Forget everything, e.g. on sign-out, so the next person on this device sees none of it. */
export function clearCache(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch { /* nothing to do */ }
}
