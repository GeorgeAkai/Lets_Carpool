import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// Light/dark theme, applied as the `dark` class on <html> (theme.css keys off
// it) and remembered in localStorage under the same `theme` key the previous
// next-themes setup used, so existing users keep their choice. With no saved
// choice it follows the OS setting.

type Theme = 'light' | 'dark' | 'system'
type Resolved = 'light' | 'dark'

const STORAGE_KEY = 'theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}

function systemTheme(): Resolved {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light'
}

const ThemeContext = createContext<{ resolvedTheme: Resolved; setTheme: (t: Theme) => void }>({
  resolvedTheme: 'light', setTheme: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [system, setSystem] = useState<Resolved>(systemTheme)
  const resolvedTheme: Resolved = theme === 'system' ? system : theme

  useEffect(() => {
    const mql = window.matchMedia?.(DARK_QUERY)
    if (!mql) return
    const onChange = () => setSystem(mql.matches ? 'dark' : 'light')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try { t === 'system' ? localStorage.removeItem(STORAGE_KEY) : localStorage.setItem(STORAGE_KEY, t) } catch { /* private mode */ }
  }, [])

  const value = useMemo(() => ({ resolvedTheme, setTheme }), [resolvedTheme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
