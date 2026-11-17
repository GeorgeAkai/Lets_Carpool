import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { BASE } from "../api";
import { readCache, writeCache } from "../lib/cache";
import { setMockAuthSession } from "../test-support/authMock";

// The app opens on what it showed last time, then replaces it when the server answers.

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const ME = {
  id: "usr_me", email: "sam@example.com", email_domain: "example.com", status: "active", onboarded_at: "2026-01-01T00:00:00Z",
  profile: { user_id: "usr_me", display_name: "Sam Passenger", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
  vehicle: null,
};
const trip = (id: string, driver: string, to: string) => ({
  id, driver_id: `usr_${id}`, driver_name: driver, driver_photo_url: null,
  pickup: { id: "a", label: "Elm St, Chico, CA", exact: false }, destination: { id: "b", label: to, exact: false },
  target_date: today, flexibility: "morning", seats_available: 3, seats_reserved: 0, tags: [], status: "open",
  created_at: new Date().toISOString(), luggage_capacity: "medium", car_type: "sedan", notes: null,
});

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  localStorage.setItem("carpool_token", "tok");
  setMockAuthSession({ user: { id: "sb_me", email: ME.email, name: ME.profile.display_name } });
  sessionStorage.setItem("carpool_mode", "rider");
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Opening the app with data from last time", () => {
  it("shows the remembered listings before the server has answered anything, then the fresh ones", async () => {
    // First visit: the server answers and the app remembers it.
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    let hold = false;
    let feed = [trip("old", "Olive Oldlisting", "Reno, NV")];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit): Promise<Answer> => {
      if (hold) await held; // a slow network on the second visit
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).replace(BASE, "").split("?")[0]}`;
      const routes: Record<string, unknown> = {
        "GET /me": ME, "GET /driver-trips/search": feed, "GET /ride-requests/search": [], "GET /me/routes": [],
        "GET /me/connections": [], "GET /notifications": [], "GET /me/driver-trips": [], "GET /me/ride-requests": [],
      };
      return key in routes ? { ok: true, status: 200, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    }));
    const first = render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    expect((await screen.findAllByText("Olive Oldlisting")).length).toBeGreaterThan(0);
    await waitFor(() => expect(readCache<{ id: string }>("me")?.id).toBe("usr_me"));
    await waitFor(() => expect(readCache<unknown[]>("usr_me:feed")?.length).toBe(1));
    first.unmount();

    // Second visit: nothing has come back from the server yet.
    hold = true;
    feed = [trip("new", "Nora Newlisting", "Tahoe City, CA")];
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    expect(screen.getAllByText("Olive Oldlisting").length).toBeGreaterThan(0); // immediately, no loading screen
    expect(screen.queryByText("Nora Newlisting")).toBeNull();

    // The server answers: the screen updates.
    release();
    expect((await screen.findAllByText("Nora Newlisting")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText("Olive Oldlisting")).toBeNull());
  });

  it("starts empty for someone who is not signed in on this device", async () => {
    writeCache("me", ME);
    writeCache("usr_me:feed", []);
    localStorage.removeItem("carpool_token");
    setMockAuthSession(null);
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Answer> => ({ ok: false, status: 401, json: async () => ({ detail: "nope" }) })));
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    // No remembered user is shown, and the leftovers are wiped once the session is confirmed gone.
    expect(screen.queryByText("Sam Passenger")).toBeNull();
    await waitFor(() => expect(readCache("me")).toBeNull());
  });
});

describe("Discover", () => {
  it("leaves out a ride with no seats remaining", async () => {
    const full = { ...trip("full", "Fiona Fullcar", "Reno, NV"), seats_available: 2, seats_reserved: 2, status: "matched" };
    const open = trip("open", "Owen Openseat", "Reno, NV");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit): Promise<Answer> => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).replace(BASE, "").split("?")[0]}`;
      const routes: Record<string, unknown> = {
        "GET /me": ME, "GET /driver-trips/search": [full, open], "GET /ride-requests/search": [], "GET /me/routes": [],
        "GET /me/connections": [], "GET /notifications": [], "GET /me/driver-trips": [], "GET /me/ride-requests": [],
      };
      return key in routes ? { ok: true, status: 200, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    }));
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    expect((await screen.findAllByText("Owen Openseat")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Fiona Fullcar")).toBeNull();
  });

  it("narrows every ride on the page, best matches included, as the search box is typed in", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit): Promise<Answer> => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${String(url).replace(BASE, "").split("?")[0]}`;
      const routes: Record<string, unknown> = {
        "GET /me": ME, "GET /driver-trips/search": [trip("reno", "Rhea Reno", "Reno, NV"), trip("tahoe", "Theo Tahoe", "Tahoe City, CA")],
        "GET /ride-requests/search": [], "GET /me/routes": [],
        "GET /me/connections": [], "GET /notifications": [], "GET /me/driver-trips": [], "GET /me/ride-requests": [],
      };
      return key in routes ? { ok: true, status: 200, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
    }));
    render(<MemoryRouter initialEntries={["/discover"]}><App /></MemoryRouter>);
    // Both are promoted into "Best matches" once scored.
    await screen.findByText(/best matches for you/i);
    expect(screen.getAllByText("Rhea Reno").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Theo Tahoe").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText(/search destination/i), { target: { value: "tahoe" } });
    await waitFor(() => expect(screen.queryByText("Rhea Reno")).toBeNull());
    expect(screen.getAllByText("Theo Tahoe").length).toBeGreaterThan(0);

    // Everything shown is a best match, so the page does not also claim there are none.
    expect(screen.queryByText("No rides found")).toBeNull();
    expect(screen.queryByText("All listings")).toBeNull();

    // The name of who posted it works too.
    fireEvent.change(screen.getByPlaceholderText(/search destination/i), { target: { value: "rhea" } });
    await waitFor(() => expect(screen.queryByText("Theo Tahoe")).toBeNull());
    expect(screen.getAllByText("Rhea Reno").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText(/search destination/i), { target: { value: "nowhere" } });
    await waitFor(() => expect(screen.queryByText("Rhea Reno")).toBeNull());
    expect(screen.getByText("No rides found")).toBeTruthy();
  });
});
