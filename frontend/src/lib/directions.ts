// Turn-by-turn helpers for the driver's navigation panel. A route's steps each
// describe the manoeuvre at their start ("Turn left onto Main St") and how far
// to travel after it, which is how both Google Directions and OSRM report them.
import { metersBetween } from "./geo"
import type { LatLng } from "./geo"

export interface RouteStep {
  instruction: string
  distanceMeters: number
  /** Where this step ends, i.e. where the next manoeuvre happens. */
  end: LatLng
}

export function stripHtml(html: string): string {
  return html.replace(/<div[^>]*>/gi, ". ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
}

type OsrmStep = { name?: string; distance?: number; maneuver?: { type?: string; modifier?: string }; geometry?: { coordinates?: number[][] } }

/** A plain-English instruction for one OSRM step (OSRM sends data, not sentences). */
export function osrmInstruction(step: OsrmStep): string {
  const type = step.maneuver?.type ?? ""
  const modifier = step.maneuver?.modifier ?? ""
  const onto = step.name ? ` onto ${step.name}` : ""
  const on = step.name ? ` on ${step.name}` : ""
  if (type === "depart") return `Head out${on}`
  if (type === "arrive") return "Arrive"
  if (type === "roundabout" || type === "rotary") return `Take the roundabout${onto}`
  if (type === "merge") return `Merge${onto}`
  if (type === "on ramp") return `Take the ramp${onto}`
  if (type === "off ramp") return `Take the exit${onto}`
  if (type === "fork") return `Keep ${modifier.includes("left") ? "left" : "right"}${onto}`
  if (modifier === "uturn") return "Make a U-turn"
  if (modifier === "straight" || !modifier) return `Continue${on}`
  return `${modifier.startsWith("slight") ? "Bear" : modifier.startsWith("sharp") ? "Turn sharp" : "Turn"} ${modifier.replace(/^(slight|sharp) /, "")}${onto}`
}

export function osrmSteps(steps: OsrmStep[]): RouteStep[] {
  return steps.flatMap(s => {
    const last = s.geometry?.coordinates?.at(-1)
    return last ? [{ instruction: osrmInstruction(s), distanceMeters: s.distance ?? 0, end: { lat: last[1], lng: last[0] } }] : []
  })
}

export function formatStepDistance(meters: number): string {
  const feet = meters * 3.28084
  if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`
  const miles = meters / 1609.344
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`
}

/**
 * What the driver does next, given a route that starts at (or very near) where
 * they are now: the manoeuvre at the end of the current step and how far away
 * it is. On the last step that is the arrival.
 */
export function upcomingManeuver(steps: RouteStep[] | undefined, pos: LatLng | null, arriveAt: string): { text: string; inMeters: number } | null {
  if (!steps || steps.length === 0) return null
  const current = steps[0]
  const inMeters = pos ? metersBetween(pos, current.end) : current.distanceMeters
  const next = steps[1]
  // Routing services end with their own "arrive" step; name the place instead.
  const arriving = !next || /^(arrive|you have arrived|destination)/i.test(next.instruction)
  return { text: arriving ? `Arrive at ${arriveAt}` : next.instruction, inMeters }
}
