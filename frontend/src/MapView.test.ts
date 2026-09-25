import { describe, expect, it } from "vitest"
import { lerp, lerpAngle, lerpLatLng } from "./MapView"

describe("lerp", () => {
  it("interpolates linearly between two values", () => {
    expect(lerp(0, 10, 0)).toBe(0)
    expect(lerp(0, 10, 1)).toBe(10)
    expect(lerp(0, 10, 0.5)).toBe(5)
  })
})

describe("lerpLatLng", () => {
  it("interpolates both coordinates independently", () => {
    expect(lerpLatLng([38.9, -77.4], [39.1, -77.0], 0.5)).toEqual([39.0, -77.2])
  })

  it("returns the start point at t=0 and the end point at t=1", () => {
    const a: [number, number] = [10, 20]
    const b: [number, number] = [30, 40]
    expect(lerpLatLng(a, b, 0)).toEqual(a)
    expect(lerpLatLng(a, b, 1)).toEqual(b)
  })
})

describe("lerpAngle", () => {
  it("interpolates directly when there is no wraparound", () => {
    expect(lerpAngle(10, 50, 0.5)).toBeCloseTo(30)
  })

  it("takes the short way around the 0/360 boundary instead of the long way", () => {
    // 350 -> 10 is a 20 degree turn through 0, not a 340 degree turn the other way
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(350, 10, 1)).toBeCloseTo(10)
  })

  it("takes the short way around when going from a small angle to a large one", () => {
    // 10 -> 350 is a -20 degree turn through 0, not +340
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(10, 350, 1)).toBeCloseTo(350)
  })

  it("keeps the result within [0, 360)", () => {
    const result = lerpAngle(350, 10, 0.9)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThan(360)
  })
})
