const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

function token(): string | null {
  return localStorage.getItem("carpool_token");
}

function authHeaders(): HeadersInit {
  const t = token();
  return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(String(err?.detail ?? res.statusText));
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type LocationView = { id: string; label: string; exact: boolean; latitude?: number; longitude?: number };

export type ApiDriverTrip = {
  id: string;
  driver_id: string;
  pickup: LocationView;
  destination: LocationView;
  target_date: string;
  flexibility: string;
  seats_available: number;
  seats_reserved: number;
  tags: string[];
  status: string;
  created_at: string;
};

export type ApiRideRequest = {
  id: string;
  rider_id: string;
  pickup: LocationView;
  destination: LocationView;
  target_date: string;
  flexibility: string;
  passenger_count: number;
  tags: string[];
  status: string;
  created_at: string;
};

export type ApiConnection = {
  id: string;
  ride_request_id: string;
  driver_trip_id: string;
  initiator_user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  ride_request: ApiRideRequest;
  driver_trip: ApiDriverTrip;
  completed_confirmed_by?: string[];
};

export type ApiProfile = { user_id: string; display_name: string; photo_url: string | null; bio: string | null };
export type ApiVehicle = {
  user_id: string;
  make: string | null;
  model: string | null;
  color: string | null;
  seats: number | null;
  has_license: boolean;
  has_insurance: boolean;
  has_good_driving_record: boolean;
} | null;

export type ApiUser = {
  id: string;
  email: string;
  email_domain: string;
  profile: ApiProfile;
  vehicle: ApiVehicle;
};

export type HealthResponse = {
  status: "ok";
  service: string;
  database: { configured: boolean; engine: "postgresql"; postgis_extension: "required" };
};

export type SearchQuery = {
  destination_latitude?: number;
  destination_longitude?: number;
  destination_radius_meters?: number;
  pickup_latitude?: number;
  pickup_longitude?: number;
  pickup_radius_meters?: number;
  target_date?: string;
  tag?: string;
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(name: string, email: string): Promise<ApiUser> {
  const res = await request<{ access_token: string; user: ApiUser }>("POST", "/auth/login", {
    name,
    email,
  });
  localStorage.setItem("carpool_token", res.access_token);
  return res.user;
}

export function logout(): void {
  localStorage.removeItem("carpool_token");
}

// ─── User / Profile ───────────────────────────────────────────────────────────

export function getMe(): Promise<ApiUser> {
  return request<ApiUser>("GET", "/me");
}

export function updateProfile(displayName: string, photoUrl?: string | null, bio?: string | null): Promise<ApiProfile> {
  return request<ApiProfile>("PATCH", "/me/profile", { display_name: displayName, photo_url: photoUrl, bio });
}

export function updateDriverReadiness(data: {
  make?: string;
  model?: string;
  color?: string;
  seats?: number;
  has_license?: boolean;
  has_insurance?: boolean;
  has_good_driving_record?: boolean;
}): Promise<NonNullable<ApiVehicle>> {
  return request("PUT", "/me/driver-readiness", data);
}

// ─── Locations ────────────────────────────────────────────────────────────────

export function createLocation(label: string, latitude: number, longitude: number): Promise<LocationView> {
  return request<LocationView>("POST", "/locations", { label, latitude, longitude });
}

// ─── Driver trips ─────────────────────────────────────────────────────────────

export function searchDriverTrips(query: SearchQuery = {}): Promise<ApiDriverTrip[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return request<ApiDriverTrip[]>("GET", `/driver-trips/search${qs ? `?${qs}` : ""}`);
}

export function createDriverTrip(data: {
  pickup_location_id: string;
  destination_location_id: string;
  target_date: string;
  flexibility: string;
  seats_available: number;
  tags: string[];
}): Promise<ApiDriverTrip> {
  return request<ApiDriverTrip>("POST", "/driver-trips", data);
}

export function cancelDriverTrip(tripId: string): Promise<ApiDriverTrip> {
  return request<ApiDriverTrip>("POST", `/driver-trips/${tripId}/cancel`);
}

// ─── Ride requests ────────────────────────────────────────────────────────────

export function searchRideRequests(query: SearchQuery = {}): Promise<ApiRideRequest[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return request<ApiRideRequest[]>("GET", `/ride-requests/search${qs ? `?${qs}` : ""}`);
}

export function createRideRequest(data: {
  pickup_location_id: string;
  destination_location_id: string;
  target_date: string;
  flexibility: string;
  passenger_count: number;
  tags: string[];
}): Promise<ApiRideRequest> {
  return request<ApiRideRequest>("POST", "/ride-requests", data);
}

export function cancelRideRequest(requestId: string): Promise<ApiRideRequest> {
  return request<ApiRideRequest>("POST", `/ride-requests/${requestId}/cancel`);
}

// ─── Connections ──────────────────────────────────────────────────────────────

export function createConnection(rideRequestId: string, driverTripId: string): Promise<ApiConnection> {
  return request<ApiConnection>("POST", "/connections", {
    ride_request_id: rideRequestId,
    driver_trip_id: driverTripId,
  });
}

export function transitionConnection(connectionId: string, action: "accept" | "decline" | "cancel" | "complete"): Promise<ApiConnection> {
  return request<ApiConnection>("POST", `/connections/${connectionId}/transition`, { action });
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export type ApiMessage = {
  id: string;
  connection_id: string;
  sender_id: string;
  content: string;
  kind: "canned" | "free_text";
  created_at: string;
};

export function getMessages(connectionId: string): Promise<ApiMessage[]> {
  return request<ApiMessage[]>("GET", `/connections/${connectionId}/messages`);
}

export function sendCannedMessage(connectionId: string, cannedKey: string): Promise<ApiMessage> {
  return request<ApiMessage>("POST", `/connections/${connectionId}/messages`, { canned_key: cannedKey });
}

export function sendMessage(connectionId: string, content: string): Promise<ApiMessage> {
  return request<ApiMessage>("POST", `/connections/${connectionId}/messages`, { content });
}

// ─── Gas split ────────────────────────────────────────────────────────────────

export type GasSplitSuggestion = { amount_cents: number; currency: string; assumptions: Record<string, unknown> };
export type GasSplitConfirmation = { id: string; connection_id: string; confirmer_id: string; amount_cents: number; currency: string; assumptions: Record<string, unknown>; created_at: string };

export function suggestGasSplit(connectionId: string): Promise<GasSplitSuggestion> {
  return request<GasSplitSuggestion>("GET", `/connections/${connectionId}/gas-split/suggestion`);
}

export function confirmGasSplit(connectionId: string, amountCents: number, assumptions: Record<string, unknown> = {}): Promise<GasSplitConfirmation> {
  return request<GasSplitConfirmation>("POST", `/connections/${connectionId}/gas-split/confirm`, {
    amount_cents: amountCents,
    currency: "USD",
    assumptions,
  });
}

// ─── Users ────────────────────────────────────────────────────────────────────

export function blockUser(targetUserId: string): Promise<{ status: string }> {
  return request<{ status: string }>("POST", `/users/${targetUserId}/block`);
}

export function reportUser(targetUserId: string, reason: string): Promise<unknown> {
  return request<unknown>("POST", `/users/${targetUserId}/report`, { reason });
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type ApiNotification = { id: string; user_id: string; type: string; title: string; body: string; created_at: string; read: boolean };

export function getNotifications(): Promise<ApiNotification[]> {
  return request<ApiNotification[]>("GET", "/notifications");
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function fetchHealth(apiBaseUrl = BASE): Promise<HealthResponse> {
  const res = await fetch(`${apiBaseUrl}/health`);
  if (!res.ok) throw new Error(`Healthcheck failed: ${res.status}`);
  return res.json() as Promise<HealthResponse>;
}
