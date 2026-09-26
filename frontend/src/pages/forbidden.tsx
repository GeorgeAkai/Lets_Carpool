import { ShieldAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export function Forbidden() {
  const navigate = useNavigate()
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="size-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
        <ShieldAlert className="size-7 text-destructive" />
      </div>
      <div>
        <p className="text-sm font-semibold text-muted-foreground tracking-wide">403 · FORBIDDEN</p>
        <h1 className="mt-2 text-2xl font-semibold">You don't have access to this page</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-sm">
          This area is restricted to platform administrators. If you think this is a mistake, contact the site owner.
        </p>
      </div>
      <button
        onClick={() => navigate('/discover', { replace: true })}
        className="px-5 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
      >
        Back to the app
      </button>
    </div>
  )
}
