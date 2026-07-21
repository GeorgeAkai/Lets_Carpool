import { AuthView } from '@neondatabase/neon-js/auth/react'
import { Car, Fuel, MapPin, Shield } from 'lucide-react'
import { useParams } from 'react-router-dom'
import type { CSSProperties } from 'react'

const SERIF: CSSProperties = { fontFamily: "'DM Serif Display', serif" }

const FEATURES = [
  { Icon: MapPin, title: 'Nearby matches', desc: 'Rides near your location' },
  { Icon: Fuel,   title: 'Gas split',      desc: 'Automated cost sharing'  },
  { Icon: Shield, title: 'Verified riders', desc: 'Email-verified community' },
] as const

export function Auth() {
  const { pathname } = useParams()

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">

      {/* Decorative blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-48 -left-48 size-[36rem] rounded-full bg-primary/[0.07] blur-3xl" />
        <div className="absolute -bottom-48 -right-48 size-[36rem] rounded-full bg-primary/[0.05] blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '28px 28px' }}
        />
      </div>

      {/* Centered content column */}
      <div className="relative w-full max-w-[440px] mx-auto flex flex-col gap-6">

        {/* Brand header */}
        <div className="text-center">
          <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary mb-4 shadow-lg shadow-primary/20">
            <Car className="size-6 text-primary-foreground" />
          </div>
          <h1 style={SERIF} className="text-3xl sm:text-4xl text-foreground leading-tight">Let's Carpool</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Connect with drivers and riders near you.</p>
        </div>

        {/* Auth card */}
        <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-2xl shadow-foreground/[0.06]">
          <div className="p-7">
            <AuthView pathname={pathname} />
          </div>
        </div>

        {/* Feature tiles */}
        <div className="grid grid-cols-3 gap-3">
          {FEATURES.map(({ Icon, title, desc }) => (
            <div key={title} className="flex flex-col items-center gap-2 rounded-2xl bg-muted/60 p-3 text-center">
              <div className="flex size-8 items-center justify-center rounded-xl bg-primary/10">
                <Icon className="size-4 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground">{title}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          By continuing you agree to our{' '}
          <span className="underline underline-offset-2 cursor-pointer hover:text-foreground transition-colors">Terms</span>
          {' & '}
          <span className="underline underline-offset-2 cursor-pointer hover:text-foreground transition-colors">Privacy Policy</span>.
        </p>

      </div>
    </div>
  )
}
