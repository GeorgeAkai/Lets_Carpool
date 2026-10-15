import { Route, Routes } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { Home } from './pages/home'
import { Auth } from './pages/auth'
import { Account } from './pages/account'

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <Routes>
        <Route path="/auth/:pathname" element={<Auth />} />
        <Route path="/account/:pathname" element={<Account />} />
        {/* Home owns every app view (/discover, /map, /my-rides, /connections,
            /profile, /admin, …) and derives which one to show from the URL, so a
            single mounted instance keeps its session/feed/connection state across tabs. */}
        <Route path="/*" element={<Home />} />
      </Routes>
    </ThemeProvider>
  )
}
