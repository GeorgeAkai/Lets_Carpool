import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { BASE } from "../api";
import { setMockAuthSession } from "../test-support/authMock";

// After the driver accepts: directions to the pickup, then the same map leads
// to the passenger's drop-off, then the ride is completed. The passenger's page
// follows along from its own poll.

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const loc = (id: string, label: string, latitude = 39.7, longitude = -121.8) => ({ id, label, exact: true, latitude, longitude });

const ME = {
  id: "usr_me", email: "sam@example.com", email_domain: "example.com", status: "active", onboarded_at: "2026-01-01T00:00:00Z",
  profile: { user_id: "usr_me", display_name: "Sam Driver", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
  vehicle: { user_id: "usr_me", make: "Honda", model: "Fit", color: "Red", seats: 5, car_type: "sedan", has_license: true, has_insurance: true, has_good_driving_record: true },
};
const TRIP = {
  id: "trp_x", driver_id: "usr_me", driver_name: "Sam Driver", driver_photo_url: null,
  pickup: loc("a", "Elm St, Chico, CA"), destination: loc("b", "Sacramento, CA", 38.58, -121.49),
  target_date: today, flexibility: "morning", seats_available: 3, seats_reserved: 0, tags: [], status: "open",
  created_at: iso(60), luggage_capacity: "medium", car_type: "sedan", notes: null,
};
const REQUEST = {
  id: "rrq_1", rider_id: "usr_rae", rider_name: "Rae Rider", rider_photo_url: null,
  pickup: loc("p", "Main St, Chico, CA", 39.73, -121.84), destination: loc("d", "Capitol Mall, Sacramento, CA", 38.5766, -121.4934),
  target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "open", created_at: iso(30),
  luggage_size: "none", preferred_car_type: null, notes: null,
};
const ride = (over: Record<string, unknown> = {}) => ({
  id: "con_1", ride_request_id: "rrq_1", driver_trip_id: "trp_x", initiator_user_id: "usr_rae", status: "accepted",
  created_at: iso(20), updated_at: iso(1), ride_request: REQUEST, driver_trip: TRIP,
  rider_profile: { ...ME.profile, user_id: "usr_rae", display_name: "Rae Rider" }, driver_profile: { ...ME.profile },
  my_rating: null, fare: { amount_cents: 850, currency: "USD", distance_km: 120.4, passengers: 1, status: "estimated" },
  ...over,
});

// A two-turn route, as the open routing fallback returns it.
const OSRM = (toLng: string) => ({
  code: "Ok",
  routes: [{
    geometry: { type: "LineString", coordinates: [[-121.8, 39.7], [-121.8, 39.71], [Number(toLng), 39.71]] },
    legs: [{ distance: 4200, duration: 540, steps: [
      { name: "Elm St", distance: 1100, maneuver: { type: "depart" }, geometry: { coordinates: [[-121.8, 39.7], [-121.8, 39.71]] } },
      { name: toLng === "-121.84" ? "Main St" : "Capitol Mall", distance: 3100, maneuver: { type: "turn", modifier: "left" }, geometry: { coordinates: [[-121.8, 39.71], [Number(toLng), 39.71]] } },
      { name: "", distance: 0, maneuver: { type: "arrive" }, geometry: { coordinates: [[Number(toLng), 39.71]] } },
    ] }],
  }],
});

type Handler = (body: unknown) => unknown;
function stubApi(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ key: string; body: unknown; url: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const raw = String(url);
    if (raw.includes("router.project-osrm.org")) {
      calls.push({ key: "ROUTE", body: undefined, url: raw });
      const toLng = raw.split("/driving/")[1].split(";")[1].split(",")[0];
      return { ok: true, status: 200, json: async () => OSRM(toLng) };
    }
    const key = `${(init?.method ?? "GET").toUpperCase()} ${raw.replace(BASE, "").split("?")[0]}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body, url: raw });
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    const r = routes[key];
    return { ok: true, status: 200, json: async () => (typeof r === "function" ? (r as Handler)(body) : r) };
  }));
  return calls;
}

const BASE_ROUTES = {
  "GET /me": ME, "GET /driver-trips/search": [], "GET /ride-requests/search": [], "GET /me/routes": [],
  "GET /notifications": [], "GET /me/driver-trips": [], "GET /me/ride-requests": [], "GET /connections/con_1/messages": [],
};
const LIVE = {
  connection_id: "con_1", pickup: { label: "Main St, Chico, CA", latitude: 39.73, longitude: -121.84 },
  destination: { label: "Capitol Mall, Sacramento, CA", latitude: 38.5766, longitude: -121.4934 },
  departure_time: null, driver: null, rider_at_pickup_at: null, picked_up_at: null, driver_started_at: null,
};

function signIn(mode: "rider" | "driver") {
  localStorage.setItem("carpool_token", "tok");
  setMockAuthSession({ user: { id: "sb_me", email: ME.email, name: ME.profile.display_name } });
  sessionStorage.setItem("carpool_mode", mode);
}
const phone = () => { window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia; };

const originalMatchMedia = window.matchMedia;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); phone(); });
afterEach(() => { vi.unstubAllGlobals(); window.matchMedia = originalMatchMedia; });

describe("Driver, from accept to drop-off", () => {
  it("gets directions to the pickup, then to the passenger's destination, then completes the ride", async () => {
    const user = userEvent.setup();
    signIn("driver");
    let state: Record<string, unknown> = { status: "pending" };
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": () => [ride(state)],
      "GET /connections/con_1/live": () => ({ ...LIVE, picked_up_at: state.picked_up_at ?? null, driver_started_at: state.driver_started_at ?? null }),
      "POST /connections/con_1/transition": (body: unknown) => { state = { ...state, status: (body as { action: string }).action === "accept" ? "accepted" : "completed" }; return ride(state); },
      "POST /connections/con_1/start-trip": () => { state = { ...state, driver_started_at: iso(0) }; return ride(state); },
      "POST /connections/con_1/picked-up": () => { state = { ...state, picked_up_at: iso(0) }; return ride(state); },
    });
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    // Accept → the trip page, with the next step as the main button.
    await user.click(await screen.findByRole("button", { name: /^accept$/i }));
    await user.click(await screen.findByRole("button", { name: /start trip/i }));
    await waitFor(() => expect(calls.some(c => c.key === "POST /connections/con_1/start-trip")).toBe(true));

    // The map: a route to the passenger's pickup with the next turn spelled out,
    // even though this browser has no GPS.
    expect(await screen.findByText(/picking up/i)).toBeTruthy();
    expect((await screen.findAllByText("Turn left onto Main St")).length).toBe(2); // the next-turn banner and the step list
    expect(screen.getByText(/all directions \(3 steps\)/i)).toBeTruthy();
    const toPickup = calls.find(c => c.key === "ROUTE")!;
    expect(toPickup.url).toContain("-121.84,39.73");
    expect((screen.getByRole("link", { name: /open in google maps/i }) as HTMLAnchorElement).href).toContain("destination=39.73,-121.84");

    // Passenger gets in: the same map now leads to the drop-off they asked for.
    await user.click(screen.getByRole("button", { name: /rae is in the car · go to drop-off/i }));
    await waitFor(() => expect(calls.some(c => c.key === "POST /connections/con_1/picked-up")).toBe(true));
    expect(await screen.findByText(/dropping off/i)).toBeTruthy();
    expect((await screen.findAllByText("Turn left onto Capitol Mall")).length).toBe(2); // the next-turn banner and the step list
    await waitFor(() => expect(calls.filter(c => c.key === "ROUTE").some(c => c.url.includes(";-121.4934,38.5766"))).toBe(true));
    expect((screen.getByRole("link", { name: /open in google maps/i }) as HTMLAnchorElement).href).toContain("destination=38.5766,-121.4934");

    // At the drop-off: complete, and land on the finished ride.
    await user.click(screen.getByRole("button", { name: /we’ve arrived · complete ride/i }));
    await waitFor(() => expect(calls.find(c => c.key === "POST /connections/con_1/transition" && (c.body as { action: string }).action === "complete")).toBeTruthy());
    expect(await screen.findByRole("heading", { name: /ride with rae complete/i })).toBeTruthy();
  });

  it("is told the PIN is the passenger's, and optional", async () => {
    const user = userEvent.setup();
    signIn("driver");
    let state: Record<string, unknown> = { status: "pending" };
    stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": () => [ride(state)],
      "GET /connections/con_1/live": LIVE,
      "POST /connections/con_1/transition": () => { state = { status: "accepted" }; return ride(state); },
    });
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /^accept$/i }));
    expect(await screen.findByText(/rae has a 4-digit pin on their trip screen/i)).toBeTruthy();
    expect(screen.getByText(/\(optional\)/i)).toBeTruthy();
  });
});

describe("Passenger, once accepted", () => {
  it("sees the driver is on the way from the page's own poll, and their PIN with what to do with it", async () => {
    const user = userEvent.setup();
    signIn("rider");
    // I am the passenger here; the connection list never says the driver set off.
    const mine = ride({
      ride_request: { ...REQUEST, rider_id: "usr_me" }, driver_trip: { ...TRIP, driver_id: "usr_dana", driver_name: "Dana Driver" },
      rider_profile: { ...ME.profile }, driver_profile: { ...ME.profile, user_id: "usr_dana", display_name: "Dana Driver" },
      initiator_user_id: "usr_me", ride_pin: "4821",
    });
    stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [mine],
      "GET /connections/con_1/live": { ...LIVE, driver_started_at: iso(1) },
      "GET /notifications": [{ id: "ntf_1", user_id: "usr_me", type: "connection_accepted", title: "Connection accepted", body: "Your carpool connection was accepted.", created_at: iso(5), read: false, related_id: "con_1" }],
      "GET /me/emergency-contacts": [],
    });
    render(<MemoryRouter initialEntries={["/my-rides"]}><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /with dana driver/i }));

    expect(await screen.findByRole("heading", { name: /dana is on the way/i })).toBeTruthy();
    expect(screen.getByText(/dana has set off/i)).toBeTruthy();
    expect(screen.getByText("Your ride PIN")).toBeTruthy();
    expect(screen.getByText(/read it to dana when they arrive/i)).toBeTruthy();
    expect(screen.getByText("4821")).toBeTruthy();
  });
});
