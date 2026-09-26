const DEFAULT_BASE = "http://localhost:8000";
export const BASE = (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
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
  driver_name: string | null;
  driver_photo_url: string | null;
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
  rider_name: string | null;
  rider_photo_url: string | null;
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
  rider_profile?: ApiProfile | null;
  driver_profile?: ApiProfile | null;
};

export type ApiProfile = {
  user_id: string;
  display_name: string;
  photo_url: string | null;
  bio: string | null;
  photo_verified: boolean;
  interests: string[];
  nationality: string | null;
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
  status: "active" | "suspended";
  profile: ApiProfile;
  vehicle: ApiVehicle;
};

// The one account allowed onto /admin — enforced server-side on every
// /admin/* call regardless of what the UI shows or hides.
const ADMIN_EMAIL = "ageorge@akihlee.com";

export function isAdminUser(user: ApiUser | null): boolean {
  return !!user && user.email.trim().toLowerCase() === ADMIN_EMAIL;
}

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
  departure_time: string;
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
  display_name: string | null;
  photo_url: string | null;
};

export type ApiPoolMessage = {
  id: string;
  pool_id: string;
  sender_id: string;
  content: string;
  created_at: string;
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

export function createWebSocket(userId: string, onMessage: (msg: WsMessage) => void): WebSocket | null {
  if (!BASE.includes("localhost") && !BASE.includes("127.0.0.1")) {
    return null;
  }

  const t = token();
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${WS_BASE}/ws/${userId}${t ? `?token=${t}` : ""}`);
  } catch {
    return null;
  }
  ws.onerror = () => { /* WS unavailable — real-time features disabled */ };
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

export async function login(neonToken: string): Promise<ApiUser> {
  const res = await request<{ access_token: string; user: ApiUser }>("POST", "/auth/login", { neon_token: neonToken });
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

export function updateProfile(
  displayName: string,
  photoUrl?: string | null,
  bio?: string | null,
  interests?: string[],
  nationality?: string | null,
): Promise<ApiProfile> {
  return request<ApiProfile>("PATCH", "/me/profile", {
    display_name: displayName, photo_url: photoUrl, bio,
    interests: interests ?? [], nationality: nationality ?? null,
  });
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

export function getMyDriverTrips(): Promise<ApiDriverTrip[]> {
  return request<ApiDriverTrip[]>("GET", "/me/driver-trips");
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

export function getMyRideRequests(): Promise<ApiRideRequest[]> {
  return request<ApiRideRequest[]>("GET", "/me/ride-requests");
}

// ─── Connections ──────────────────────────────────────────────────────────────

export function createConnection(rideRequestId: string, driverTripId: string): Promise<ApiConnection> {
  return request<ApiConnection>("POST", "/connections", {
    ride_request_id: rideRequestId,
    driver_trip_id: driverTripId,
  });
}

export function getMyConnections(): Promise<ApiConnection[]> {
  return request<ApiConnection[]>("GET", "/me/connections");
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
  departure_time: string;
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

export function getPoolMessages(poolId: string): Promise<ApiPoolMessage[]> {
  return request<ApiPoolMessage[]>("GET", `/pools/${poolId}/messages`);
}

export function sendPoolMessage(poolId: string, content: string): Promise<ApiPoolMessage> {
  return request<ApiPoolMessage>("POST", `/pools/${poolId}/messages`, { content });
}

// ─── Users ────────────────────────────────────────────────────────────────────

export type ApiPublicProfile = {
  user_id: string;
  display_name: string;
  photo_url: string | null;
  photo_verified: boolean;
  interests: string[];
  nationality: string | null;
};

export function getUserProfile(targetUserId: string): Promise<ApiPublicProfile> {
  return request<ApiPublicProfile>("GET", `/users/${targetUserId}/profile`);
}

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
  related_id: string | null;
};

export function getNotifications(): Promise<ApiNotification[]> {
  return request<ApiNotification[]>("GET", "/notifications");
}

export function markNotificationsRead(): Promise<{ status: string }> {
  return request<{ status: string }>("POST", "/notifications/read");
}

export function dismissNotification(notificationId: string): Promise<{ status: string }> {
  return request<{ status: string }>("DELETE", `/notifications/${notificationId}`);
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export type ApiAdminStats = {
  total_users: number;
  new_users_7d: number;
  suspended_users: number;
  total_drivers: number;
  total_riders: number;
  active_drivers: number;
  active_riders: number;
  completed_rides: number;
  open_reports: number;
};

export type ApiAdminUser = {
  id: string;
  email: string;
  email_domain: string;
  created_at: string;
  status: "active" | "suspended";
  suspended_at: string | null;
  suspended_reason: string | null;
  display_name: string | null;
  photo_url: string | null;
  is_driver: boolean;
  is_rider: boolean;
  open_report_count: number;
};

export type ApiAdminReport = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  created_at: string;
  status: "open" | "dismissed" | "actioned";
  reporter_name: string | null;
  reporter_email: string;
  reported_name: string | null;
  reported_email: string;
  reported_status: "active" | "suspended";
};

export type ApiPopularDestination = {
  label: string;
  trip_count: number;
};

export type ApiActiveDriverTrip = {
  id: string;
  driver_id: string;
  target_date: string;
  seats_available: number;
  seats_reserved: number;
  status: string;
  created_at: string;
  driver_name: string | null;
  pickup_label: string | null;
  destination_label: string | null;
};

export type ApiActiveRideRequest = {
  id: string;
  rider_id: string;
  target_date: string;
  passenger_count: number;
  status: string;
  created_at: string;
  rider_name: string | null;
  pickup_label: string | null;
  destination_label: string | null;
};

export type ApiAuditLogEntry = {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  ip_address: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export function getAdminStats(): Promise<ApiAdminStats> {
  return request<ApiAdminStats>("GET", "/admin/stats");
}

export function getAdminUsers(opts: { search?: string; status?: string; limit?: number; offset?: number } = {}): Promise<{ users: ApiAdminUser[]; total: number }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return request("GET", `/admin/users${qs ? `?${qs}` : ""}`);
}

export function suspendUser(userId: string, reason?: string): Promise<ApiAdminUser> {
  return request<ApiAdminUser>("POST", `/admin/users/${userId}/suspend`, { reason: reason ?? null });
}

export function unsuspendUser(userId: string): Promise<ApiAdminUser> {
  return request<ApiAdminUser>("POST", `/admin/users/${userId}/unsuspend`);
}

export function warnUser(userId: string, message: string): Promise<unknown> {
  return request("POST", `/admin/users/${userId}/warn`, { message });
}

export function getAdminReports(status?: string): Promise<ApiAdminReport[]> {
  const qs = status ? `?status=${status}` : "";
  return request<ApiAdminReport[]>("GET", `/admin/reports${qs}`);
}

export function dismissReport(reportId: string): Promise<ApiAdminReport> {
  return request<ApiAdminReport>("POST", `/admin/reports/${reportId}/dismiss`);
}

export function blockFromReport(reportId: string): Promise<ApiAdminUser> {
  return request<ApiAdminUser>("POST", `/admin/reports/${reportId}/block`);
}

export function getPopularDestinations(limit = 10): Promise<ApiPopularDestination[]> {
  return request<ApiPopularDestination[]>("GET", `/admin/destinations/popular?limit=${limit}`);
}

export function getActiveRoutes(): Promise<{ driver_trips: ApiActiveDriverTrip[]; ride_requests: ApiActiveRideRequest[] }> {
  return request("GET", "/admin/routes/active");
}

export function adminRemoveRideRequest(requestId: string): Promise<unknown> {
  return request("POST", `/admin/routes/ride-requests/${requestId}/remove`);
}

export function adminRemoveDriverTrip(tripId: string): Promise<unknown> {
  return request("POST", `/admin/routes/driver-trips/${tripId}/remove`);
}

export function getAuditLogs(opts: { event_type?: string; actor_email?: string; date_from?: string; date_to?: string; limit?: number } = {}): Promise<ApiAuditLogEntry[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return request<ApiAuditLogEntry[]>("GET", `/admin/audit-logs${qs ? `?${qs}` : ""}`);
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function fetchHealth(apiBaseUrl = BASE): Promise<HealthResponse> {
  const res = await fetch(`${apiBaseUrl}/health`);
  if (!res.ok) throw new Error(`Healthcheck failed: ${res.status}`);
  return res.json() as Promise<HealthResponse>;
}
