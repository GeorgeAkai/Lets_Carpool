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
  id: "usr_me", email: "sam@example.com", email_domain: "example.com", status: "active", onboarded_at: "2026-01-01T00:00:00Z",
  profile: { user_id: "usr_me", display_name: "Sam Rider", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
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
      return { ok: true, json: async () => [{ place_id: 9, name: q, display_name: `${q}, California, United States`, lat: "38.58", lon: "-121.49", address: { city: q, state: "California" } }] };
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

describe("Rider flow: Home → Results → Ride details", () => {
  useMobileViewport();
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

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
    expect(screen.getByRole("radio", { name: /find a ride/i })).toHaveAttribute("aria-checked", "true");
    await pickDestination(user, "Sacramento");
    await user.click(screen.getByRole("button", { name: /1 seat/i }));
    await user.click(screen.getByRole("button", { name: /more seats needed/i }));
    await user.click(screen.getByRole("button", { name: /^done$/i }));
    await user.click(screen.getByRole("button", { name: /find rides/i }));

    await screen.findByText(/2 drivers going your way/i);
    const search = calls.find(c => c.key === "GET /driver-trips/search" && c.url.includes("destination_latitude"));
    expect(search?.url).toContain(`target_date=${today}`);

    // Best match first (less detour, verified); cheapest flips the order.
    let cards = screen.getAllByRole("button", { name: /per seat/i });
    expect(cards[0]).toHaveTextContent("Priya");
    expect(cards[0]).toHaveTextContent("8:10 → 8:42");
    expect(within(cards[0]).getByRole("img", { name: /id verified/i })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /cheapest/i }));
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
    // Lands on the request status, waiting for the driver.
    await screen.findByRole("heading", { name: /waiting for priya/i });
    expect(screen.getByRole("button", { name: /see other rides meanwhile/i })).toBeTruthy();
  });
});

describe("Trip day", () => {
  useMobileViewport();
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("shows the live ETA, plate and call link, and checks the rider in at pickup", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const accepted = {
      id: "con_1", ride_request_id: "rrq_1", driver_trip_id: PRIYA.id, initiator_user_id: "usr_me", status: "accepted",
      created_at: "x", updated_at: "x", my_rating: null, rider_at_pickup_at: null,
      ride_request: { id: "rrq_1", rider_id: "usr_me", pickup: { id: "a", label: "Elm St & 3rd, Chico, CA", exact: true, latitude: 39.7, longitude: -121.8 }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "matched", created_at: "x" },
      driver_trip: { ...PRIYA, vehicle: { ...PRIYA.vehicle, plate: "8KXR 214" } },
      driver_profile: { user_id: PRIYA.driver_id, display_name: "Priya", photo_url: null, bio: null, photo_verified: true, interests: [], nationality: null, phone: "+1 555 0100" },
      rider_profile: { user_id: "usr_me", display_name: "Sam Rider", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
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
    expect(screen.getByRole("progressbar", { name: /priya is on the way/i })).toBeTruthy();
    expect(screen.getByText(/1\.1 mi away/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /i’m late/i }));
    await waitFor(() => expect(calls.some(c => c.key === "POST /connections/con_1/messages")).toBe(true));

    await user.click(screen.getByRole("button", { name: /i’m at the pickup spot/i }));
    await screen.findByRole("button", { name: /you’re checked in/i });
    expect(calls.some(c => c.key === "POST /connections/con_1/at-pickup")).toBe(true);
  });

  it("shows the arrival screen with the cost split and rating once the driver completes the ride", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const accepted = {
      id: "con_2", ride_request_id: "rrq_2", driver_trip_id: "trp_mine", initiator_user_id: "usr_sam", status: "accepted",
      created_at: "x", updated_at: "x", my_rating: null, rider_at_pickup_at: null,
      ride_request: { id: "rrq_2", rider_id: "usr_sam", pickup: { id: "a", label: "Elm St & 3rd, Chico, CA", exact: true }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "matched", created_at: "x" },
      driver_trip: { ...PRIYA, id: "trp_mine", driver_id: "usr_me" },
      rider_profile: { user_id: "usr_sam", display_name: "Sam Rivera", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
      driver_profile: { user_id: "usr_me", display_name: "Me", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
    };
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [accepted],
      "GET /me/driver-trips": [],
      "GET /me/ride-requests": [],
      "GET /connections/con_2/messages": [],
      "GET /connections/con_2/live": { connection_id: "con_2", pickup: { label: "Elm St & 3rd, Chico, CA", latitude: 39.7, longitude: -121.8 }, departure_time: "08:10:00", driver: null, rider_at_pickup_at: null },
      "POST /connections/con_2/transition": { ...accepted, status: "completed" },
      "POST /connections/con_2/rating": {},
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: /picking up sam/i }));
    await user.click(await screen.findByRole("button", { name: /mark ride complete/i }));

    await screen.findByRole("heading", { name: /ride complete/i });
    expect(screen.getByText("$4.50")).toBeTruthy();
    expect(screen.getByText(/vs ~\$13\.50 driving solo/i)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /^5 stars$/i }));
    await waitFor(() => expect(calls.some(c => c.key === "POST /connections/con_2/rating")).toBe(true));
    expect((calls.find(c => c.key === "POST /connections/con_2/rating")!.body as { stars: number }).stars).toBe(5);
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

