import { describe, expect, it } from "vitest";
import { formatStepDistance, osrmInstruction, osrmSteps, stripHtml, upcomingManeuver } from "./directions";

describe("turn-by-turn directions", () => {
  const steps = [
    { instruction: "Head north on Elm St", distanceMeters: 400, end: { lat: 39.7036, lng: -121.8 } },
    { instruction: "Turn left onto Main St", distanceMeters: 900, end: { lat: 39.7036, lng: -121.81 } },
    { instruction: "Arrive", distanceMeters: 0, end: { lat: 39.7036, lng: -121.81 } },
  ];

  it("tells the driver the next turn and how far away it is", () => {
    const next = upcomingManeuver(steps, { lat: 39.7, lng: -121.8 }, "Main St pickup");
    expect(next?.text).toBe("Turn left onto Main St");
    expect(next?.inMeters).toBeGreaterThan(380);
    expect(next?.inMeters).toBeLessThan(420);
  });

  it("names the place on the final stretch", () => {
    expect(upcomingManeuver(steps.slice(1), { lat: 39.7036, lng: -121.805 }, "Main St pickup")?.text).toBe("Arrive at Main St pickup");
    expect(upcomingManeuver(steps.slice(0, 1), null, "the drop-off")).toEqual({ text: "Arrive at the drop-off", inMeters: 400 });
  });

  it("has nothing to say without a route", () => {
    expect(upcomingManeuver(undefined, null, "x")).toBeNull();
    expect(upcomingManeuver([], null, "x")).toBeNull();
  });

  it("turns Google's HTML and OSRM's manoeuvre data into plain sentences", () => {
    expect(stripHtml('Turn <b>left</b> onto <b>Main&nbsp;St</b><div style="font-size:0.9em">Destination will be on the right</div>'))
      .toBe("Turn left onto Main St. Destination will be on the right");
    expect(osrmInstruction({ name: "Main St", maneuver: { type: "turn", modifier: "left" } })).toBe("Turn left onto Main St");
    expect(osrmInstruction({ name: "CA-99", maneuver: { type: "turn", modifier: "slight right" } })).toBe("Bear right onto CA-99");
    expect(osrmInstruction({ name: "Elm St", maneuver: { type: "depart" } })).toBe("Head out on Elm St");
    expect(osrmSteps([{ name: "Elm St", distance: 120, maneuver: { type: "depart" }, geometry: { coordinates: [[-121.8, 39.7], [-121.8, 39.701]] } }]))
      .toEqual([{ instruction: "Head out on Elm St", distanceMeters: 120, end: { lat: 39.701, lng: -121.8 } }]);
  });

  it("formats distances the way a driver reads them", () => {
    expect(formatStepDistance(30)).toBe("100 ft");
    expect(formatStepDistance(200)).toBe("650 ft");
    expect(formatStepDistance(1609.344)).toBe("1.0 mi");
    expect(formatStepDistance(40000)).toBe("25 mi");
  });
});
