import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { BASE } from "../api";
import { setMockAuthSession } from "../test-support/authMock";

// Nobody is left on a "Waiting for … to accept" page with nothing to do:
// whoever must answer gets Accept / Decline wherever they are, whoever asked
// can cancel or keep looking, and two people who asked each other are confirmed.

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
const loc = (id: string, label: string) => ({ id, label, exact: true, latitude: 39.7, longitude: -121.8 });

const ME = {
  id: "usr_me", email: "sam@example.com", email_domain: "example.com", status: "active", onboarded_at: "2026-01-01T00:00:00Z",
  profile: { user_id: "usr_me", display_name: "Sam Passenger", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
  vehicle: { user_id: "usr_me", make: "Honda", model: "Fit", color: "Red", seats: 5, car_type: "sedan", has_license: true, has_insurance: true, has_good_driving_record: true },
};

// Dana's trip, as it shows in my Discover feed.
const DANA_TRIP = {
  id: "trp_dana", driver_id: "usr_dana", driver_name: "Dana Driver", driver_photo_url: null,
  pickup: { id: "a", label: "Elm St, Chico, CA", exact: false }, destination: { id: "b", label: "Sacramento, CA", exact: false },
  target_date: today, flexibility: "morning", seats_available: 3, seats_reserved: 0, tags: [], status: "open",
  created_at: iso(60), luggage_capacity: "medium", car_type: "sedan", notes: null,
};
// Rae's request, as it shows in my Discover feed when I drive.
const RAE_REQUEST = {
  id: "rrq_rae", rider_id: "usr_rae", rider_name: "Rae Rider", rider_photo_url: null,
  pickup: { id: "p", label: "Main St, Chico, CA", exact: false }, destination: { id: "d", label: "Sacramento, CA", exact: false },
  target_date: today, flexibility: "morning", passenger_count: 1, tags: [], status: "open", created_at: iso(30),
  luggage_size: "none", preferred_car_type: null, notes: null,
};
const MY_TRIP = {
  ...DANA_TRIP, id: "trp_mine", driver_id: "usr_me", driver_name: "Sam Passenger",
  pickup: loc("a", "Elm St, Chico, CA"), destination: loc("b", "Sacramento, CA"),
};
const MY_REQUEST = {
  ...RAE_REQUEST, id: "rrq_mine", rider_id: "usr_me", rider_name: "Sam Passenger",
  pickup: loc("p", "Main St, Chico, CA"), destination: loc("d", "Sacramento, CA"),
};

// A connection where I am the passenger and Dana drives.
function ridingWithDana(over: Record<string, unknown> = {}) {
  return {
    id: "con_1", ride_request_id: "rrq_mine", driver_trip_id: "trp_dana", initiator_user_id: "usr_me", status: "pending",
    created_at: iso(2), updated_at: iso(2),
    ride_request: MY_REQUEST,
    driver_trip: { ...DANA_TRIP, pickup: loc("a", "Elm St, Chico, CA"), destination: loc("b", "Sacramento, CA") },
    rider_profile: { ...ME.profile }, driver_profile: { ...ME.profile, user_id: "usr_dana", display_name: "Dana Driver" },
    my_rating: null, fare: { amount_cents: 850, currency: "USD", distance_km: 120.4, passengers: 1, status: "estimated" },
    ...over,
  };
}

type Handler = (body: unknown) => unknown;

function stubApi(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("nominatim.openstreetmap.org/search")) {
      return { ok: true, status: 200, json: async () => [{ place_id: 1, lat: "38.58", lon: "-121.49", display_name: "Somewhere, CA", type: "city", class: "place", address: {} }] };
    }
    const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).replace(BASE, "").split("?")[0]}`;
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
  "GET /connections/con_1/messages": [],
};

function signIn(mode: "rider" | "driver") {
  localStorage.setItem("carpool_token", "tok");
  setMockAuthSession({ user: { id: "sb_me", email: ME.email, name: ME.profile.display_name } });
  sessionStorage.setItem("carpool_mode", mode);
}

// Discover promotes the listing into "Best matches" once it has scored it; wait for that card's button.
const REQUEST = /instant request match/i;
const open = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
const posted = (calls: Array<{ key: string; body: unknown }>, key: string) => calls.filter(c => c.key === key);

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("The person who has to answer", () => {
  useViewport(false);
  const offer = () => ridingWithDana({ initiator_user_id: "usr_dana" });
  const received = { id: "ntf_1", user_id: "usr_me", type: "connection_received", title: "Dana Driver offered you a ride", body: "Open it to accept or decline.", created_at: iso(1), read: false, related_id: "con_1" };

  it.each(["/notifications", "/profile", "/my-rides", "/discover"])("sees Accept and Decline on %s", async path => {
    signIn("rider");
    stubApi({ ...BASE_ROUTES, "GET /me/connections": [offer()] });
    open(path);
    expect(await screen.findByText(/dana driver offered you a ride/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^accept$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /decline dana driver/i })).toBeTruthy();
  });

  it("is taken from the notification to a page that says it is their call, and accepting confirms the ride", async () => {
    const user = userEvent.setup();
    signIn("rider");
    let accepted = false;
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": () => [accepted ? { ...offer(), status: "accepted" } : offer()],
      "GET /notifications": [received],
      "POST /connections/con_1/transition": () => { accepted = true; return { ...offer(), status: "accepted" }; },
    });
    open("/notifications");
    await user.click(await screen.findByText(/open it to accept or decline/i));

    expect(await screen.findByRole("heading", { name: /dana offered you a ride/i })).toBeTruthy();
    expect(screen.queryByText(/waiting for dana to accept/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /accept dana’s ride/i }));

    await waitFor(() => expect(posted(calls, "POST /connections/con_1/transition")[0]?.body).toEqual({ action: "accept" }));
    expect(await screen.findByText(/booked · seat confirmed/i)).toBeTruthy();
  });

  it("can decline from the same page and is shown the way to other rides", async () => {
    const user = userEvent.setup();
    signIn("rider");
    let declined = false;
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": () => [declined ? { ...offer(), status: "declined" } : offer()],
      "GET /notifications": [received],
      "POST /connections/con_1/transition": () => { declined = true; return { ...offer(), status: "declined" }; },
    });
    open("/notifications");
    await user.click(await screen.findByText(/open it to accept or decline/i));
    await user.click(await screen.findByRole("button", { name: /^decline$/i }));

    await waitFor(() => expect(posted(calls, "POST /connections/con_1/transition")[0]?.body).toEqual({ action: "decline" }));
    expect(await screen.findByRole("heading", { name: /you declined this ride/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /find another ride/i })).toBeTruthy();
  });

  it("finds Accept and Decline in the inbox conversation", async () => {
    signIn("rider");
    stubApi({ ...BASE_ROUTES, "GET /me/connections": [offer()] });
    open("/inbox");
    expect(await screen.findByRole("button", { name: /^accept$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^decline$/i })).toBeTruthy();
  });
});

describe("The person who asked", () => {
  useViewport(false);

  it("can cancel the request or keep looking instead of just waiting", async () => {
    const user = userEvent.setup();
    signIn("rider");
    let cancelled = false;
    const mine = ridingWithDana();
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /driver-trips/search": [DANA_TRIP],
      "GET /me/connections": () => (cancelled ? [{ ...mine, status: "cancelled" }] : []),
      "POST /locations": loc("new", "Somewhere"),
      "POST /ride-requests": MY_REQUEST,
      "POST /connections": mine,
      "POST /connections/con_1/transition": () => { cancelled = true; return { ...mine, status: "cancelled" }; },
    });
    open("/discover");
    await user.click(await screen.findByRole("button", { name: REQUEST }));

    expect(await screen.findByRole("heading", { name: /waiting for dana to accept/i })).toBeTruthy();
    // The request made for this tap is not a post: it must not show up in Discover.
    expect(posted(calls, "POST /ride-requests")[0]?.body).toMatchObject({ unlisted: true });
    expect(screen.getByText(/this page updates the moment dana answers/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep looking at other rides/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /cancel request/i }));

    await waitFor(() => expect(posted(calls, "POST /connections/con_1/transition")[0]?.body).toEqual({ action: "cancel" }));
    expect(await screen.findByRole("heading", { name: /this request was cancelled/i })).toBeTruthy();
    expect(screen.queryByText(/waiting for dana/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /find another ride/i }));
    expect(await screen.findByRole("button", { name: REQUEST })).toBeTruthy();
  });

  it("is told when a request has gone unanswered for a while", async () => {
    const user = userEvent.setup();
    signIn("rider");
    const stale = ridingWithDana({ created_at: iso(45) });
    stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [stale],
      "GET /notifications": [{ id: "ntf_2", user_id: "usr_me", type: "connection_reminder", title: "Still waiting", body: "Dana has not answered yet.", created_at: iso(1), read: false, related_id: "con_1" }],
    });
    open("/notifications");
    await user.click(await screen.findByText(/dana has not answered yet/i));
    expect(await screen.findByText(/no answer yet — sent 45 min ago/i)).toBeTruthy();
    expect(screen.getByText(/closes by itself after 24 hours/i)).toBeTruthy();
  });

  it("is not told to keep waiting once the request has expired", async () => {
    const user = userEvent.setup();
    signIn("rider");
    stubApi({
      ...BASE_ROUTES,
      "GET /me/connections": [ridingWithDana({ status: "expired" })],
      "GET /notifications": [{ id: "ntf_3", user_id: "usr_me", type: "connection_expired", title: "No reply to your request", body: "Nobody answered in time, so the request was closed.", created_at: iso(1), read: false, related_id: "con_1" }],
    });
    open("/notifications");
    await user.click(await screen.findByText(/nobody answered in time/i));
    expect(await screen.findByRole("heading", { name: /dana didn’t answer in time/i })).toBeTruthy();
    expect(screen.queryByText(/waiting for dana to accept/i)).toBeNull();
    expect(screen.getByRole("button", { name: /find another ride/i })).toBeTruthy();
  });
});

describe("Two people who asked each other", () => {
  it("confirms the ride when a passenger requests a driver who already offered them one", async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    const user = userEvent.setup();
    signIn("rider");
    // Dana offered on my request using a different trip than the one in Discover.
    const offer = ridingWithDana({ initiator_user_id: "usr_dana", driver_trip_id: "trp_other", driver_trip: { ...DANA_TRIP, id: "trp_other", pickup: loc("a", "Elm St, Chico, CA"), destination: loc("b", "Sacramento, CA") } });
    let accepted = false;
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /driver-trips/search": [DANA_TRIP],
      "GET /me/connections": () => [accepted ? { ...offer, status: "accepted" } : offer],
      "POST /connections/con_1/transition": () => { accepted = true; return { ...offer, status: "accepted" }; },
    });
    open("/discover");
    await user.click(await screen.findByRole("button", { name: REQUEST }));

    await waitFor(() => expect(posted(calls, "POST /connections/con_1/transition")[0]?.body).toEqual({ action: "accept" }));
    expect(posted(calls, "POST /ride-requests")).toHaveLength(0);
    expect(posted(calls, "POST /connections")).toHaveLength(0);
    expect(await screen.findByText(/booked · seat confirmed/i)).toBeTruthy();
  });
});

describe("A driver offering on a passenger's request (phone)", () => {
  useViewport(true);

  it("offers the trip they already posted instead of making a second one", async () => {
    const user = userEvent.setup();
    signIn("driver");
    const sent = {
      id: "con_9", ride_request_id: "rrq_rae", driver_trip_id: "trp_mine", initiator_user_id: "usr_me", status: "pending",
      created_at: iso(0), updated_at: iso(0),
      ride_request: { ...RAE_REQUEST, pickup: loc("p", "Main St, Chico, CA"), destination: loc("d", "Sacramento, CA") }, driver_trip: MY_TRIP,
      rider_profile: { ...ME.profile, user_id: "usr_rae", display_name: "Rae Rider" }, driver_profile: { ...ME.profile },
      my_rating: null,
    };
    const calls = stubApi({
      ...BASE_ROUTES,
      "GET /me/driver-trips": [MY_TRIP],
      "GET /ride-requests/search": [RAE_REQUEST],
      "GET /driver-trips/trp_mine/matches": [RAE_REQUEST],
      "GET /driver-trips/trp_mine/proposal": { request: null, remaining: 0 },
      "POST /connections": sent,
      "GET /connections/con_9/messages": [],
    });
    open("/discover");
    const list = await screen.findByText(/passengers looking for a ride/i);
    await user.click(await within(list.parentElement!.parentElement!).findByRole("button", { name: /offer ride/i }));

    await waitFor(() => expect(posted(calls, "POST /connections")[0]?.body).toEqual({ ride_request_id: "rrq_rae", driver_trip_id: "trp_mine" }));
    expect(posted(calls, "POST /driver-trips")).toHaveLength(0);
    expect(await screen.findByRole("heading", { name: /waiting for rae to accept/i })).toBeTruthy();
    expect(screen.getByText(/start trip appears here/i)).toBeTruthy();
  });
});
