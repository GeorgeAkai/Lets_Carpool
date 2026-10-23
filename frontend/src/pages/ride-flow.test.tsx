import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { BASE } from "../api";
import { setMockAuthSession } from "../test-support/authMock";

// These screens are the phone layout, so run them at phone width.
function useMobileViewport() {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width"), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });
  afterEach(() => { window.matchMedia = original; });
}

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

const ME = {
  id: "usr_me", email: "sam@example.com", email_domain: "example.com", status: "active",
  profile: { user_id: "usr_me", display_name: "Sam Passenger", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
  vehicle: { user_id: "usr_me", make: "Honda", model: "Fit", color: "Red", seats: 5, car_type: "sedan", has_license: true, has_insurance: true, has_good_driving_record: true },
};

const stats = (rating: number | null, trips: number, verified: boolean) => ({ rating_avg: rating, rating_count: trips, completed_trips: trips, id_verified: verified });

const trip = (id: string, name: string, depart: string, arrive: string, price: number, extra: Record<string, unknown> = {}) => ({
  id, driver_id: `usr_${id}`, driver_name: name, driver_photo_url: null,
  pickup: { id: `p_${id}`, label: "Downtown, Chico, CA", exact: false },
  destination: { id: `d_${id}`, label: "Sacramento, CA", exact: false },
  target_date: today, flexibility: "morning", seats_available: 3, seats_reserved: 1, tags: [], status: "open",
  created_at: "2026-10-01T00:00:00Z", luggage_capacity: "medium", car_type: "sedan", notes: null,
  departure_time: depart, estimated_arrival_time: arrive, duration_minutes: 32, detour_minutes: 4,
  pricing: { distance_km: 23, gas_cost_cents: 1350, split_between: 3, suggested_price_cents: price, price_per_seat_cents: price },
  driver_stats: stats(4.9, 128, true), vehicle: { make: "Honda", model: "Civic", color: "Grey", car_type: "sedan" },
  ...extra,
});

const PRIYA = trip("t_priya", "Priya", "08:10:00", "08:42:00", 450);
const MARCUS = trip("t_marcus", "Marcus", "08:25:00", "09:01:00", 375, { driver_stats: stats(4.8, 64, false), detour_minutes: 9 });

type Handler = (body: unknown, url: string) => unknown;

function stubApi(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ key: string; url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const raw = String(url);
    if (raw.startsWith("https://nominatim.openstreetmap.org")) {
      if (raw.includes("/reverse")) return { ok: true, json: async () => ({ display_name: "Elm St, Chico, California", address: { road: "Elm St", city: "Chico", state: "California" } }) };
      const q = new URL(raw).searchParams.get("q") ?? "";
      return { ok: true, json: async () => [{ place_id: 9, name: q, display_name: `${q}, California, United States`, lat: "38.58", lon: "-121.49",
        // "Area …" queries geocode to a whole city (no house number); anything else to a street address.
        address: q.startsWith("Area") ? { city: q, state: "California" } : { house_number: "100", road: q, city: q, state: "California" } }] };
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const path = raw.replace(BASE, "").split("?")[0];
    const key = `${method} ${path}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, url: raw, body });
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    const r = routes[key];
    const value = typeof r === "function" ? (r as Handler)(body, raw) : r;
    return { ok: true, status: 200, json: async () => value };
  }));
  return calls;
}

const BASE_ROUTES = {
  "GET /me": ME,
  "GET /driver-trips/search": [PRIYA, MARCUS],
  "GET /ride-requests/search": [],
  "GET /me/routes": [],
  "GET /me/connections": [],
  "GET /notifications": [],
};

function signIn(mode: "rider" | "driver" = "rider") {
  localStorage.setItem("carpool_token", "tok");
  setMockAuthSession({ user: { id: "sb_me", email: ME.email, name: ME.profile.display_name } });
  sessionStorage.setItem("carpool_mode", mode);
}

async function pickDestination(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByPlaceholderText(/search a destination/i), text);
  const option = await screen.findByRole("option", { name: new RegExp(text, "i") });
  fireEvent.mouseDown(within(option).getByRole("button"));
}

describe("Passenger flow: Home → Results → Ride details", () => {
  useMobileViewport();
  beforeEach(() => {
    // A real pickup point is required to open a ride request.
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 39.7, longitude: -121.8 } }),
    } });
  });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); Reflect.deleteProperty(navigator, "geolocation"); });

  it("asks passengers for a street address instead of accepting a whole city", async () => {
    const user = userEvent.setup();
    signIn("rider");
    stubApi({ ...BASE_ROUTES });
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await user.type(await screen.findByPlaceholderText(/search a destination/i), "Area Sacramento");
    const option = await screen.findByRole("option", { name: /area sacramento/i });
    fireEvent.mouseDown(within(option).getByRole("button"));

    expect((await screen.findByRole("alert")).textContent).toMatch(/full street address/i);
    expect(screen.getByRole("button", { name: /find me a ride/i })).toBeDisabled();
  });

  it("finds rides, sorts them, and requests a seat with the real destination", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const calls = stubApi({
      ...BASE_ROUTES,
      "POST /locations": (body: unknown) => ({ id: `loc_${(body as { label: string }).label.length}`, label: (body as { label: string }).label, exact: true }),
      "POST /ride-requests": { id: "rrq_new", rider_id: "usr_me", status: "open" },
      "POST /connections": { id: "con_new", ride_request_id: "rrq_new", driver_trip_id: PRIYA.id, initiator_user_id: "usr_me", status: "pending", created_at: "x", updated_at: "x",
        ride_request: { id: "rrq_new", rider_id: "usr_me", pickup: { id: "a", label: "Elm St, Chico, CA", exact: true }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "morning", passenger_count: 2, tags: [], status: "open", created_at: "x" },
        driver_trip: PRIYA },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await screen.findByRole("heading", { name: /where are you headed\?/i });
    await pickDestination(user, "Sacramento");
    await user.click(screen.getByRole("button", { name: /1 seat/i }));
    await user.click(screen.getByRole("button", { name: /more seats needed/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await user.click(screen.getByRole("button", { name: /browse all rides/i }));

    await screen.findByText(/2 drivers going your way/i);
    const search = calls.find(c => c.key === "GET /driver-trips/search" && c.url.includes("destination_latitude"));
    expect(search?.url).toContain(`target_date=${today}`);

    // Best match first (less detour, verified); lowest price flips the order.
    let cards = screen.getAllByRole("button", { name: /per seat/i });
    expect(cards[0]).toHaveTextContent("Priya");
    expect(cards[0]).toHaveTextContent("8:10 → 8:42");
    expect(within(cards[0]).getByRole("img", { name: /id verified/i })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /lowest price/i }));
    cards = screen.getAllByRole("button", { name: /per seat/i });
    expect(cards[0]).toHaveTextContent("Marcus");

    await user.click(screen.getByRole("button", { name: /priya.*per seat|per seat.*priya/i }));
    await screen.findByText(/how the cost is split/i);
    expect(screen.getByText(/shared by 3 people/i)).toBeTruthy();
    // 2 seats × $4.50
    await user.click(screen.getByRole("button", { name: /request 2 seats · \$9\.00/i }));

    await waitFor(() => expect(calls.some(c => c.key === "POST /connections")).toBe(true));
    const rr = calls.find(c => c.key === "POST /ride-requests")!.body as Record<string, unknown>;
    expect(rr.passenger_count).toBe(2);
    const dest = calls.filter(c => c.key === "POST /locations").map(c => c.body as { label: string; latitude: number });
    expect(dest.some(d => d.label.startsWith("Sacramento") && d.latitude === 38.58)).toBe(true);
    // Requesting now lands on the waiting screen, not the inbox.
    await screen.findByText(/waiting for priya/i);
  });

  it("'Find me a ride' requests the top match and opens the trip once accepted", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const pending = { id: "con_new", ride_request_id: "rrq_new", driver_trip_id: PRIYA.id, initiator_user_id: "usr_me", status: "pending", created_at: "x", updated_at: "x", my_rating: null, rider_at_pickup_at: null,
      ride_request: { id: "rrq_new", rider_id: "usr_me", pickup: { id: "a", label: "Elm St, Chico, CA", exact: true, latitude: 39.7, longitude: -121.8 }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "flexible", passenger_count: 1, tags: [], status: "open", created_at: "x" },
      driver_trip: PRIYA,
      driver_profile: { user_id: PRIYA.driver_id, display_name: "Priya", photo_url: null, bio: null, photo_verified: true, interests: [], nationality: null, phone: "+1 555 0100" },
      rider_profile: null };
    let polls = 0;
    let requested = false;
    const calls = stubApi({
      ...BASE_ROUTES,
      "POST /locations": (body: unknown) => ({ id: `loc_${(body as { label: string }).label.length}`, label: (body as { label: string }).label, exact: true }),
      "POST /ride-requests": { id: "rrq_new", rider_id: "usr_me", status: "open" },
      "POST /connections": () => { requested = true; return pending; },
      "GET /me/connections": () => (!requested ? [] : ++polls < 3 ? [pending] : [{ ...pending, status: "accepted" }]),
      "GET /connections/con_new/messages": [],
      "GET /connections/con_new/live": { connection_id: "con_new", pickup: { label: "Elm St, Chico, CA", latitude: 39.7, longitude: -121.8 }, departure_time: "08:10:00", driver: null, rider_at_pickup_at: null },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: /where are you headed\?/i });
    await pickDestination(user, "Sacramento");
    await user.click(screen.getByRole("button", { name: /find me a ride/i }));

    // Best match (Priya) is asked automatically, with no list or detail screen in between.
    await screen.findByText(/waiting for priya/i);
    const conn = calls.find(c => c.key === "POST /connections")!.body as Record<string, unknown>;
    expect(conn.driver_trip_id).toBe(PRIYA.id);

    // Once Priya accepts, the passenger lands on the trip-day screen.
    await screen.findByText(/ride confirmed/i, undefined, { timeout: 8000 });
    await screen.findByRole("button", { name: /i’m at the pickup spot/i });
    expect(screen.queryByText(/waiting for priya/i)).toBeNull();
  }, 15000);

  it("moves on to the next best driver when the first one declines", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const conn = (t: typeof PRIYA, status: string) => ({ id: `con_${t.id}`, ride_request_id: "rrq_new", driver_trip_id: t.id, initiator_user_id: "usr_me", status, created_at: "x", updated_at: "x", my_rating: null, rider_at_pickup_at: null,
      ride_request: { id: "rrq_new", rider_id: "usr_me", pickup: { id: "a", label: "Elm St, Chico, CA", exact: true }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "flexible", passenger_count: 1, tags: [], status: "open", created_at: "x" },
      driver_trip: t, driver_profile: null, rider_profile: null });
    const asked: string[] = [];
    const calls = stubApi({
      ...BASE_ROUTES,
      "POST /locations": (body: unknown) => ({ id: `loc_${(body as { label: string }).label.length}`, label: (body as { label: string }).label, exact: true }),
      "POST /ride-requests": { id: "rrq_new", rider_id: "usr_me", status: "open" },
      "POST /connections": (body: unknown) => { const t = (body as { driver_trip_id: string }).driver_trip_id === PRIYA.id ? PRIYA : MARCUS; asked.push(t.id); return conn(t, "pending"); },
      "GET /me/connections": () => asked.map(id => conn(id === PRIYA.id ? PRIYA : MARCUS, id === PRIYA.id ? "declined" : "pending")),
    });
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: /where are you headed\?/i });
    await pickDestination(user, "Sacramento");
    await user.click(screen.getByRole("button", { name: /find me a ride/i }));
    await screen.findByText(/waiting for priya/i);
    await screen.findByText(/waiting for marcus/i, undefined, { timeout: 8000 });
    expect(asked).toEqual([PRIYA.id, MARCUS.id]);
    expect(calls.filter(c => c.key === "POST /ride-requests")).toHaveLength(1); // one request reused
  }, 15000);
});

describe("Trip day", () => {
  useMobileViewport();
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("shows the live ETA, plate and call link, and checks the passenger in at pickup", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const accepted = {
      id: "con_1", ride_request_id: "rrq_1", driver_trip_id: PRIYA.id, initiator_user_id: "usr_me", status: "accepted",
      created_at: "x", updated_at: "x", my_rating: null, rider_at_pickup_at: null,
      ride_request: { id: "rrq_1", rider_id: "usr_me", pickup: { id: "a", label: "Elm St & 3rd, Chico, CA", exact: true, latitude: 39.7, longitude: -121.8 }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "matched", created_at: "x" },
      driver_trip: { ...PRIYA, vehicle: { ...PRIYA.vehicle, plate: "8KXR 214" } },
      driver_profile: { user_id: PRIYA.driver_id, display_name: "Priya", photo_url: null, bio: null, photo_verified: true, interests: [], nationality: null, phone: "+1 555 0100" },
      rider_profile: { user_id: "usr_me", display_name: "Sam Passenger", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
    };
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [accepted],
      "GET /connections/con_1/messages": [],
      "GET /connections/con_1/live": { connection_id: "con_1", pickup: { label: "Elm St & 3rd, Chico, CA", latitude: 39.7, longitude: -121.8 }, departure_time: "08:10:00", driver: { latitude: 39.71, longitude: -121.81, updated_at: "x", distance_to_pickup_m: 1800, eta_minutes: 6 }, rider_at_pickup_at: null },
      "POST /connections/con_1/at-pickup": { ...accepted, rider_at_pickup_at: "2026-10-15T08:09:00Z" },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: /8:10 am with priya/i }));
    await screen.findByRole("heading", { name: /priya arrives in 6 min/i });
    expect(screen.getByText("8KXR 214")).toBeTruthy();
    expect(screen.getByText(/grey honda civic/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /call/i })).toHaveAttribute("href", "tel:+15550100");

    await user.click(screen.getByRole("button", { name: /i’m at the pickup spot/i }));
    await screen.findByRole("button", { name: /you’re checked in/i });
    expect(calls.some(c => c.key === "POST /connections/con_1/at-pickup")).toBe(true);
  });
});

describe("Driver flow: Home → Offer a ride", () => {
  useMobileViewport();
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("posts a priced, repeating trip with a departure time", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/driver-trips": [],
      "GET /me/ride-requests": [],
      "POST /locations": (body: unknown) => ({ id: `loc_${(body as { label: string }).label}`, label: (body as { label: string }).label, exact: true }),
      "POST /driver-trips/price-preview": { distance_km: 23, gas_cost_cents: 1350, split_between: 3, suggested_price_cents: 450, price_per_seat_cents: 450, duration_minutes: 26 },
      "POST /driver-trips": { ...PRIYA, id: "trp_new", driver_id: "usr_me", series_trip_ids: ["trp_new", "trp_2"], pickup: { id: "a", label: "Elm St, Chico, CA", exact: true }, destination: { id: "b", label: "Sacramento, CA", exact: true } },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await screen.findByRole("heading", { name: /where are you driving\?/i });
    expect(screen.getByRole("button", { name: /post this ride/i })).toBeDisabled();
    await pickDestination(user, "Sacramento");
    await user.click(screen.getByRole("button", { name: /post this ride/i }));

    // No device location in tests, so the flow starts at step 1 for the start point.
    await screen.findByRole("heading", { name: /route & time/i });
    await user.type(screen.getByPlaceholderText(/your area/i), "Chico");
    fireEvent.mouseDown(within(await screen.findByRole("option", { name: /chico/i })).getByRole("button"));
    fireEvent.change(document.querySelector('input[type="time"]')!, { target: { value: "08:10" } });
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    await screen.findByRole("heading", { name: /seats & cost/i });
    await screen.findByText(/suggested from ~\$13\.50 in gas/i);
    await user.click(screen.getByRole("checkbox", { name: /repeat on weekdays/i }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    await screen.findByRole("heading", { name: /^review$/i });
    await user.click(screen.getByRole("button", { name: /post these rides/i }));

    await waitFor(() => expect(calls.some(c => c.key === "POST /driver-trips")).toBe(true));
    const body = calls.find(c => c.key === "POST /driver-trips")!.body as Record<string, unknown>;
    expect(body.departure_time).toBe("08:10");
    expect(body.repeat_weekdays).toEqual([0, 1, 2, 3, 4]);
    expect(body.price_per_seat_cents).toBeNull();
    expect(body.seats_available).toBe(1);
    await screen.findByRole("heading", { name: /^my rides$/i });
  });
});
