import { Route, Routes, useNavigate } from 'react-router-dom'
import { NeonAuthUIProvider } from '@neondatabase/neon-js/auth/react'
import { authClient } from './lib/auth'
import { Home } from './pages/home'
import { Auth } from './pages/auth'
import { Account } from './pages/account'

export function App() {
  const navigate = useNavigate()
  return (
    <NeonAuthUIProvider
      authClient={authClient}
      navigate={navigate}
      replace={(href) => navigate(href, { replace: true })}
    >
      <Routes>
        <Route path="/auth/:pathname" element={<Auth />} />
        <Route path="/account/:pathname" element={<Account />} />
        {/* Home owns every app view (/discover, /map, /my-rides, /connections,
            /profile, /admin, …) and derives which one to show from the URL, so a
            single mounted instance keeps its session/feed/connection state across tabs. */}
        <Route path="/*" element={<Home />} />
      </Routes>
    </NeonAuthUIProvider>
  )
}
