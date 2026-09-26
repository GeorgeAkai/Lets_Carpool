import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { BASE } from "../api";

const USER = {
  id: "usr_abc", email: "ada@example.com", email_domain: "example.com", is_admin: false,
  profile: { user_id: "usr_abc", display_name: "Ada Rider", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
  vehicle: null,
};
const ADMIN = { ...USER, id: "usr_admin", email: "ageorge@akihlee.com", email_domain: "akihlee.com", is_admin: true };

const STATS = {
  total_users: 12, drivers: 5, passengers: 8, active_drivers: 3, active_riders: 4,
  completed_rides: 9, blocked_users: 1, reported_users: 2, open_reports: 2,
};

function stubApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = String(url).replace(BASE, "").split("?")[0];
    const key = `${method} ${path}`;
    if (key in routes) return { ok: true, status: 200, json: async () => routes[key] };
    return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Admin panel", () => {
  beforeEach(() => localStorage.setItem("carpool_token", "token"));
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("sends anyone but the superadmin to the 403 page", async () => {
    stubApi({ "GET /me": USER });
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/403 · forbidden/i));
  });

  it("sends signed-out visitors to sign in", async () => {
    localStorage.clear();
    stubApi({});
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    await waitFor(() => screen.getByRole("button", { name: /sign in \/ sign up/i }));
  });

  it("shows KPIs and lets the superadmin block a user", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({
      "GET /me": ADMIN,
      "GET /admin/stats": STATS,
      "GET /admin/users": [
        { id: "usr_x", email: "x@example.com", created_at: "2026-05-24T00:00:00Z", suspended: false, display_name: "Xavier", photo_url: null, is_driver: true, is_rider: false, open_reports: 1 },
      ],
      "POST /admin/users/usr_x/block": { id: "usr_x", suspended: true },
    });

    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);

    await waitFor(() => screen.getByText("Platform overview"));
    await waitFor(() => screen.getByText("5 drivers · 8 passengers"));
    expect(screen.getByText("1 / 2")).toBeTruthy();

    await user.click(await screen.findByRole("switch", { name: /block x@example\.com/i }));
    await waitFor(() => screen.getByRole("switch", { name: /unblock x@example\.com/i }));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/admin/users/usr_x/block") && (init as RequestInit).method === "POST")).toBe(true);
  });

  it("redirects to 403 when the API refuses admin access", async () => {
    // Client-side check passes (email matches) but the server says no.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url).replace(BASE, "").split("?")[0];
      if (path === "/me") return { ok: true, status: 200, json: async () => ADMIN };
      return { ok: false, status: 403, json: async () => ({ detail: "Forbidden" }) };
    }));
    render(<MemoryRouter initialEntries={["/admin"]}><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/403 · forbidden/i));
  });
});
