// Short synthesized notification tones (Web Audio) — no audio assets to ship.
// Browsers keep audio locked until the user interacts with the page, so the
// context is created lazily and resumed on the first tap/keypress.

export type SoundName = 'request' | 'accepted' | 'declined' | 'driving' | 'arrived' | 'message' | 'paid'

type Note = { f: number; at: number; dur: number; gain?: number; type?: OscillatorType }

const PATTERNS: Record<SoundName, Note[]> = {
  // Driver: someone wants a ride — two insistent pings.
  request: [{ f: 880, at: 0, dur: 0.14 }, { f: 880, at: 0.2, dur: 0.14 }, { f: 1175, at: 0.4, dur: 0.22 }],
  // Passenger: the driver said yes — rising major arpeggio.
  accepted: [{ f: 523, at: 0, dur: 0.14 }, { f: 659, at: 0.13, dur: 0.14 }, { f: 784, at: 0.26, dur: 0.3 }],
  declined: [{ f: 392, at: 0, dur: 0.18 }, { f: 294, at: 0.18, dur: 0.3 }],
  // Passenger: the driver is on the way.
  driving: [{ f: 659, at: 0, dur: 0.12 }, { f: 988, at: 0.14, dur: 0.12 }, { f: 659, at: 0.28, dur: 0.12 }, { f: 988, at: 0.42, dur: 0.24 }],
  arrived: [{ f: 988, at: 0, dur: 0.12 }, { f: 988, at: 0.18, dur: 0.12 }, { f: 988, at: 0.36, dur: 0.12 }, { f: 1319, at: 0.54, dur: 0.3 }],
  // Chat: one soft blip.
  message: [{ f: 740, at: 0, dur: 0.1, gain: 0.12, type: 'triangle' }, { f: 988, at: 0.09, dur: 0.14, gain: 0.12, type: 'triangle' }],
  paid: [{ f: 784, at: 0, dur: 0.1 }, { f: 1047, at: 0.1, dur: 0.1 }, { f: 1319, at: 0.2, dur: 0.26 }],
}

const MUTE_KEY = 'carpool_sound_muted'

let ctx: AudioContext | null = null
let muted = readMuted()
const listeners = new Set<(m: boolean) => void>()

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined
  if (!Ctor) return null
  try { ctx = new Ctor() } catch { return null }
  return ctx
}

/** Call once; unlocks audio on the first user gesture. */
export function installSoundUnlock(): () => void {
  if (typeof window === 'undefined') return () => {}
  const unlock = () => { void getCtx()?.resume() }
  const events = ['pointerdown', 'keydown', 'touchstart'] as const
  events.forEach(e => window.addEventListener(e, unlock, { passive: true }))
  return () => events.forEach(e => window.removeEventListener(e, unlock))
}

export function isMuted(): boolean { return muted }

export function setMuted(value: boolean): void {
  muted = value
  try { localStorage.setItem(MUTE_KEY, value ? '1' : '0') } catch { /* storage unavailable */ }
  listeners.forEach(l => l(value))
}

export function subscribeMuted(fn: (m: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function playSound(name: SoundName): void {
  if (muted) return
  const c = getCtx()
  if (!c) return
  void c.resume().catch(() => {})
  const start = c.currentTime + 0.01
  for (const n of PATTERNS[name]) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    const peak = n.gain ?? 0.18
    osc.type = n.type ?? 'sine'
    osc.frequency.value = n.f
    gain.gain.setValueAtTime(0.0001, start + n.at)
    gain.gain.exponentialRampToValueAtTime(peak, start + n.at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.at + n.dur)
    osc.connect(gain).connect(c.destination)
    osc.start(start + n.at)
    osc.stop(start + n.at + n.dur + 0.02)
  }
  // Short haptic buzz on phones that support it.
  try { navigator.vibrate?.(name === 'message' ? 40 : [60, 40, 60]) } catch { /* unsupported */ }
}

/** Map a backend notification type to a sound (or null for silent). */
export function soundForNotification(type: string): SoundName | null {
  if (type === 'connection_received') return 'request'
  if (type.includes('accepted') || type === 'chat_unlocked') return 'accepted'
  if (type.includes('declined')) return 'declined'
  if (type === 'ride_started') return 'driving'
  if (type.includes('arrived') || type.includes('at_pickup')) return 'arrived'
  if (type === 'payment_processed' || type === 'gas_split_confirmed') return 'paid'
  if (type === 'chat_message') return 'message'
  return null
}
