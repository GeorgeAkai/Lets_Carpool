import { Route, Routes } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { Home } from './pages/home'
import { Auth } from './pages/auth'
import { Account } from './pages/account'

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth/:pathname" element={<Auth />} />
        <Route path="/account/:pathname" element={<Account />} />
      </Routes>
    </ThemeProvider>
  )
}
