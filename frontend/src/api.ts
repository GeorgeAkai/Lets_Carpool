const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const WS_BASE = BASE.replace(/^http/, "ws");

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
  luggage_capacity: string;
  car_type: string | null;
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
  luggage_size: string;
  preferred_car_type: string | null;
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

export type ApiProfile = {
  user_id: string;
  display_name: string;
  photo_url: string | null;
  bio: string | null;
  photo_verified: boolean;
};

export type ApiVehicle = {
  user_id: string;
  make: string | null;
  model: string | null;
  color: string | null;
  seats: number | null;
  car_type: string | null;
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
  car_type?: string;
  luggage_size?: string;
};

export type ApiPool = {
  id: string;
  name: string;
  organizer_id: string;
  community_tag: string;
  description: string | null;
  trip_date: string;
  pickup: LocationView;
  destination: LocationView;
  max_participants: number;
  seats_per_vehicle: number;
  status: string;
  created_at: string;
  member_count: number;
  members: ApiPoolMembership[];
};

export type ApiPoolMembership = {
  pool_id: string;
  user_id: string;
  role: string;
  joined_at: string;
};

export type NearbyDriver = {
  user_id: string;
  display_name: string;
  latitude: number;
  longitude: number;
  heading: number | null;
  speed_kmh: number | null;
  distance_meters: number;
  car_type: string | null;
  vehicle: string | null;
  updated_at: string;
};

export type RouteSuggestion = {
  distance_km: number;
  straight_line_km: number;
  duration_minutes: number;
  fare_suggestion_cents: number;
  fare_assumptions: {
    gas_price_per_gallon_usd: number;
    mpg: number;
    passenger_count: number;
  };
};

// ─── WebSocket ────────────────────────────────────────────────────────────────

export type WsMessage =
  | { type: "chat_message"; connection_id: string; message: ApiMessage }
  | { type: "connection_update"; connection_id: string; status: string }
  | { type: "driver_nearby"; user_id: string; display_name: string; latitude: number; longitude: number; heading: number | null; car_type: string | null }
  | { type: "pong" };

export function createWebSocket(userId: string, onMessage: (msg: WsMessage) => void): WebSocket {
  const t = token();
  const ws = new WebSocket(`${WS_BASE}/ws/${userId}${t ? `?token=${t}` : ""}`);
  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as WsMessage;
      onMessage(data);
    } catch { /* ignore malformed */ }
  };
  // Keepalive ping every 20s
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 20000);
  ws.onclose = () => clearInterval(interval);
  return ws;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(name: string, email: string): Promise<ApiUser> {
  const res = await request<{ access_token: string; user: ApiUser }>("POST", "/auth/login", { name, email });
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

export function uploadPhoto(photoDataUrl: string): Promise<ApiProfile> {
  return request<ApiProfile>("POST", "/me/photo", { photo_data_url: photoDataUrl });
}

export function updateDriverReadiness(data: {
  make?: string;
  model?: string;
  color?: string;
  seats?: number;
  car_type?: string;
  has_license?: boolean;
  has_insurance?: boolean;
  has_good_driving_record?: boolean;
}): Promise<NonNullable<ApiVehicle>> {
  return request("PUT", "/me/driver-readiness", data);
}

export function updateLocation(lat: number, lng: number, heading?: number, speedKmh?: number): Promise<unknown> {
  return request("PUT", "/me/location", { latitude: lat, longitude: lng, heading, speed_kmh: speedKmh });
}

// ─── Nearby drivers ───────────────────────────────────────────────────────────

export function getNearbyDrivers(lat: number, lng: number, radiusMeters = 10000): Promise<NearbyDriver[]> {
  return request<NearbyDriver[]>("GET", `/drivers/nearby?lat=${lat}&lng=${lng}&radius_meters=${radiusMeters}`);
}

// ─── Route suggestion ─────────────────────────────────────────────────────────

export function suggestRoute(
  pickupLat: number, pickupLng: number,
  destLat: number, destLng: number,
  passengerCount = 1,
): Promise<RouteSuggestion> {
  return request<RouteSuggestion>(
    "GET",
    `/routes/suggest?pickup_lat=${pickupLat}&pickup_lng=${pickupLng}&dest_lat=${destLat}&dest_lng=${destLng}&passenger_count=${passengerCount}`,
  );
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
  luggage_capacity?: string;
  car_type?: string;
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
  luggage_size?: string;
  preferred_car_type?: string;
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

export type GasSplitSuggestion = {
  amount_cents: number;
  currency: string;
  assumptions: Record<string, unknown>;
};
export type GasSplitConfirmation = {
  id: string;
  connection_id: string;
  confirmer_id: string;
  amount_cents: number;
  currency: string;
  assumptions: Record<string, unknown>;
  created_at: string;
};

export function suggestGasSplit(connectionId: string): Promise<GasSplitSuggestion> {
  return request<GasSplitSuggestion>("GET", `/connections/${connectionId}/gas-split/suggestion`);
}

export function confirmGasSplit(connectionId: string, amountCents: number, assumptions: Record<string, unknown> = {}): Promise<GasSplitConfirmation> {
  return request<GasSplitConfirmation>("POST", `/connections/${connectionId}/gas-split/confirm`, {
    amount_cents: amountCents, currency: "USD", assumptions,
  });
}

// ─── Community Pools ──────────────────────────────────────────────────────────

export function listPools(communityTag?: string, tripDate?: string): Promise<ApiPool[]> {
  const params = new URLSearchParams();
  if (communityTag) params.set("community_tag", communityTag);
  if (tripDate) params.set("trip_date", tripDate);
  const qs = params.toString();
  return request<ApiPool[]>("GET", `/pools${qs ? `?${qs}` : ""}`);
}

export function createPool(data: {
  name: string;
  community_tag: string;
  trip_date: string;
  pickup_location_id: string;
  destination_location_id: string;
  max_participants: number;
  description?: string;
  seats_per_vehicle?: number;
}): Promise<ApiPool> {
  return request<ApiPool>("POST", "/pools", data);
}

export function joinPool(poolId: string, role: "passenger" | "driver" = "passenger"): Promise<ApiPoolMembership> {
  return request<ApiPoolMembership>("POST", `/pools/${poolId}/join`, { role });
}

export function leavePool(poolId: string): Promise<{ status: string }> {
  return request<{ status: string }>("POST", `/pools/${poolId}/leave`);
}

// ─── Users ────────────────────────────────────────────────────────────────────

export function blockUser(targetUserId: string): Promise<{ status: string }> {
  return request<{ status: string }>("POST", `/users/${targetUserId}/block`);
}

export function reportUser(targetUserId: string, reason: string): Promise<unknown> {
  return request<unknown>("POST", `/users/${targetUserId}/report`, { reason });
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type ApiNotification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  read: boolean;
};

export function getNotifications(): Promise<ApiNotification[]> {
  return request<ApiNotification[]>("GET", "/notifications");
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function fetchHealth(apiBaseUrl = BASE): Promise<HealthResponse> {
  const res = await fetch(`${apiBaseUrl}/health`);
  if (!res.ok) throw new Error(`Healthcheck failed: ${res.status}`);
  return res.json() as Promise<HealthResponse>;
}
