import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { login, BASE } from "./api";
import { setMockNeonSession } from "./test-support/neonAuthMock";
import { fetchNeonJWT } from "./lib/auth";

// Simulates a user who already has a live Neon session — required for NeonAuthSync
// to not treat the app as signed-out and clear the pre-seeded backend token below.
function signInWithExistingToken() {
  localStorage.setItem("carpool_token", LOGIN_RESPONSE.access_token);
  setMockNeonSession({ user: { id: "usr_test", email: ME_RESPONSE.email, name: ME_RESPONSE.profile.display_name } });
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

    await login("mock.neon.jwt");

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
    vi.mocked(fetchNeonJWT).mockResolvedValue("mock.neon.jwt");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows sign-in screen when no token is stored", () => {
    mockFetch({});
    render(<MemoryRouter><App /></MemoryRouter>);
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

    render(<MemoryRouter><App /></MemoryRouter>);
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

    render(<MemoryRouter><App /></MemoryRouter>);
    await user.type(screen.getByPlaceholderText(/ada rider/i), "Ada Rider");
    await user.type(screen.getByPlaceholderText(/you@example\.com/i), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /sign in \/ sign up/i }));

    await waitFor(() => screen.getByText(/find your ride/i));
  });

  it("shows a retryable error instead of hanging forever when the Neon Auth token can't be fetched", async () => {
    // Regression test: fetchNeonJWT() rejecting or resolving null used to
    // leave the app stuck on "Loading…" forever with no way forward.
    vi.mocked(fetchNeonJWT).mockRejectedValue(new Error("network down"));
    mockFetch({});
    signInWithExistingToken();

    render(<MemoryRouter><App /></MemoryRouter>);

    await waitFor(
      () => screen.getByText(/could not verify your session/i),
      { timeout: 8000 },
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();

    vi.mocked(fetchNeonJWT).mockResolvedValue("mock.neon.jwt");
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

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    // Switch to Driver mode so the post form defaults to a driver trip.
    await user.click(screen.getByRole("button", { name: /^driver$/i }));

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

    // Defaults to Passenger mode — post form should default to a ride request.
    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));
    expect(screen.getByRole("button", { name: /i need a ride/i })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /^feed$/i }));
    await user.click(screen.getByRole("button", { name: /^driver$/i }));
    await user.click(screen.getByRole("button", { name: /^post$/i }));
    await waitFor(() => screen.getByText(/post a listing/i));
    expect(screen.getByRole("button", { name: /i'm offering a ride/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("routes a first-time switch to Driver mode into vehicle setup", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": ME_RESPONSE, // ME_RESPONSE.vehicle is null — no vehicle on file
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    // Start from Passenger mode so switching to Driver is a real transition to observe.
    await user.click(screen.getByRole("button", { name: /^passenger$/i }));
    await user.click(screen.getByRole("button", { name: /^driver$/i }));

    await waitFor(() => screen.getByText(/driver readiness/i));
  });

  it("switches straight into Driver mode when a vehicle is already on file", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": { ...ME_RESPONSE, vehicle: { make: "Toyota", model: "Prius", color: "Blue", seats: 4 } },
      "GET /driver-trips/search": [],
      "GET /ride-requests/search": [],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    await user.click(screen.getByRole("button", { name: /^passenger$/i }));
    await user.click(screen.getByRole("button", { name: /^driver$/i }));

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

    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => screen.getByText(/find your ride/i));

    await user.click(screen.getByRole("button", { name: /^driver$/i }));
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

  it("keeps only one connection's chat open at a time, to avoid inbox clutter", async () => {
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

    await user.click(screen.getByRole("button", { name: /inbox/i }));
    await waitFor(() => screen.getByText("Driver Alpha"));
    expect(screen.getByText("Driver Beta")).toBeTruthy();

    const chatButtons = screen.getAllByRole("button", { name: /^chat$/i });
    await user.click(chatButtons[0]);
    await waitFor(() => screen.getByText("Message from Alpha"));

    await user.click(chatButtons[1]);
    await waitFor(() => screen.getByText("Message from Beta"));
    expect(screen.queryByText("Message from Alpha")).toBeNull();
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

    await user.click(screen.getByRole("button", { name: /profile/i }));
    await waitFor(() => screen.getByText("Ada Rider"));
  });
});
