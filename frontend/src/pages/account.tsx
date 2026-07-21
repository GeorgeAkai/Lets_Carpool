import { AccountView } from '@neondatabase/neon-js/auth/react'
import { useParams } from 'react-router-dom'

export function Account() {
  const { pathname } = useParams()
  return (
    <div className="min-h-screen bg-background text-foreground flex items-start justify-center py-10 px-4">
      <div className="w-full max-w-2xl">
        <AccountView pathname={pathname} />
      </div>
    </div>
  )
}
