import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { login, BASE } from "./api";
import { setMockAuthSession } from "./test-support/authMock";
import { getAccessToken } from "./lib/auth";

// Simulates a user who already has a live auth session — required for AuthSync
// to not treat the app as signed-out and clear the pre-seeded backend token below.
// Also pre-seeds the mode-choice gate's sessionStorage flag as already-answered
// (Passenger), so tests that aren't specifically about the gate itself land
// straight on Discover exactly like before it existed — test-setup.ts clears
// sessionStorage before every test, so without this every test would hit the
// gate first.
function signInWithExistingToken() {
  localStorage.setItem("carpool_token", LOGIN_RESPONSE.access_token);
  setMockAuthSession({ user: { id: "usr_test", email: ME_RESPONSE.email, name: ME_RESPONSE.profile.display_name } });
  sessionStorage.setItem("carpool_mode", "rider");
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function mockFetch(handlers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const cleanUrl = String(url).replace(BASE, "");
      const urlPath = cleanUrl.split("?")[0];
      const key = `${method} ${urlPath}`;
      const matchKey = Object.prototype.hasOwnProperty.call(handlers, key) ? key : undefined;
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
  onboarded_at: "2026-01-01T00:00:00Z",
  profile: { user_id: "usr_abc", display_name: "Ada Rider", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
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

describe("API configuration", () => {
  it("sends requests to the configured VITE_API_BASE_URL", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "token", token_type: "bearer", user: ME_RESPONSE }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await login("mock.supabase.jwt");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/auth/login`, expect.any(Object));
  });
});

describe("Auth gate", () => {
  beforeEach(() => {
    localStorage.clear();
    // Guards against the "retryable error" test below leaking its rejected
    // mock into every later test if it ever fails before reaching its own
    // cleanup line — vi.restoreAllMocks() doesn't reset plain vi.fn() mocks
    // created inside vi.mock(), only ones made with vi.spyOn().
    vi.mocked(getAccessToken).mockResolvedValue("mock.supabase.jwt");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows sign-in screen when no token is stored", () => {
    mockFetch({});
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeTruthy();
  });

  it("calls POST /auth/login and stores token on sign-in", async () => {
    const user = userEvent.setup();
    mockFetch({
      "POST /auth/login": LOGIN_RESPONSE,
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    await user.type(screen.getByPlaceholderText(/you@example\.com/i), "ada@example.com");
    await user.type(screen.getByPlaceholderText(/^password$/i), "password123");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

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

    render(<MemoryRouter><App /></MemoryRouter>);
    await user.type(screen.getByPlaceholderText(/you@example\.com/i), "ada@example.com");
    await user.type(screen.getByPlaceholderText(/^password$/i), "password123");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => screen.getByText(/find your ride/i));
  });

  it("shows a retryable error instead of hanging forever when the access token can't be fetched", async () => {
    // Regression test: getAccessToken() rejecting or resolving null used to
    // leave the app stuck on "Loading…" forever with no way forward.
    vi.mocked(getAccessToken).mockRejectedValue(new Error("network down"));
    mockFetch({});
    signInWithExistingToken();

    render(<MemoryRouter><App /></MemoryRouter>);

    await waitFor(
      () => screen.getByText(/could not verify your session/i),
      { timeout: 8000 },
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();

    vi.mocked(getAccessToken).mockResolvedValue("mock.supabase.jwt");
  }, 10000);
});

describe("Feed view", () => {
  beforeEach(() => {
    signInWithExistingToken();
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

    render(<MemoryRouter><App /></MemoryRouter>);

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

    render(<MemoryRouter><App /></MemoryRouter>);

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

    render(<MemoryRouter><App /></MemoryRouter>);
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

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText("Logan Airport"));

    const connectBtn = screen.getByRole("button", { name: /instant request match/i });
    await user.click(connectBtn);

    await waitFor(() => screen.getByText(/track pending offers/i));
  });
});

describe("Post listing view", () => {
  beforeEach(() => {
    signInWithExistingToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("submits a driver trip to the API", async () => {
    const fetchMock = vi.fn();
    const user = userEvent.setup();

    const nominatimResult = (place_id: number, name: string) => ({
      place_id, name, display_name: `${name}, MA, USA`, lat: "42.3", lon: "-71.1",
      address: { city: name },
    });

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const rawUrl = String(url);
      if (rawUrl.startsWith("https://nominatim.openstreetmap.org/search")) {
        const q = new URL(rawUrl).searchParams.get("q") ?? "";
        return { ok: true, json: async () => [nominatimResult(1, q)] };
      }
      const path = rawUrl.replace(BASE, "");
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
    // Driver mode, so the post form is locked to a driver trip.
    sessionStorage.setItem("carpool_mode", "driver");

    render(<MemoryRouter><App /></MemoryRouter>);
    // Driver mode is pre-seeded before render, so Discover shows DriverHomeView
    // ("Your route") rather than the rider-mode "Find your ride" heading.
    await waitFor(() => screen.getByRole("heading", { name: /^your route$/i }));

    // Navigate to Post view
    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));

    // Fill in the from/to location autocompletes and pick the geocoded suggestion
    const [fromInput, toInput] = screen.getAllByRole("textbox").filter(
      (el) => (el as HTMLInputElement).placeholder?.match(/area|destination/i)
    );
    // The <li role="option"> just wraps the real clickable element — the button
    // inside it holds the onMouseDown handler that actually selects the suggestion.
    await user.type(fromInput ?? screen.getAllByRole("textbox")[0], "Allston");
    await screen.findByRole("option", { name: /allston/i });
    fireEvent.mouseDown(screen.getByRole("button", { name: /allston/i }));
    await user.type(toInput ?? screen.getAllByRole("textbox")[1], "South Station");
    await screen.findByRole("option", { name: /south station/i });
    fireEvent.mouseDown(screen.getByRole("button", { name: /south station/i }));

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-06-08" } });

    await user.click(screen.getByRole("button", { name: /post listing/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]: unknown[]) => String(url).replace(BASE, ""));
      expect(calls).toContain("/locations");
      expect(calls).toContain("/driver-trips");
    });
  });

  it("defaults the post form to the currently selected Passenger/Driver mode", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    // Defaults to Passenger mode (pre-seeded) — post form is locked to a ride
    // request, with no interactive toggle (PostView no longer has one).
    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));
    expect(screen.getByText(/requesting a ride/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /i need a ride/i })).toBeNull();

    // Switch to Driver mode from the Driver mode switch on Profile.
    await user.click(screen.getAllByRole("button", { name: /^profile$/i })[0]);
    await user.click(screen.getByRole("checkbox", { name: /driver mode/i }));

    await user.click(screen.getAllByRole("button", { name: /^discover$/i })[0]);
    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));
    expect(screen.getByText(/offering a ride/i)).toBeTruthy();
  });

  it("routes a first-time switch to Driver mode into vehicle setup", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE, // ME_RESPONSE.vehicle is null — no vehicle on file
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });
    // Force the mode-choice gate to show, so choosing Driver here is a real
    // first-time choice — this is now the vehicle-check's real entry point.
    sessionStorage.removeItem("carpool_mode");

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/how are you riding today/i));
    await user.click(screen.getByRole("button", { name: /i'm offering a ride/i }));

    await waitFor(() => screen.getByText(/driver readiness/i));
  });

  it("switches straight into Driver mode when a vehicle is already on file", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": { ...ME_RESPONSE, vehicle: { make: "Toyota", model: "Prius", color: "Blue", seats: 4 } },
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });
    sessionStorage.removeItem("carpool_mode");

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/how are you riding today/i));
    await user.click(screen.getByRole("button", { name: /i'm offering a ride/i }));

    expect(screen.queryByText(/driver readiness/i)).toBeNull();
    await waitFor(() => expect(screen.getByRole("heading", { name: /^your route$/i })).toBeTruthy());
  });

  it("auto-fills the vehicle field on the post form from the saved vehicle profile", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": { ...ME_RESPONSE, vehicle: { make: "Prius", model: "Prius", color: "Blue", seats: 4, car_type: "sedan" } },
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });
    sessionStorage.setItem("carpool_mode", "driver");

    render(<MemoryRouter><App /></MemoryRouter>);
    // Driver mode is pre-seeded before render, so Discover shows DriverHomeView
    // ("Your route") rather than the rider-mode "Find your ride" heading.
    await waitFor(() => screen.getByRole("heading", { name: /^your route$/i }));

    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));

    expect(screen.getByText(/auto-filled from your profile/i)).toBeTruthy();
    const vehicleInput = screen.getByPlaceholderText(/subaru outback/i) as HTMLInputElement;
    expect(vehicleInput.value).toBe("Blue Prius Prius");
  });
});

describe("Connections view", () => {
  beforeEach(() => {
    signInWithExistingToken();
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
      const path = String(url).replace(BASE, "");
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

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText("Logan Airport"));

    // Create a connection by clicking connect
    await user.click(screen.getByRole("button", { name: /instant request match/i }));
    await waitFor(() => screen.getByText(/track pending offers/i));

    // Accept the connection
    const acceptBtn = screen.getByRole("button", { name: /accept/i });
    await user.click(acceptBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]: unknown[]) =>
        String(url).replace(BASE, "")
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
      const path = String(url).replace(BASE, "");
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

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText("Logan Airport"));

    await user.click(screen.getByRole("button", { name: /instant request match/i }));
    await waitFor(() => screen.getByText(/track pending offers/i));

    const declineBtn = screen.getByRole("button", { name: /decline/i });
    await user.click(declineBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]: unknown[]) =>
        String(url).replace(BASE, "")
      );
      expect(calls.some((c) => c.includes("/transition"))).toBe(true);
    });
  });

  it("shows a master-detail inbox where selecting a conversation swaps the chat pane", async () => {
    const user = userEvent.setup();

    const makeConnection = (id: string, driverId: string, driverName: string) => ({
      id, ride_request_id: `rrq_${id}`, driver_trip_id: `trp_${id}`,
      initiator_user_id: "usr_abc", status: "accepted",
      created_at: "2026-05-24T00:00:00Z", updated_at: "2026-05-24T00:00:00Z",
      ride_request: { ...RIDE_REQUEST_1, id: `rrq_${id}`, rider_id: "usr_abc" },
      driver_trip: { ...DRIVER_TRIP_1, id: `trp_${id}`, driver_id: driverId },
      driver_profile: { user_id: driverId, display_name: driverName, photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null },
    });
    const connectionA = makeConnection("con_a", "usr_driver_a", "Driver Alpha");
    const connectionB = makeConnection("con_b", "usr_driver_b", "Driver Beta");

    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
      "GET /me/connections": [connectionA, connectionB],
      "GET /connections/con_a/messages": [
        { id: "msg_a", connection_id: "con_a", sender_id: "usr_driver_a", content: "Message from Alpha", kind: "free_text", created_at: "2026-05-24T00:00:00Z" },
      ],
      "GET /connections/con_b/messages": [
        { id: "msg_b", connection_id: "con_b", sender_id: "usr_driver_b", content: "Message from Beta", kind: "free_text", created_at: "2026-05-24T00:00:00Z" },
      ],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    await user.click(screen.getAllByRole("button", { name: /^inbox$/i })[0]);

    // Desktop auto-opens the first conversation in the detail pane, and each
    // list row previews its thread's last message.
    await waitFor(() => expect(screen.getByRole("region", { name: /conversation/i })).toHaveTextContent("Message from Alpha"));
    const pane = () => screen.getByRole("region", { name: /conversation/i });
    expect(pane()).toHaveTextContent("Driver Alpha");
    expect(pane()).not.toHaveTextContent("Message from Beta");
    // Trip controls live in the pane header for accepted rides.
    expect(screen.getByRole("button", { name: /gas split/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /complete/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /driver beta/i }));
    await waitFor(() => expect(pane()).toHaveTextContent("Message from Beta"));
    expect(pane()).not.toHaveTextContent("Message from Alpha");
  });

  it("files declined and cancelled conversations under Archived", async () => {
    const user = userEvent.setup();
    const base = {
      ride_request_id: "rrq_1", driver_trip_id: "trp_1", initiator_user_id: "usr_abc",
      created_at: "2026-05-24T00:00:00Z", updated_at: "2026-05-24T00:00:00Z",
      ride_request: { ...RIDE_REQUEST_1, rider_id: "usr_abc" }, driver_trip: DRIVER_TRIP_1,
    };
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
      "GET /me/connections": [
        { ...base, id: "con_live", status: "accepted", driver_profile: { user_id: "usr_driver", display_name: "Live Driver", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null } },
        { ...base, id: "con_dead", status: "declined", driver_profile: { user_id: "usr_driver", display_name: "Declined Driver", photo_url: null, bio: null, photo_verified: false, interests: [], nationality: null } },
      ],
    });

    render(<MemoryRouter initialEntries={["/connections"]}><App /></MemoryRouter>);

    await waitFor(() => expect(screen.getAllByText("Live Driver").length).toBeGreaterThan(0));
    expect(screen.queryByText("Declined Driver")).toBeNull();

    await user.click(screen.getByRole("tab", { name: /archived/i }));
    await waitFor(() => expect(screen.getAllByText("Declined Driver").length).toBeGreaterThan(0));
    expect(screen.queryByText("Live Driver")).toBeNull();
  });
});

describe("My Rides view", () => {
  beforeEach(() => {
    signInWithExistingToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to active trips, keeps past ones under Past / Archive, and cleans up location labels", async () => {
    const user = userEvent.setup();
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const trip = (id: string, status: string, target_date: string, dest: string) => ({
      ...DRIVER_TRIP_1, id, driver_id: "usr_abc", status, target_date,
      pickup: { id: `p_${id}`, label: "Chico, Chico, California", exact: true, latitude: 39.7, longitude: -121.8 },
      destination: { id: `d_${id}`, label: dest, exact: true, latitude: 38.6, longitude: -121.5 },
    });
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
      "GET /me/driver-trips": [
        trip("trp_up", "open", future, "Sacramento, Sacramento County, California, United States"),
        trip("trp_old", "cancelled", "2026-01-02", "Reno, Nevada"),
      ],
      "GET /me/ride-requests": [],
    });

    sessionStorage.setItem("carpool_mode", "driver");
    render(<MemoryRouter initialEntries={["/my-rides"]}><App /></MemoryRouter>);

    await waitFor(() => screen.getByText("Sacramento, CA"));
    expect(screen.getByText("Chico, CA")).toBeTruthy();
    expect(screen.queryByText("Reno, NV")).toBeNull();
    expect(screen.getByRole("button", { name: /manage ride/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /view matches/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel listing/i })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /past \/ archive/i }));
    await waitFor(() => screen.getByText("Reno, NV"));
    expect(screen.queryByText("Sacramento, CA")).toBeNull();

    // Re-book pre-fills the post form with the old route.
    await user.click(screen.getByRole("button", { name: /re-book/i }));
    await waitFor(() => screen.getByText(/re-book this ride/i));
    expect((screen.getByPlaceholderText(/destination/i) as HTMLInputElement).value).toBe("Reno, NV");
  });
});

describe("Profile view", () => {
  beforeEach(() => {
    signInWithExistingToken();
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

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    // "Profile" now appears in both the desktop Sidebar and the mobile
    // BottomNav (present in the DOM together in jsdom, since Tailwind's
    // `hidden`/`xl:` classes aren't computed without real CSS) — either one
    // navigates the same place, so just take the first match.
    await user.click(screen.getAllByRole("button", { name: /^profile$/i })[0]);
    await waitFor(() => expect(screen.getAllByText("Ada Rider").length).toBeGreaterThan(0));
  });

  it("shows ride stats and account settings above the profile form", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
      "GET /me/impact": { shared_trips: 42, saved_cents: 31800, shared_km: 900, regular_buddies: 6, since: null },
      "GET /me/settlement": { method: "venmo", handle: "@ada", updated_at: "x" },
      "GET /me/emergency-contacts": [{ id: "emc_1", name: "Alex", relationship: null, phone: "+1 555 0100", share_mode: "every_trip", created_at: "x" }],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));
    await user.click(screen.getAllByRole("button", { name: /^profile$/i })[0]);

    await waitFor(() => expect(screen.getAllByText("42").length).toBe(2));
    expect(screen.getByText("$318")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /driver mode/i })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /settle up.*venmo/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /safety & emergency.*1 contact/i })).toBeTruthy();
  });

  it("saves profile + vehicle with one Save Changes button", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(BASE, "");
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/me") return { ok: true, json: async () => ME_RESPONSE };
      if (path.startsWith("/driver-trips/search") || path.startsWith("/ride-requests/search")) return { ok: true, json: async () => [] };
      if (method === "PATCH" && path === "/me/profile") return { ok: true, json: async () => ({ ...ME_RESPONSE.profile, bio: "Hi there" }) };
      if (method === "PUT" && path === "/me/driver-readiness") return { ok: true, json: async () => ({ make: "Honda" }) };
      return { ok: false, json: async () => ({ detail: "not found" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MemoryRouter initialEntries={["/profile"]}><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/driver readiness/i));

    expect(screen.queryByRole("button", { name: /save profile/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save vehicle/i })).toBeNull();
    const save = screen.getByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText(/^bio$/i), "Hi there");
    await user.type(screen.getByLabelText(/^make$/i), "Honda");
    await user.click(save);

    await waitFor(() => screen.getByText(/changes saved/i));
    const calls = fetchMock.mock.calls.map(([url, init]) => `${((init as RequestInit | undefined)?.method ?? "GET").toUpperCase()} ${String(url).replace(BASE, "")}`);
    expect(calls).toContain("PATCH /me/profile");
    expect(calls).toContain("PUT /me/driver-readiness");
  });

  it("keeps Sign out in the account menu only", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<MemoryRouter initialEntries={["/profile"]}><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/driver readiness/i));

    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /account/i }));
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /admin/i })).toBeNull();
  });

  it("My Rides only shows listings matching the current mode", async () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    mockFetch({
      "GET /me": ME_RESPONSE,
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
      "GET /me/driver-trips": [{ ...DRIVER_TRIP_1, driver_id: "usr_abc", target_date: future, destination: { id: "loc_d", label: "Driver Destination", exact: true } }],
      "GET /me/ride-requests": [{ ...RIDE_REQUEST_1, rider_id: "usr_abc", target_date: future, destination: { id: "loc_r", label: "Rider Destination", exact: true } }],
    });

    render(<MemoryRouter initialEntries={["/my-rides"]}><App /></MemoryRouter>);
    await waitFor(() => screen.getByRole("heading", { name: /^my rides$/i }));

    // Passenger mode (pre-seeded) — only ride requests, never driver trips.
    await waitFor(() => screen.getByText("Rider Destination"));
    expect(screen.getByText("Your ride requests")).toBeTruthy();
    expect(screen.queryByText("Driver Destination")).toBeNull();
  });
});
