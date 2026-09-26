import { useEffect, useState } from "react"

// Below the `xl` Tailwind breakpoint (1280px) already used to switch between
// the mobile BottomNav and the desktop Sidebar layout — kept as a JS flag
// (not a CSS-only toggle) for components that fetch/poll/subscribe, so a
// hidden desktop copy doesn't still run those side effects in the background.
const MOBILE_QUERY = "(max-width: 1279px)"

export function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = () => setIsMobile(mql.matches)
    handler()
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [query])

  return isMobile
}
