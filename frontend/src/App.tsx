import { Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './lib/theme'
import { Home } from './pages/home'
import { Auth } from './pages/auth'

export function App() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth/:pathname" element={<Auth />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ThemeProvider>
  )
}
