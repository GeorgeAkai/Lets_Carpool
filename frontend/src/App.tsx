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
        <Route path="/" element={<Home />} />
        <Route path="/auth/:pathname" element={<Auth />} />
        <Route path="/account/:pathname" element={<Account />} />
      </Routes>
    </NeonAuthUIProvider>
  )
}