describe("Home: ride or drive toggle", () => {
  useMobileViewport();
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("switches between finding and offering a ride without leaving Home", async () => {
    const user = userEvent.setup();
    signIn("rider");
    stubApi({ ...BASE_ROUTES, "GET /me/driver-trips": [], "GET /me/ride-requests": [] });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await screen.findByRole("heading", { name: /where are you headed\?/i });
    await user.click(screen.getByRole("radio", { name: /offer a ride/i }));
    await screen.findByRole("heading", { name: /where are you driving\?/i });
    expect(screen.getByRole("button", { name: /post this ride/i })).toBeTruthy();
    expect(sessionStorage.getItem("carpool_mode")).toBe("driver");

    await user.click(screen.getByRole("radio", { name: /find a ride/i }));
    await screen.findByRole("heading", { name: /where are you headed\?/i });
  });
});

// ─── Account screens: welcome, preferences, safety, receipt, PIN, rating ──────

function acceptedConnection(over: Record<string, unknown> = {}) {
  return {
    id: "con_9", ride_request_id: "rrq_9", driver_trip_id: PRIYA.id, initiator_user_id: "usr_me", status: "accepted",
    created_at: "x", updated_at: "x", my_rating: null, rider_at_pickup_at: null, ride_pin: "4821", pin_verified_at: null,
    ride_request: { id: "rrq_9", rider_id: "usr_me", rider_name: "Sam Rider", pickup: { id: "a", label: "Elm St & 3rd, Chico, CA", exact: true, latitude: 39.7, longitude: -121.8 }, destination: { id: "b", label: "Sacramento, CA", exact: true }, target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "matched", created_at: "x" },
    driver_trip: { ...PRIYA, vehicle: { ...PRIYA.vehicle, plate: "8KXR 214" } },
    driver_profile: { user_id: PRIYA.driver_id, display_name: "Priya", photo_url: null, bio: null, photo_verified: true, interests: [], nationality: null },
    rider_profile: { user_id: "usr_me", display_name: "Sam Rider", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
    settlement: { method: "venmo", handle: "@priya", updated_at: "x" },
    ...over,
  };
}

describe("Account screens", () => {
  useMobileViewport();
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("shows the welcome screen once, before choosing how to ride", async () => {
    const user = userEvent.setup();
    signIn("rider");
    sessionStorage.removeItem("carpool_mode");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me": { ...ME, onboarded_at: null },
      "POST /me/onboarding/complete": { ...ME, onboarded_at: "2026-10-26T00:00:00Z" },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    await screen.findByRole("heading", { name: /share the ride/i });
    await user.click(screen.getByRole("button", { name: /get started/i }));
    await screen.findByText(/how are you riding today/i);
    expect(calls.some(c => c.key === "POST /me/onboarding/complete")).toBe(true);
  });

  it("saves ride preferences from Results and searches again", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/preferences": { max_walk_minutes: null, vibes: [], verified_only: false, women_only: false, coworkers_first: false, route_checkins: true },
      "PATCH /me/preferences": (body: unknown) => body,
      "GET /driver-trips/search": [{ ...PRIYA, is_coworker: true, shared_vibes: ["quiet"] }, MARCUS],
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: /where are you headed\?/i });
    await pickDestination(user, "Sacramento");
    await user.click(screen.getByRole("button", { name: /find rides/i }));
    await screen.findByText(/2 drivers going your way/i);
    expect(screen.getByText("Coworker")).toBeTruthy();
    expect(screen.getByText("Quiet ride")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /ride preferences/i }));
    await screen.findByRole("heading", { name: /ride preferences/i });
    await user.click(await screen.findByRole("radio", { name: /10 min/i }));
    await user.click(screen.getByRole("button", { name: /quiet ride/i }));
    await user.click(screen.getByRole("checkbox", { name: /verified drivers only/i }));
    // Women-only needs a self-declared gender first.
    expect(screen.getByRole("checkbox", { name: /women-only rides/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /show matching rides/i }));

    await screen.findByText(/2 drivers going your way/i);
    const body = calls.find(c => c.key === "PATCH /me/preferences")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ max_walk_minutes: 10, vibes: ["quiet"], verified_only: true, women_only: false });
    expect(calls.filter(c => c.key === "GET /driver-trips/search" && c.url.includes("destination_latitude")).length).toBe(2);
  });

  it("opens Safety from trip day with the ride PIN and texts the trip to trusted contacts", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [acceptedConnection()],
      "GET /connections/con_9/messages": [],
      "GET /connections/con_9/live": { connection_id: "con_9", pickup: { label: "Elm St & 3rd, Chico, CA", latitude: 39.7, longitude: -121.8 }, departure_time: "08:10:00", driver: null, rider_at_pickup_at: null },
      "GET /me/emergency-contacts": [],
      "POST /me/emergency-contacts": (body: unknown) => ({ id: "emc_1", relationship: null, created_at: "x", ...(body as object) }),
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /8:10 am with priya/i }));
    await screen.findByText(/tell priya your ride pin/i);
    expect(screen.getByText(/settles up via/i)).toHaveTextContent("Venmo · @priya");

    await user.click(screen.getByRole("button", { name: /safety/i }));
    await screen.findByRole("heading", { name: /^safety$/i });
    expect(screen.getByRole("link", { name: /call emergency services/i })).toHaveAttribute("href", "tel:911");
    expect(screen.getByText("4821")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: /\+ add/i }));
    await user.type(screen.getByLabelText(/^name$/i), "Alex");
    await user.type(screen.getByLabelText(/^phone$/i), "+1 555 0100");
    await user.click(screen.getByRole("button", { name: /add contact/i }));

    const text = await screen.findByRole("link", { name: /text this trip to alex/i });
    expect(text.getAttribute("href")).toMatch(/^sms:\+15550100\?&body=.*Priya/);
    expect((calls.find(c => c.key === "POST /me/emergency-contacts")!.body as { name: string }).name).toBe("Alex");
  });

  it("lets the driver confirm the rider's PIN", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const asDriver = acceptedConnection({
      driver_trip: { ...PRIYA, driver_id: "usr_me" }, ride_pin: null,
      ride_request: { ...acceptedConnection().ride_request, rider_id: "usr_sam" },
      rider_profile: { user_id: "usr_sam", display_name: "Sam Rivera", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
    });
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/driver-trips": [], "GET /me/ride-requests": [],
      "GET /me/connections": [asDriver],
      "GET /connections/con_9/messages": [],
      "GET /connections/con_9/live": { connection_id: "con_9", pickup: { label: "Elm St", latitude: 39.7, longitude: -121.8 }, departure_time: "08:10:00", driver: null, rider_at_pickup_at: null },
      "POST /connections/con_9/verify-pin": { ...asDriver, pin_verified_at: "2026-10-26T08:09:00Z" },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /picking up sam/i }));
    await user.type(await screen.findByLabelText(/ask sam for their 4-digit ride pin/i), "4821");
    await user.click(screen.getByRole("button", { name: /^check$/i }));

    await screen.findByText(/ride pin confirmed/i);
    expect((calls.find(c => c.key === "POST /connections/con_9/verify-pin")!.body as { pin: string }).pin).toBe("4821");
  });

  it("rates with tags, rides again and opens the receipt after a completed ride", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const asDriver = acceptedConnection({
      driver_trip: { ...PRIYA, driver_id: "usr_me" },
      ride_request: { ...acceptedConnection().ride_request, rider_id: "usr_sam" },
      rider_profile: { user_id: "usr_sam", display_name: "Sam Rivera", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
    });
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/driver-trips": [], "GET /me/ride-requests": [],
      "GET /me/connections": [asDriver],
      "GET /connections/con_9/messages": [],
      "GET /connections/con_9/live": { connection_id: "con_9", pickup: { label: "Elm St", latitude: 39.7, longitude: -121.8 }, departure_time: "08:10:00", driver: null, rider_at_pickup_at: null },
      "POST /connections/con_9/transition": { ...asDriver, status: "completed" },
      "POST /connections/con_9/rating": {},
      "PUT /me/buddies/usr_sam": { status: "added" },
      "GET /connections/con_9/receipt": {
        id: "rcp_1", receipt_number: "CP-00042", connection_id: "con_9", rider_id: "usr_sam", driver_id: "usr_me",
        driver_name: "Me", vehicle_label: "Grey Honda Civic", pickup_label: "Elm St & 3rd, Chico, CA", dropoff_label: "Sacramento, CA",
        trip_date: today, departure_time: "08:10:00", completed_at: `${today}T08:41:00`, distance_km: 23, gas_cost_cents: 1350,
        split_between: 3, seats: 1, price_per_seat_cents: 450, amount_cents: 450, settlement_method: "venmo",
      },
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /picking up sam/i }));
    await user.click(await screen.findByRole("button", { name: /mark ride complete/i }));
    await screen.findByRole("heading", { name: /ride complete/i });

    await user.click(screen.getByRole("radio", { name: /^5 stars$/i }));
    await user.click(screen.getByRole("button", { name: /on time/i }));
    await waitFor(() => {
      const last = calls.filter(c => c.key === "POST /connections/con_9/rating").at(-1)!.body as { stars: number; tags: string[] };
      expect(last).toMatchObject({ stars: 5, tags: ["on_time"] });
    });
    await user.click(screen.getByRole("checkbox", { name: /ride with sam again/i }));
    await waitFor(() => expect(calls.some(c => c.key === "PUT /me/buddies/usr_sam")).toBe(true));

    await user.click(screen.getByRole("button", { name: /view receipt/i }));
    await screen.findByRole("heading", { name: /trip receipt/i });
    const receipt = screen.getByRole("article", { name: /receipt cp-00042/i });
    expect(receipt).toHaveTextContent("$4.50");
    expect(receipt).toHaveTextContent("Gas for 14 mi");
    expect(receipt).toHaveTextContent("Venmo");
    expect(screen.getByRole("link", { name: /email for expenses/i }).getAttribute("href")).toMatch(/^mailto:\?subject=Carpool%20receipt%20CP-00042/);
  });
});
