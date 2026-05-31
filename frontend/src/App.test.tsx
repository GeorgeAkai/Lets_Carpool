import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// ─── helpers ──────────────────────────────────────────────────────────────────

function mockFetch(handlers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${url.replace("http://localhost:8000", "")}`;
      const matchKey = Object.keys(handlers).find((k) => {
        if (k === key) return true;
        // Support prefix match for dynamic routes like "POST /connections/con_123/transition"
        const [km, kp] = k.split(" ");
        if (km !== method) return false;
        const urlPath = url.replace("http://localhost:8000", "").split("?")[0];
        return urlPath.startsWith(kp);
      });
      const body = matchKey ? handlers[matchKey] : { detail: "Not found" };
      return {
        ok: matchKey !== undefined,
        status: matchKey !== undefined ? 200 : 404,
        json: async () => body,
      };
    })
  );
}

const ME_RESPONSE = {
  id: "usr_abc",
  email: "ada@example.com",
  email_domain: "example.com",
  profile: { user_id: "usr_abc", display_name: "Ada Rider", photo_url: null, bio: null },
  vehicle: null,
};

const LOGIN_RESPONSE = {
  access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfYWJjIn0.sig",
  token_type: "bearer",
  user: ME_RESPONSE,
};

const DRIVER_TRIP_1 = {
  id: "trp_1",
  driver_id: "usr_driver",
  pickup: { id: "loc_1", label: "Brookline", exact: false },
  destination: { id: "loc_2", label: "Logan Airport", exact: false },
  target_date: "2026-06-03",
  flexibility: "morning",
  seats_available: 3,
  seats_reserved: 1,
  tags: ["airport"],
  status: "open",
  created_at: "2026-05-24T00:00:00Z",
};

const RIDE_REQUEST_1 = {
  id: "rrq_1",
  rider_id: "usr_rider",
  pickup: { id: "loc_3", label: "Cambridge", exact: false },
  destination: { id: "loc_4", label: "Providence, RI", exact: false },
  target_date: "2026-06-04",
  flexibility: "flexible",
  passenger_count: 2,
  tags: ["student"],
  status: "open",
  created_at: "2026-05-24T00:00:00Z",
};

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Auth gate", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows sign-in screen when no token is stored", () => {
    mockFetch({});
    render(<App />);
    expect(screen.getByRole("button", { name: /sign in \/ sign up/i })).toBeTruthy();
  });

  it("calls POST /auth/login and stores token on sign-in", async () => {
    const user = userEvent.setup();
    mockFetch({
      "POST /auth/login": LOGIN_RESPONSE,
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<App />);
    await user.type(screen.getByPlaceholderText(/ada rider/i), "Ada Rider");
    await user.type(screen.getByPlaceholderText(/you@example\.com/i), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /sign in \/ sign up/i }));

    await waitFor(() =>
      expect(localStorage.getItem("carpool_token")).toBe(LOGIN_RESPONSE.access_token)
    );
  });

  it("shows main app after successful sign-in", async () => {
    const user = userEvent.setup();
    mockFetch({
      "POST /auth/login": LOGIN_RESPONSE,
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<App />);
    await user.type(screen.getByPlaceholderText(/ada rider/i), "Ada Rider");
    await user.type(screen.getByPlaceholderText(/you@example\.com/i), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /sign in \/ sign up/i }));

    await waitFor(() => screen.getByText(/find your ride/i));
  });
});

describe("Feed view", () => {
  beforeEach(() => {
    localStorage.setItem("carpool_token", LOGIN_RESPONSE.access_token);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("loads driver trips from the API on mount", async () => {
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [DRIVER_TRIP_1],
      "GET /ride-requests/search": [],
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText("Logan Airport")).toBeTruthy()
    );
  });

  it("loads ride requests from the API on mount", async () => {
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [RIDE_REQUEST_1],
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText("Providence, RI")).toBeTruthy()
    );
  });

  it("filters by type when filter button is clicked", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [DRIVER_TRIP_1],
      "GET /ride-requests/search": [RIDE_REQUEST_1],
    });

    render(<App />);
    await waitFor(() => screen.getByText("Logan Airport"));

    // Click "Offering rides" filter — only driver trips should show
    await user.click(screen.getByRole("button", { name: /offering rides/i }));
    expect(screen.queryByText("Providence, RI")).toBeNull();
    expect(screen.getByText("Logan Airport")).toBeTruthy();
  });

  it("shows connect button and navigates to connections after clicking", async () => {
    const user = userEvent.setup();
    const LOC = { id: "loc_tmp", label: "tmp", exact: true };
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [DRIVER_TRIP_1],
      "GET /ride-requests/search": [],
      "POST /locations": LOC,
      "POST /ride-requests": RIDE_REQUEST_1,
      "POST /connections": {
        id: "con_1",
        ride_request_id: "rrq_1",
        driver_trip_id: "trp_1",
        status: "pending",
        created_at: "2026-05-24T00:00:00Z",
        updated_at: "2026-05-24T00:00:00Z",
        ride_request: RIDE_REQUEST_1,
        driver_trip: DRIVER_TRIP_1,
      },
    });

    render(<App />);
    await waitFor(() => screen.getByText("Logan Airport"));

    const connectBtn = screen.getByRole("button", { name: /request to join/i });
    await user.click(connectBtn);

    await waitFor(() => screen.getByText(/track pending offers/i));
  });
});

describe("Post listing view", () => {
  beforeEach(() => {
    localStorage.setItem("carpool_token", LOGIN_RESPONSE.access_token);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("submits a driver trip to the API", async () => {
    const fetchMock = vi.fn();
    const user = userEvent.setup();

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.replace("http://localhost:8000", "");
      if (path === "/me") return { ok: true, json: async () => ME_RESPONSE };
      if (path.startsWith("/driver-trips/search")) return { ok: true, json: async () => [] };
      if (path.startsWith("/ride-requests/search")) return { ok: true, json: async () => [] };
      if (path === "/locations") return { ok: true, json: async () => ({ id: "loc_new", label: "test", exact: true }) };
      if (path === "/driver-trips")
        return {
          ok: true,
          json: async () => ({
            id: "trp_new",
            driver_id: "usr_abc",
            pickup: { id: "loc_new", label: "Allston", exact: true },
            destination: { id: "loc_new2", label: "South Station", exact: true },
            target_date: "2026-06-08",
            flexibility: "morning",
            seats_available: 2,
            seats_reserved: 0,
            tags: [],
            status: "open",
            created_at: "2026-05-24T00:00:00Z",
          }),
        };
      return { ok: false, json: async () => ({ detail: "not found" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => screen.getByText(/find your ride/i));

    // Navigate to Post view
    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));

    // Fill in the form
    const [fromInput, toInput] = screen.getAllByRole("textbox").filter(
      (el) => (el as HTMLInputElement).placeholder?.match(/area|destination/i)
    );
    await user.type(fromInput ?? screen.getAllByRole("textbox")[0], "Allston");
    await user.type(toInput ?? screen.getAllByRole("textbox")[1], "South Station");

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-06-08" } });

    await user.click(screen.getByRole("button", { name: /post listing/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]: [string]) => url.replace("http://localhost:8000", ""));
      expect(calls).toContain("/locations");
      expect(calls).toContain("/driver-trips");
    });
  });
});

describe("Connections view", () => {
  beforeEach(() => {
    localStorage.setItem("carpool_token", LOGIN_RESPONSE.access_token);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("accepts a connection via the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();

    const connection = {
      id: "con_1",
      ride_request_id: "rrq_1",
      driver_trip_id: "trp_1",
      initiator_user_id: "usr_rider",
      status: "pending",
      created_at: "2026-05-24T00:00:00Z",
      updated_at: "2026-05-24T00:00:00Z",
      ride_request: RIDE_REQUEST_1,
      driver_trip: DRIVER_TRIP_1,
    };

    const LOC = { id: "loc_tmp", label: "tmp", exact: true };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.replace("http://localhost:8000", "");
      if (path === "/me") return { ok: true, json: async () => ME_RESPONSE };
      if (path.startsWith("/driver-trips/search")) return { ok: true, json: async () => [DRIVER_TRIP_1] };
      if (path.startsWith("/ride-requests/search")) return { ok: true, json: async () => [] };
      if (path === "/locations") return { ok: true, json: async () => LOC };
      if (path === "/ride-requests") return { ok: true, json: async () => RIDE_REQUEST_1 };
      if (path === "/connections") return { ok: true, json: async () => connection };
      if (path.includes("/transition")) return { ok: true, json: async () => ({ ...connection, status: "accepted" }) };
      return { ok: false, json: async () => ({ detail: "not found" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => screen.getByText("Logan Airport"));

    // Create a connection by clicking connect
    await user.click(screen.getByRole("button", { name: /request to join/i }));
    await waitFor(() => screen.getByText(/track pending offers/i));

    // Accept the connection
    const acceptBtn = screen.getByRole("button", { name: /accept/i });
    await user.click(acceptBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]: [string]) =>
        url.replace("http://localhost:8000", "")
      );
      expect(calls.some((c) => c.includes("/transition"))).toBe(true);
    });
  });

  it("declines a connection via the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();

    const connection = {
      id: "con_1",
      ride_request_id: "rrq_1",
      driver_trip_id: "trp_1",
      initiator_user_id: "usr_rider",
      status: "pending",
      created_at: "2026-05-24T00:00:00Z",
      updated_at: "2026-05-24T00:00:00Z",
      ride_request: RIDE_REQUEST_1,
      driver_trip: DRIVER_TRIP_1,
    };

    const LOC = { id: "loc_tmp", label: "tmp", exact: true };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.replace("http://localhost:8000", "");
      if (path === "/me") return { ok: true, json: async () => ME_RESPONSE };
      if (path.startsWith("/driver-trips/search")) return { ok: true, json: async () => [DRIVER_TRIP_1] };
      if (path.startsWith("/ride-requests/search")) return { ok: true, json: async () => [] };
      if (path === "/locations") return { ok: true, json: async () => LOC };
      if (path === "/ride-requests") return { ok: true, json: async () => RIDE_REQUEST_1 };
      if (path === "/connections") return { ok: true, json: async () => connection };
      if (path.includes("/transition")) return { ok: true, json: async () => ({ ...connection, status: "declined" }) };
      return { ok: false, json: async () => ({ detail: "not found" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => screen.getByText("Logan Airport"));

    await user.click(screen.getByRole("button", { name: /request to join/i }));
    await waitFor(() => screen.getByText(/track pending offers/i));

    const declineBtn = screen.getByRole("button", { name: /decline/i });
    await user.click(declineBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]: [string]) =>
        url.replace("http://localhost:8000", "")
      );
      expect(calls.some((c) => c.includes("/transition"))).toBe(true);
    });
  });
});

describe("Profile view", () => {
  beforeEach(() => {
    localStorage.setItem("carpool_token", LOGIN_RESPONSE.access_token);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows the current user's display name", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<App />);
    await waitFor(() => screen.getByText(/find your ride/i));

    await user.click(screen.getByRole("button", { name: /profile/i }));
    await waitFor(() => screen.getByText("Ada Rider"));
  });
});
