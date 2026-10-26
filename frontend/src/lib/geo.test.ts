import { describe, expect, it } from "vitest";
import { metersBetween, snapToPath } from "./geo";

// A straight east–west road at lat 40.
const road = [{ lat: 40, lng: -100 }, { lat: 40, lng: -99.99 }, { lat: 40, lng: -99.98 }];

describe("snapToPath", () => {
  it("pulls a nearby GPS point onto the road", () => {
    const p = { lat: 40.0002, lng: -99.995 } // ~22 m north of the road
    const s = snapToPath(road, p);
    expect(s.lat).toBeCloseTo(40, 6);
    expect(s.lng).toBeCloseTo(-99.995, 5);
  });

  it("leaves points far from the route alone", () => {
    const p = { lat: 40.002, lng: -99.995 } // ~220 m away
    expect(snapToPath(road, p)).toEqual(p);
  });

  it("clamps to the route's ends and tolerates short paths", () => {
    const s = snapToPath(road, { lat: 40.0001, lng: -100.0003 });
    expect(s.lng).toBeCloseTo(-100, 5);
    const p = { lat: 1, lng: 1 };
    expect(snapToPath([], p)).toBe(p);
    expect(snapToPath([road[0]], p)).toBe(p);
  });

  it("measures distance", () => {
    expect(metersBetween({ lat: 40, lng: -100 }, { lat: 40.001, lng: -100 })).toBeGreaterThan(100);
  });
});
