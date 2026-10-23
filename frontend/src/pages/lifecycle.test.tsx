import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { BASE } from "../api";
import { setMockAuthSession } from "../test-support/authMock";

// Ride lifecycle polish: published-trip quick actions, route-fit badges,
// newest-first notifications, chat quick replies, and the post-ride payment
// confirmation + mutual rating.

function useViewport(mobile: boolean) {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: mobile && query.includes("max-width"), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });
  afterEach(() => { window.matchMedia = original; });
}

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const ME = {
  id: "usr_me", email: "sam@example.com", email_domain: "example.com", status: "active",
  profile: { user_id: "usr_me", display_name: "Sam Passenger", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
  vehicle: { user_id: "usr_me", make: "Honda", model: "Fit", color: "Red", seats: 5, car_type: "sedan", has_license: true, has_insurance: true, has_good_driving_record: true },
};

const loc = (id: string, label: string) => ({ id, label, exact: true, latitude: 39.7, longitude: -121.8 });

const MY_TRIP = {
  id: "trp_mine", driver_id: "usr_me", driver_name: "Sam Passenger", driver_photo_url: null,
  pickup: loc("a", "Elm St, Chico, CA"), destination: loc("b", "Sacramento, CA"),
  target_date: today, flexibility: "morning", seats_available: 3, seats_reserved: 0, tags: [], status: "open",
  created_at: iso(60), luggage_capacity: "medium", car_type: "sedan", notes: null,
};

const RIDER_REQUEST = {
  id: "rrq_1", rider_id: "usr_rider", rider_name: "Rae Passenger", rider_photo_url: null,
  pickup: { id: "p", label: "Main St, Chico, CA", exact: false }, destination: { id: "d", label: "Sacramento, CA", exact: false },
  target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "open", created_at: iso(30),
  luggage_size: "none", preferred_car_type: null, notes: null,
  detour_minutes: 3, off_route_m: 240, match_score: 92,
};

type Handler = (body: unknown) => unknown;

function stubApi(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const raw = String(url);
    const key = `${(init?.method ?? "GET").toUpperCase()} ${raw.replace(BASE, "").split("?")[0]}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    const r = routes[key];
    return { ok: true, status: 200, json: async () => (typeof r === "function" ? (r as Handler)(body) : r) };
  }));
  return calls;
}

const BASE_ROUTES = {
  "GET /me": ME,
  "GET /driver-trips/search": [],
  "GET /ride-requests/search": [],
  "GET /me/routes": [],
  "GET /me/connections": [],
  "GET /notifications": [],
  "GET /me/driver-trips": [],
  "GET /me/ride-requests": [],
};

function signIn(mode: "rider" | "driver") {
  localStorage.setItem("carpool_token", "tok");
  setMockAuthSession({ user: { id: "sb_me", email: ME.email, name: ME.profile.display_name } });
  sessionStorage.setItem("carpool_mode", mode);
}

function connection(over: Record<string, unknown> = {}) {
  return {
    id: "con_1", ride_request_id: "rrq_me", driver_trip_id: "trp_x", initiator_user_id: "usr_me", status: "accepted",
    created_at: iso(300), updated_at: iso(1),
    ride_request: { ...RIDER_REQUEST, id: "rrq_me", rider_id: "usr_me", pickup: loc("p", "Main St, Chico, CA"), destination: loc("d", "Sacramento, CA") },
    driver_trip: { ...MY_TRIP, id: "trp_x", driver_id: "usr_driver", driver_name: "Dana Driver" },
    rider_profile: { ...ME.profile }, driver_profile: { ...ME.profile, user_id: "usr_driver", display_name: "Dana Driver" },
    my_rating: null,
    fare: { amount_cents: 850, currency: "USD", distance_km: 120.4, passengers: 1, status: "estimated" },
    ...over,
  };
}

describe("Driver Discover (phone)", () => {
  useViewport(true);
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("pins the published trip with Edit / Pause / Cancel and shows each passenger's route fit", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/driver-trips": [MY_TRIP],
      "GET /ride-requests/search": [RIDER_REQUEST],
      "GET /driver-trips/trp_mine/matches": [RIDER_REQUEST],
      "GET /driver-trips/trp_mine/proposal": { request: null, remaining: 0 },
      "POST /driver-trips/trp_mine/pause": { ...MY_TRIP, status: "paused" },
      "POST /driver-trips/trp_mine/resume": MY_TRIP,
    });

    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    const card = await screen.findByRole("region", { name: /your active trip/i });
    const actions = within(card).getByRole("group", { name: /trip actions/i });
    expect(within(actions).getByRole("button", { name: /edit/i })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: /cancel/i })).toBeTruthy();

    // The trip card comes before the passenger requests.
    const requestsHeading = await screen.findByText(/passengers looking for a ride/i);
    expect(card.compareDocumentPosition(requestsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(await screen.findByText("92% match")).toBeTruthy();
    expect(screen.getByText("+3 min detour")).toBeTruthy();
    expect(screen.getByText("240 m off route")).toBeTruthy();

    await user.click(within(actions).getByRole("button", { name: /pause/i }));
    await waitFor(() => expect(calls.some(c => c.key === "POST /driver-trips/trp_mine/pause")).toBe(true));
  });

  it("edits a published trip's seats and note", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/driver-trips": [MY_TRIP],
      "GET /driver-trips/trp_mine/matches": [],
      "GET /driver-trips/trp_mine/proposal": { request: null, remaining: 0 },
      "PATCH /driver-trips/trp_mine": { ...MY_TRIP, seats_available: 2, notes: "Leaving early" },
    });
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    const card = await screen.findByRole("region", { name: /your active trip/i });
    await user.click(within(card).getByRole("button", { name: /edit/i }));
    await user.click(await screen.findByRole("button", { name: /fewer seats/i }));
    await user.type(screen.getByLabelText(/note for passengers/i), "Leaving early");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(calls.find(c => c.key === "PATCH /driver-trips/trp_mine")?.body).toMatchObject({ seats_available: 2, notes: "Leaving early" }));
  });
});

describe("Passenger mode", () => {
  useViewport(false);
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("lists notifications strictly newest first", async () => {
    const user = userEvent.setup();
    signIn("rider");
    stubApi({
      ...BASE_ROUTES,
      // Deliberately out of order: the API returns newest first but a live push is prepended later.
      "GET /notifications": [
        { id: "n_old", user_id: "usr_me", type: "connection_accepted", title: "Oldest update", body: "b", created_at: iso(300), read: false, related_id: "c" },
        { id: "n_new", user_id: "usr_me", type: "chat_message", title: "Newest update", body: "b", created_at: iso(1), read: false, related_id: "c" },
        { id: "n_mid", user_id: "usr_me", type: "payment_processed", title: "Middle update", body: "b", created_at: iso(60), read: true, related_id: "c" },
      ],
    });
    render(<MemoryRouter initialEntries={["/notifications"]}><App /></MemoryRouter>);

    await screen.findByText("Newest update");
    const titles = screen.getAllByText(/ update$/).map(el => el.textContent);
    expect(titles).toEqual(["Newest update", "Middle update", "Oldest update"]);
    await user.click(screen.getByRole("button", { name: "Payments" }));
    expect(screen.queryByText("Newest update")).toBeNull();
    expect(screen.getByText("Middle update")).toBeTruthy();
  });

  it("has no gas-split field on the request form", async () => {
    signIn("rider");
    stubApi({ ...BASE_ROUTES });
    render(<MemoryRouter initialEntries={["/post"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: /post a listing/i });
    expect(screen.queryByText(/gas split/i)).toBeNull();
    expect(screen.queryByPlaceholderText("0.00")).toBeNull();
  });

  it("offers quick-reply chips in an accepted chat", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [connection()],
      "GET /connections/con_1/messages": [],
      "POST /connections/con_1/messages": (body: unknown) => ({ id: "m1", connection_id: "con_1", sender_id: "usr_me", content: (body as { content: string }).content, kind: "free_text", created_at: iso(0) }),
    });
    render(<MemoryRouter initialEntries={["/inbox"]}><App /></MemoryRouter>);

    const chips = await screen.findByRole("group", { name: /quick replies/i });
    await user.click(within(chips).getByRole("button", { name: /running a few minutes late/i }));
    await waitFor(() => expect(calls.find(c => c.key === "POST /connections/con_1/messages")?.body).toEqual({ content: "Running a few minutes late" }));
  });

  it("confirms payment and asks the passenger to rate the driver after the ride completes", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [connection({ status: "completed", fare: { amount_cents: 850, currency: "USD", distance_km: 120.4, passengers: 1, status: "paid" } })],
      "GET /connections/con_1/messages": [],
      "POST /connections/con_1/rating": { id: "r", stars: 5 },
    });
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);

    const sheet = await screen.findByRole("dialog", { name: /ride complete/i });
    expect(within(sheet).getByText(/payment of \$8\.50 processed/i)).toBeTruthy();
    expect(within(sheet).getByText(/how was your driver, dana/i)).toBeTruthy();
    await user.click(within(sheet).getByRole("radio", { name: "5 stars" }));
    await waitFor(() => expect(calls.find(c => c.key === "POST /connections/con_1/rating")?.body).toEqual({ stars: 5 }));
    await user.click(within(sheet).getByRole("button", { name: /done/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /ride complete/i })).toBeNull());
  });
});
