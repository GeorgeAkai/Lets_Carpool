from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, time
from typing import Any, Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

from backend.app.auth import create_access_token, decode_access_token, verify_supabase_token
from backend.app.domain import DomainError, DriverTrip, Store, User
from backend.app.realtime import ConnectionManager, build_bus
from backend.app.routing import GoogleRoutesClient, OSRMClient


class Settings(BaseSettings):
    database_url: str = "postgresql://carpool:carpool@localhost:5432/carpool"
    api_name: str = "carpool-api"
    jwt_secret: str = "dev-secret-change-in-production-please"
    jwt_expires_minutes: int = 60 * 24 * 7
    # Space-separated list of allowed CORS origins, e.g. "https://myapp.vercel.app"
    allowed_origins: str = "http://localhost:5173 http://127.0.0.1:5173"

    # Base URL of the self-hosted OSRM (see docker-compose.yml `osrm`). Used
    # server-side to store driver routes and compute passenger detours. Empty
    # disables routing: trips are stored without a route and search falls back
    # to endpoint-radius matching.
    osrm_base_url: str = "http://localhost:5001"

    # Google Maps Platform key (env MAP_API_KEY). Primary map provider: served
    # to the browser via /config/maps for the Maps JavaScript API (so restrict
    # it by HTTP referrer), and used server-side for the Routes API, with OSRM
    # as the fallback router. Unset: the app falls back to OSRM + OpenStreetMap.
    map_api_key: str | None = None

    # Supabase project URL (must match the frontend's VITE_SUPABASE_URL). Access
    # tokens are verified against its JWKS endpoint. Required for /auth/login.
    supabase_url: str | None = None
    supabase_jwks_path: str = "/auth/v1/.well-known/jwks.json"
    # Legacy projects that still sign with a shared HS256 secret: set this
    # (Supabase dashboard -> Settings -> API -> JWT Secret) instead of using JWKS.
    supabase_jwt_secret: str | None = None
    # Supabase issues aud="authenticated" for signed-in users. Issuer is
    # `<supabase_url>/auth/v1` and is checked when set.
    supabase_jwt_issuer: str | None = None
    supabase_jwt_audience: str | None = "authenticated"

    # Shared secret Vercel Cron sends as `Authorization: Bearer <secret>` when
    # invoking scheduled requests. Required to trigger the /cron/expire sweep
    # or the manual expire endpoints below.
    cron_secret: str | None = None

    # Redis URL (env REDIS_URL, e.g. rediss://default:pw@host:6379). When set,
    # WebSocket messages fan out across all backend instances via pub/sub; unset,
    # they're delivered only to sockets on the same instance.
    redis_url: str | None = None

    # Space-separated allowlist of emails granted access to /admin/* endpoints
    # (see AdminUser below), matched case-insensitively.
    admin_emails: str = "ageorge@akihlee.com"

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split() if e.strip()}

    @property
    def supabase_jwks_url(self) -> str | None:
        if not self.supabase_url:
            return None
        return self.supabase_url.rstrip("/") + self.supabase_jwks_path


# ─── Request/Response models ──────────────────────────────────────────────────

class LoginRequest(BaseModel):
    # The raw Supabase access token (the Supabase access token),
    # verified server-side against the Supabase JWKS endpoint — never a client-
    # supplied name/email, which would let anyone authenticate as anyone.
    token: str = Field(..., min_length=1)


class ProfileUpdate(BaseModel):
    display_name: str
    photo_url: str | None = None
    bio: str | None = None
    interests: list[str] = Field(default_factory=list)
    nationality: str | None = None
    # Optional; omitted = keep the stored number. Shared only with accepted ride partners.
    phone: str | None = Field(default=None, max_length=25)


class PhotoUpload(BaseModel):
    photo_data_url: str


class VehicleUpdate(BaseModel):
    make: str | None = None
    model: str | None = None
    color: str | None = None
    seats: int | None = Field(default=None, ge=1)
    car_type: str | None = None
    has_license: bool = False
    has_insurance: bool = False
    has_good_driving_record: bool = False
    # Omitted = keep the stored plate. Shown to passengers only once accepted.
    plate: str | None = Field(default=None, max_length=12)


class LocationCreate(BaseModel):
    label: str
    latitude: float
    longitude: float
    provider: str | None = None
    provider_place_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    # True when the point stands for a whole area (a city) rather than an address.
    is_general: bool = False


class RideRequestCreate(BaseModel):
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    passenger_count: int = Field(..., ge=1)
    tags: list[str] = Field(default_factory=list)
    luggage_size: str = "none"
    preferred_car_type: str | None = None
    notes: str | None = Field(default=None, max_length=500)
    departure_time: time | None = None


class DriverTripCreate(BaseModel):
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    seats_available: int = Field(..., ge=1)
    tags: list[str] = Field(default_factory=list)
    luggage_capacity: str = "medium"
    car_type: str | None = None
    notes: str | None = Field(default=None, max_length=500)
    departure_time: time | None = None
    price_per_seat_cents: int | None = Field(default=None, ge=0, le=100_000)
    auto_accept_verified: bool = False
    # 0 = Mon … 6 = Sun. Non-empty posts one trip per matching day this week.
    repeat_weekdays: list[int] = Field(default_factory=list)


class PricePreview(BaseModel):
    pickup_location_id: str
    destination_location_id: str
    seats_available: int = Field(..., ge=1, le=8)


class DriverTripUpdate(BaseModel):
    target_date: date | None = None
    flexibility: str | None = None
    seats_available: int | None = Field(default=None, ge=1, le=8)
    departure_time: time | None = None
    notes: str | None = Field(default=None, max_length=500)


class RatingCreate(BaseModel):
    stars: int = Field(..., ge=1, le=5)
    comment: str | None = Field(default=None, max_length=500)


class SavedRouteCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=60)
    pickup_location_id: str
    destination_location_id: str
    departure_time: time | None = None
    weekdays: list[int] = Field(default_factory=list)


class RideAlertCreate(BaseModel):
    destination_location_id: str
    target_date: date
    radius_meters: int = Field(default=5000, ge=500, le=50_000)


class RideRequestPickupUpdate(BaseModel):
    pickup_location_id: str


class DriverProposalSkip(BaseModel):
    ride_request_id: str


class ProposalSkip(BaseModel):
    driver_trip_id: str


class ConnectionCreate(BaseModel):
    ride_request_id: str
    driver_trip_id: str


class ConnectionAction(BaseModel):
    action: str


class ExpireRequest(BaseModel):
    today: date


class MessageCreate(BaseModel):
    canned_key: str | None = None
    content: str | None = None


class GasSplitConfirm(BaseModel):
    amount_cents: int = Field(..., ge=1)
    currency: str = "USD"
    assumptions: dict[str, Any] = Field(default_factory=dict)


class ReportCreate(BaseModel):
    reason: str


class PoolCreate(BaseModel):
    name: str = Field(..., min_length=1)
    community_tag: str = "event"
    trip_date: date
    departure_time: time
    pickup_location_id: str
    destination_location_id: str
    max_participants: int = Field(default=10, ge=2)
    description: str | None = None
    seats_per_vehicle: int = Field(default=4, ge=1)


class PoolJoin(BaseModel):
    role: str = "passenger"


class PoolMessageCreate(BaseModel):
    content: str = Field(..., min_length=1)


class DriverLocationUpdate(BaseModel):
    latitude: float
    longitude: float
    heading: float | None = None
    speed_kmh: float | None = None


class SuspendUserRequest(BaseModel):
    reason: str | None = None


class WarnUserRequest(BaseModel):
    message: str = Field(..., min_length=1)


# ─── App factory ──────────────────────────────────────────────────────────────

def create_app(store: Store | None = None, settings: Settings | None = None) -> FastAPI:
    s = settings or Settings()
    manager = ConnectionManager(build_bus(s.redis_url))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()

    app = FastAPI(title="Carpool API", lifespan=lifespan)
    origins = s.allowed_origins.split()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    osrm = OSRMClient(s.osrm_base_url) if s.osrm_base_url else None
    router = GoogleRoutesClient(s.map_api_key, fallback=osrm) if s.map_api_key else osrm
    app.state.store = store or Store(s.database_url, router=router)
    app.state.settings = s
    app.state.ws_manager = manager

    @app.exception_handler(DomainError)
    async def handle_domain_error(_: Any, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    # ── Core ──────────────────────────────────────────────────────────────────

    @app.get("/config/maps")
    def maps_config() -> dict[str, Any]:
        # Public on purpose: the Maps JavaScript API key is necessarily visible
        # to the browser; it is secured by its HTTP-referrer restriction.
        return {"provider": "google" if app.state.settings.map_api_key else None,
                "api_key": app.state.settings.map_api_key}

    @app.get("/")
    def root() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": app.state.settings.api_name,
            "message": "Carpool API is running. Use /health or /docs for API information.",
        }

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "service": app.state.settings.api_name, "database": "postgres"}

    # ── Auth ──────────────────────────────────────────────────────────────────

    @app.post("/auth/login")
    def login(payload: LoginRequest, request: Request) -> dict[str, Any]:
        settings = app.state.settings
        ip = client_ip(request)
        if not settings.supabase_jwks_url and not settings.supabase_jwt_secret:
            raise DomainError("Server is not configured with SUPABASE_URL", 500)
        try:
            claims = verify_supabase_token(
                payload.token,
                jwks_url=settings.supabase_jwks_url,
                hs256_secret=settings.supabase_jwt_secret,
                issuer=settings.supabase_jwt_issuer,
                audience=settings.supabase_jwt_audience,
            )
        except DomainError as exc:
            app.state.store.log_audit("LOGIN_FAILED", None, None, ip, {"reason": str(exc)})
            raise
        email = claims.get("email")
        if not isinstance(email, str) or not email:
            app.state.store.log_audit("LOGIN_FAILED", None, None, ip, {"reason": "missing email claim"})
            raise DomainError("Token did not include an email claim", 401)
        meta = claims.get("user_metadata") or {}
        name = meta.get("name") or meta.get("full_name") or claims.get("name") or email.split("@")[0]
        user, is_new = app.state.store.authenticate_email(email, str(name))
        if user.status == "suspended":
            app.state.store.log_audit("LOGIN_FAILED", user.id, user.email, ip, {"reason": "account suspended"})
            raise DomainError("Your account has been suspended", 403)
        if is_new:
            app.state.store.log_audit("USER_REGISTERED", user.id, user.email, ip)
        access_token = create_access_token(
            user_id=user.id, email=user.email,
            secret=settings.jwt_secret, expires_minutes=settings.jwt_expires_minutes,
        )
        return {"access_token": access_token, "token_type": "bearer", "user": serialize_user(app.state.store, user)}

    # ── User / Profile ────────────────────────────────────────────────────────

    @app.get("/me")
    def get_me(user: CurrentUser) -> dict[str, Any]:
        return serialize_user(app.state.store, user)

    @app.patch("/me/profile")
    def update_profile(payload: ProfileUpdate, user: CurrentUser) -> dict[str, Any]:
        extra = {"phone": payload.phone} if "phone" in payload.model_fields_set else {}
        profile = app.state.store.update_profile(
            user.id, payload.display_name, payload.photo_url, payload.bio,
            payload.interests, payload.nationality, **extra,
        )
        return serialize(profile)

    @app.post("/me/photo")
    def upload_photo(payload: PhotoUpload, user: CurrentUser) -> dict[str, Any]:
        profile = app.state.store.upload_photo(user.id, payload.photo_data_url)
        return serialize(profile)

    @app.put("/me/driver-readiness")
    def update_driver_readiness(payload: VehicleUpdate, user: CurrentUser) -> dict[str, Any]:
        data = payload.model_dump()
        if "plate" not in payload.model_fields_set:
            data.pop("plate")
        vehicle = app.state.store.update_vehicle(user.id, data)
        return serialize(vehicle)

    @app.put("/me/location")
    async def update_location(payload: DriverLocationUpdate, user: CurrentUser) -> dict[str, Any]:
        loc = app.state.store.update_driver_location(user.id, payload.model_dump())
        profile = app.state.store.get_profile(user.id)
        vehicle = app.state.store.get_vehicle(user.id)
        nearby = app.state.store.get_nearby_drivers(loc.latitude, loc.longitude, radius_meters=8000)
        nearby_user_ids = [d["user_id"] for d in nearby if d["user_id"] != user.id]
        await app.state.ws_manager.broadcast(nearby_user_ids, {
            "type": "driver_nearby",
            "user_id": user.id,
            "display_name": profile.display_name if profile else "Driver",
            "latitude": loc.latitude,
            "longitude": loc.longitude,
            "heading": loc.heading,
            "car_type": vehicle.car_type if vehicle else None,
        })
        return serialize(loc)

    # ── Nearby drivers ────────────────────────────────────────────────────────

    @app.get("/drivers/nearby")
    def get_nearby_drivers(lat: float, lng: float, radius_meters: float = 10000, user: CurrentUser = None) -> list[dict[str, Any]]:  # type: ignore[assignment]
        _ = user
        return app.state.store.get_nearby_drivers(lat, lng, radius_meters)

    # ── Route suggestion ──────────────────────────────────────────────────────

    @app.get("/routes/suggest")
    def suggest_route(pickup_lat: float, pickup_lng: float, dest_lat: float, dest_lng: float, passenger_count: int = 1, user: CurrentUser = None) -> dict[str, Any]:  # type: ignore[assignment]
        _ = user
        return app.state.store.suggest_route(pickup_lat, pickup_lng, dest_lat, dest_lng, passenger_count)

    # ── Locations ─────────────────────────────────────────────────────────────

    @app.post("/locations")
    def create_location(payload: LocationCreate, user: CurrentUser) -> dict[str, Any]:
        _ = user
        location = app.state.store.create_location(payload.model_dump())
        return serialize_location(app.state.store, location.id, exact=True)

    @app.get("/locations/{location_id}")
    def get_location(location_id: str, exact: bool = False, user: CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
        _ = user
        return app.state.store.location_view(location_id, exact=exact)

    # ── Ride requests ─────────────────────────────────────────────────────────

    @app.post("/ride-requests")
    def create_ride_request(payload: RideRequestCreate, user: CurrentUser, http_request: Request) -> dict[str, Any]:
        request = app.state.store.create_ride_request(user.id, payload.model_dump())
        app.state.store.log_audit("RIDE_PUBLISHED", user.id, user.email, client_ip(http_request), {"kind": "ride_request", "id": request.id})
        return serialize_ride_request(app.state.store, request, exact=True)

    @app.post("/ride-requests/expire")
    def expire_ride_requests(payload: ExpireRequest, _cron: RequireCronSecret) -> dict[str, Any]:
        app.state.store.expire_listings(payload.today)
        return {"status": "ok"}

    @app.post("/ride-requests/{request_id}/cancel")
    def cancel_ride_request(request_id: str, user: CurrentUser) -> dict[str, Any]:
        request = app.state.store.cancel_ride_request(user.id, request_id)
        return serialize_ride_request(app.state.store, request, exact=True)

    @app.patch("/ride-requests/{request_id}/pickup")
    async def update_ride_request_pickup(request_id: str, payload: RideRequestPickupUpdate, user: CurrentUser) -> dict[str, Any]:
        request = app.state.store.update_ride_request_pickup(user.id, request_id, payload.pickup_location_id)
        # Lets a driver who already accepted this passenger see the corrected pickup
        # point without polling — mirrors the transition_connection broadcast below.
        for c in app.state.store.get_user_connections(user.id):
            if c.ride_request_id == request.id and c.status == "accepted":
                trip = app.state.store.get_driver_trip(c.driver_trip_id)
                await app.state.ws_manager.broadcast([trip.driver_id], {
                    "type": "pickup_updated",
                    "connection_id": c.id,
                })
        return serialize_ride_request(app.state.store, request, exact=True)

    @app.get("/ride-requests/search")
    def search_ride_requests(user: CurrentUser, query: SearchQuery = Depends()) -> list[dict[str, Any]]:
        requests = app.state.store.search_ride_requests(user.id, query.to_store_query())
        return [serialize_ride_request(app.state.store, r, exact=False) for r in requests]

    @app.get("/me/ride-requests")
    def my_ride_requests(user: CurrentUser) -> list[dict[str, Any]]:
        requests = app.state.store.get_user_ride_requests(user.id)
        return [serialize_ride_request(app.state.store, r, exact=True) for r in requests]

    # ── Driver trips ──────────────────────────────────────────────────────────

    @app.post("/driver-trips")
    def create_driver_trip(payload: DriverTripCreate, user: CurrentUser, http_request: Request) -> dict[str, Any]:
        data = payload.model_dump()
        weekdays = data.pop("repeat_weekdays")
        if weekdays:
            trips = app.state.store.create_driver_trip_series(user.id, data, weekdays)
        else:
            trips = [app.state.store.create_driver_trip(user.id, data)]
        for t in trips:
            app.state.store.log_audit("RIDE_PUBLISHED", user.id, user.email, client_ip(http_request), {"kind": "driver_trip", "id": t.id})
        result = serialize_driver_trip(app.state.store, trips[0], exact=True)
        result["series_trip_ids"] = [t.id for t in trips]
        return result

    @app.post("/driver-trips/price-preview")
    def driver_trip_price_preview(payload: PricePreview, user: CurrentUser) -> dict[str, Any]:
        """'Each passenger pays' while a driver is still filling in the post form."""
        _ = user
        app.state.store._validate_location_ids(payload.pickup_location_id, payload.destination_location_id)
        draft = DriverTrip(
            id="preview", driver_id=user.id, pickup_location_id=payload.pickup_location_id,
            destination_location_id=payload.destination_location_id, target_date=date.today(),
            flexibility="flexible", seats_available=payload.seats_available, seats_reserved=0,
            tags=[], status="open", created_at=datetime.now(),
        )
        _, draft.route_distance_m, draft.route_duration_s = app.state.store._compute_trip_route(draft)
        return {**app.state.store.trip_pricing(draft), "duration_minutes": round(app.state.store.trip_duration_minutes(draft))}

    @app.post("/driver-trips/expire")
    def expire_driver_trips(payload: ExpireRequest, _cron: RequireCronSecret) -> dict[str, Any]:
        app.state.store.expire_listings(payload.today)
        return {"status": "ok"}

    @app.post("/driver-trips/{trip_id}/cancel")
    def cancel_driver_trip(trip_id: str, user: CurrentUser) -> dict[str, Any]:
        trip = app.state.store.cancel_driver_trip(user.id, trip_id)
        return serialize_driver_trip(app.state.store, trip, exact=True)

    @app.post("/driver-trips/{trip_id}/pause")
    def pause_driver_trip(trip_id: str, user: CurrentUser) -> dict[str, Any]:
        return serialize_driver_trip(app.state.store, app.state.store.pause_driver_trip(user.id, trip_id), exact=True)

    @app.post("/driver-trips/{trip_id}/resume")
    def resume_driver_trip(trip_id: str, user: CurrentUser) -> dict[str, Any]:
        return serialize_driver_trip(app.state.store, app.state.store.resume_driver_trip(user.id, trip_id), exact=True)

    @app.patch("/driver-trips/{trip_id}")
    def update_driver_trip(trip_id: str, payload: DriverTripUpdate, user: CurrentUser) -> dict[str, Any]:
        trip = app.state.store.update_driver_trip(user.id, trip_id, payload.model_dump(exclude_unset=True))
        return serialize_driver_trip(app.state.store, trip, exact=True)

    @app.get("/driver-trips/search")
    def search_driver_trips(user: CurrentUser, query: SearchQuery = Depends()) -> list[dict[str, Any]]:
        trips = app.state.store.search_driver_trips(user.id, query.to_store_query())
        return [serialize_driver_trip(app.state.store, t, exact=False) for t in trips]

    @app.get("/ride-requests/{request_id}/proposal")
    def ride_request_proposal(request_id: str, user: CurrentUser) -> dict[str, Any]:
        result = app.state.store.propose_match(user.id, request_id)
        trip = result["trip"]
        return {
            "trip": serialize_driver_trip(app.state.store, trip, exact=False) if trip else None,
            "remaining": result["remaining"],
        }

    @app.post("/ride-requests/{request_id}/proposal/skip")
    def skip_ride_request_proposal(request_id: str, payload: ProposalSkip, user: CurrentUser) -> dict[str, Any]:
        app.state.store.skip_match(user.id, request_id, payload.driver_trip_id)
        return {"status": "ok"}

    @app.get("/driver-trips/{trip_id}/proposal")
    def driver_trip_proposal(trip_id: str, user: CurrentUser) -> dict[str, Any]:
        result = app.state.store.propose_rider(user.id, trip_id)
        rr = result["request"]
        return {
            "request": serialize_ride_request(app.state.store, rr, exact=False) if rr else None,
            "remaining": result["remaining"],
        }

    @app.get("/driver-trips/{trip_id}/matches")
    def driver_trip_matches(trip_id: str, user: CurrentUser) -> list[dict[str, Any]]:
        matches = app.state.store.rider_matches(user.id, trip_id)
        return [serialize_ride_request(app.state.store, rr, exact=False) for rr in matches]

    @app.post("/driver-trips/{trip_id}/proposal/skip")
    def skip_driver_trip_proposal(trip_id: str, payload: DriverProposalSkip, user: CurrentUser) -> dict[str, Any]:
        app.state.store.skip_rider(user.id, trip_id, payload.ride_request_id)
        return {"status": "ok"}

    @app.get("/me/driver-trips")
    def my_driver_trips(user: CurrentUser) -> list[dict[str, Any]]:
        trips = app.state.store.get_user_driver_trips(user.id)
        return [serialize_driver_trip(app.state.store, t, exact=True) for t in trips]

    # ── Connections ───────────────────────────────────────────────────────────

    @app.post("/connections")
    def create_connection(payload: ConnectionCreate, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.create_connection(user.id, payload.model_dump())
        return serialize_connection(app.state.store, connection, viewer_id=user.id)

    @app.post("/connections/expire")
    def expire_connections(payload: ExpireRequest, _cron: RequireCronSecret) -> dict[str, Any]:
        app.state.store.expire_connections(payload.today)
        return {"status": "ok"}

    @app.get("/cron/expire")
    def cron_expire(_cron: RequireCronSecret) -> dict[str, Any]:
        # The single entry point Vercel Cron actually calls (Cron Jobs only send
        # GET requests, so it can't hit the POST endpoints above with a body).
        today = date.today()
        app.state.store.expire_listings(today)
        app.state.store.expire_connections(today)
        return {"status": "ok", "expired_as_of": today.isoformat()}

    @app.get("/me/connections")
    def my_connections(user: CurrentUser) -> list[dict[str, Any]]:
        connections = app.state.store.get_user_connections(user.id)
        return [serialize_connection(app.state.store, c, viewer_id=user.id) for c in connections]

    @app.post("/connections/{connection_id}/transition")
    async def transition_connection(connection_id: str, payload: ConnectionAction, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.transition_connection(user.id, connection_id, payload.action)
        rr = app.state.store.get_ride_request(connection.ride_request_id)
        trip = app.state.store.get_driver_trip(connection.driver_trip_id)
        await app.state.ws_manager.broadcast([rr.rider_id, trip.driver_id], {
            "type": "connection_update",
            "connection_id": connection_id,
            "status": connection.status,
        })
        return serialize_connection(app.state.store, connection, viewer_id=user.id)

    @app.post("/connections/{connection_id}/messages")
    async def add_message(connection_id: str, payload: MessageCreate, user: CurrentUser) -> dict[str, Any]:
        message = app.state.store.add_message(user.id, connection_id, payload.model_dump())
        connection = app.state.store.get_connection(connection_id)
        rr = app.state.store.get_ride_request(connection.ride_request_id)
        trip = app.state.store.get_driver_trip(connection.driver_trip_id)
        other_id = trip.driver_id if user.id == rr.rider_id else rr.rider_id
        await app.state.ws_manager.send(other_id, {
            "type": "chat_message",
            "connection_id": connection_id,
            "message": serialize(message),
        })
        return serialize(message)

    @app.get("/connections/{connection_id}/messages")
    def get_messages(connection_id: str, user: CurrentUser) -> list[dict[str, Any]]:
        connection = app.state.store.get_connection(connection_id)
        rr = app.state.store.get_ride_request(connection.ride_request_id)
        trip = app.state.store.get_driver_trip(connection.driver_trip_id)
        if user.id not in {rr.rider_id, trip.driver_id}:
            raise HTTPException(status_code=403, detail="Only participants can read messages")
        return [serialize(m) for m in app.state.store.get_messages(connection_id)]

    @app.get("/connections/{connection_id}/gas-split/suggestion")
    def suggest_gas_split(connection_id: str, user: CurrentUser) -> dict[str, Any]:
        _authorize_connection_participant(app.state.store, user.id, connection_id)
        return app.state.store.suggest_gas_split(connection_id)

    @app.post("/connections/{connection_id}/gas-split/confirm")
    def confirm_gas_split(connection_id: str, payload: GasSplitConfirm, user: CurrentUser) -> dict[str, Any]:
        confirmation = app.state.store.confirm_gas_split(user.id, connection_id, payload.model_dump())
        return serialize(confirmation)

    # ── Community Pools ───────────────────────────────────────────────────────

    @app.get("/pools")
    def list_pools(community_tag: str | None = None, trip_date: date | None = None, user: CurrentUser = None) -> list[dict[str, Any]]:  # type: ignore[assignment]
        _ = user
        pools = app.state.store.list_pools(community_tag=community_tag, trip_date=trip_date)
        return [serialize_pool(app.state.store, p) for p in pools]

    @app.post("/pools")
    def create_pool(payload: PoolCreate, user: CurrentUser) -> dict[str, Any]:
        pool = app.state.store.create_pool(user.id, payload.model_dump())
        return serialize_pool(app.state.store, pool)

    @app.post("/pools/{pool_id}/join")
    def join_pool(pool_id: str, payload: PoolJoin, user: CurrentUser) -> dict[str, Any]:
        membership = app.state.store.join_pool(user.id, pool_id, payload.role)
        return serialize(membership)

    @app.post("/pools/{pool_id}/leave")
    def leave_pool(pool_id: str, user: CurrentUser) -> dict[str, str]:
        app.state.store.leave_pool(user.id, pool_id)
        return {"status": "left"}

    @app.get("/pools/{pool_id}")
    def get_pool(pool_id: str, user: CurrentUser) -> dict[str, Any]:
        _ = user
        pool = app.state.store.get_pool(pool_id)
        return serialize_pool(app.state.store, pool)

    @app.post("/pools/{pool_id}/messages")
    def add_pool_message(pool_id: str, payload: PoolMessageCreate, user: CurrentUser) -> dict[str, Any]:
        message = app.state.store.add_pool_message(user.id, pool_id, payload.model_dump())
        return serialize(message)

    @app.get("/pools/{pool_id}/messages")
    def get_pool_messages(pool_id: str, user: CurrentUser) -> list[dict[str, Any]]:
        return [serialize(m) for m in app.state.store.get_pool_messages(user.id, pool_id)]

    # ── Notifications ─────────────────────────────────────────────────────────

    @app.get("/notifications")
    def notifications(user: CurrentUser) -> list[dict[str, Any]]:
        return [serialize(n) for n in app.state.store.get_notifications(user.id)]

    @app.post("/notifications/read")
    def mark_notifications_read(user: CurrentUser) -> dict[str, str]:
        app.state.store.mark_notifications_read(user.id)
        return {"status": "ok"}

    @app.delete("/notifications/{notification_id}")
    def dismiss_notification(notification_id: str, user: CurrentUser) -> dict[str, str]:
        app.state.store.dismiss_notification(user.id, notification_id)
        return {"status": "dismissed"}

    # ── Public user profiles ──────────────────────────────────────────────────

    @app.get("/users/{target_user_id}/profile")
    def get_user_profile(target_user_id: str, user: CurrentUser) -> dict[str, Any]:
        _ = user
        profile = app.state.store.get_profile(target_user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        return {
            "user_id": profile.user_id,
            "display_name": profile.display_name,
            "photo_url": profile.photo_url,
            "photo_verified": profile.photo_verified,
            "interests": profile.interests,
            "nationality": profile.nationality,
            **app.state.store.user_stats(target_user_id),
        }

    # ── User actions ──────────────────────────────────────────────────────────

    # ── Ratings, trip day, saved routes, alerts ───────────────────────────────

    @app.post("/connections/{connection_id}/rating")
    def rate_connection(connection_id: str, payload: RatingCreate, user: CurrentUser) -> dict[str, Any]:
        return serialize(app.state.store.rate_connection(user.id, connection_id, payload.stars, payload.comment))

    @app.get("/connections/{connection_id}/live")
    def connection_live_status(connection_id: str, user: CurrentUser) -> dict[str, Any]:
        return serialize(app.state.store.trip_day_status(user.id, connection_id))

    @app.post("/connections/{connection_id}/picked-up")
    async def driver_picked_up(connection_id: str, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.mark_picked_up(user.id, connection_id)
        rr = app.state.store.get_ride_request(connection.ride_request_id)
        await app.state.ws_manager.broadcast([rr.rider_id], {"type": "connection_update", "connection_id": connection_id, "status": connection.status})
        return serialize_connection(app.state.store, connection, viewer_id=user.id)

    @app.post("/connections/{connection_id}/at-pickup")
    async def rider_at_pickup(connection_id: str, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.mark_rider_at_pickup(user.id, connection_id)
        trip = app.state.store.get_driver_trip(connection.driver_trip_id)
        await app.state.ws_manager.broadcast([trip.driver_id], {"type": "rider_at_pickup", "connection_id": connection_id})
        return serialize_connection(app.state.store, connection, viewer_id=user.id)

    @app.get("/me/routes")
    def my_saved_routes(user: CurrentUser) -> list[dict[str, Any]]:
        return [serialize_saved_route(app.state.store, r) for r in app.state.store.list_saved_routes(user.id)]

    @app.post("/me/routes")
    def create_saved_route(payload: SavedRouteCreate, user: CurrentUser) -> dict[str, Any]:
        return serialize_saved_route(app.state.store, app.state.store.create_saved_route(user.id, payload.model_dump()))

    @app.delete("/me/routes/{route_id}")
    def delete_saved_route(route_id: str, user: CurrentUser) -> dict[str, str]:
        app.state.store.delete_saved_route(user.id, route_id)
        return {"status": "deleted"}

    @app.post("/ride-alerts")
    def create_ride_alert(payload: RideAlertCreate, user: CurrentUser) -> dict[str, Any]:
        return serialize(app.state.store.create_ride_alert(
            user.id, payload.destination_location_id, payload.target_date, payload.radius_meters))

    @app.post("/users/{target_user_id}/block")
    def block_user(target_user_id: str, user: CurrentUser) -> dict[str, str]:
        app.state.store.block_user(user.id, target_user_id)
        return {"status": "blocked"}

    @app.post("/users/{target_user_id}/report")
    def report_user(target_user_id: str, payload: ReportCreate, user: CurrentUser) -> dict[str, Any]:
        report = app.state.store.report_user(user.id, target_user_id, payload.reason)
        return serialize(report)

    # ── Admin ─────────────────────────────────────────────────────────────────

    @app.get("/admin/stats")
    def admin_stats(_admin: AdminUser) -> dict[str, Any]:
        return app.state.store.get_admin_stats()

    @app.get("/admin/users")
    def admin_list_users(
        _admin: AdminUser, search: str | None = None, status: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> dict[str, Any]:
        return {
            "users": [serialize(u) for u in app.state.store.list_users(search, status, limit, offset)],
            "total": app.state.store.count_users(search, status),
        }

    @app.post("/admin/users/{target_user_id}/suspend")
    def admin_suspend_user(target_user_id: str, payload: SuspendUserRequest, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        user = app.state.store.suspend_user(admin.id, target_user_id, payload.reason)
        app.state.store.log_audit("USER_BLOCKED", admin.id, admin.email, client_ip(http_request), {"target_user_id": target_user_id, "reason": payload.reason})
        return serialize(user)

    @app.post("/admin/users/{target_user_id}/verify-id")
    def admin_verify_id(target_user_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        target = app.state.store.set_id_verified(target_user_id, True)
        app.state.store.log_audit("ID_VERIFIED", admin.id, admin.email, client_ip(http_request), {"target_user_id": target_user_id})
        return {"id": target.id, "id_verified": target.id_verified}

    @app.post("/admin/users/{target_user_id}/unverify-id")
    def admin_unverify_id(target_user_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        target = app.state.store.set_id_verified(target_user_id, False)
        app.state.store.log_audit("ID_UNVERIFIED", admin.id, admin.email, client_ip(http_request), {"target_user_id": target_user_id})
        return {"id": target.id, "id_verified": target.id_verified}

    @app.post("/admin/users/{target_user_id}/unsuspend")
    def admin_unsuspend_user(target_user_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        user = app.state.store.unsuspend_user(target_user_id)
        app.state.store.log_audit("USER_UNBLOCKED", admin.id, admin.email, client_ip(http_request), {"target_user_id": target_user_id})
        return serialize(user)

    @app.post("/admin/users/{target_user_id}/warn")
    def admin_warn_user(target_user_id: str, payload: WarnUserRequest, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        notification = app.state.store.notify(target_user_id, "admin_warning", "Warning from Let's Carpool", payload.message)
        app.state.store.log_audit("WARNING_SENT", admin.id, admin.email, client_ip(http_request), {"target_user_id": target_user_id, "message": payload.message})
        return serialize(notification)

    @app.get("/admin/reports")
    def admin_list_reports(_admin: AdminUser, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        return [serialize_report(app.state.store, r) for r in app.state.store.list_reports(status, limit)]

    @app.post("/admin/reports/{report_id}/dismiss")
    def admin_dismiss_report(report_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        report = app.state.store.dismiss_report(report_id)
        app.state.store.log_audit("REPORT_DISMISSED", admin.id, admin.email, client_ip(http_request), {"report_id": report_id})
        return serialize_report(app.state.store, report)

    @app.post("/admin/reports/{report_id}/block")
    def admin_block_from_report(report_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        report = app.state.store.mark_report_actioned(report_id)
        user = app.state.store.suspend_user(admin.id, report.reported_user_id, f"Reported: {report.reason}")
        ip = client_ip(http_request)
        app.state.store.log_audit("REPORT_ACTIONED", admin.id, admin.email, ip, {"report_id": report_id})
        app.state.store.log_audit("USER_BLOCKED", admin.id, admin.email, ip, {"target_user_id": user.id, "reason": f"Reported: {report.reason}"})
        return serialize(user)

    @app.get("/admin/destinations/popular")
    def admin_popular_destinations(_admin: AdminUser, limit: int = 10) -> list[dict[str, Any]]:
        return app.state.store.popular_destinations(limit)

    @app.get("/admin/routes/active")
    def admin_active_routes(_admin: AdminUser, limit: int = 200) -> dict[str, Any]:
        return {
            "driver_trips": [serialize(t) for t in app.state.store.list_active_driver_trips(limit)],
            "ride_requests": [serialize(r) for r in app.state.store.list_active_ride_requests(limit)],
        }

    @app.post("/admin/routes/ride-requests/{request_id}/remove")
    def admin_remove_ride_request(request_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        rr = app.state.store.admin_remove_ride_request(request_id)
        app.state.store.log_audit("LISTING_REMOVED", admin.id, admin.email, client_ip(http_request), {"kind": "ride_request", "id": request_id})
        return serialize(rr)

    @app.post("/admin/routes/driver-trips/{trip_id}/remove")
    def admin_remove_driver_trip(trip_id: str, admin: AdminUser, http_request: Request) -> dict[str, Any]:
        trip = app.state.store.admin_remove_driver_trip(trip_id)
        app.state.store.log_audit("LISTING_REMOVED", admin.id, admin.email, client_ip(http_request), {"kind": "driver_trip", "id": trip_id})
        return serialize(trip)

    @app.get("/admin/audit-logs")
    def admin_audit_logs(
        _admin: AdminUser, event_type: str | None = None, actor_email: str | None = None,
        date_from: datetime | None = None, date_to: datetime | None = None, limit: int = 200,
    ) -> list[dict[str, Any]]:
        return [serialize(l) for l in app.state.store.list_audit_logs(event_type, actor_email, date_from, date_to, limit)]

    # ── WebSocket ─────────────────────────────────────────────────────────────

    @app.websocket("/ws/{user_id}")
    async def websocket_endpoint(websocket: WebSocket, user_id: str) -> None:
        manager: ConnectionManager = app.state.ws_manager
        await manager.connect(user_id, websocket)
        token = websocket.query_params.get("token")
        if token:
            try:
                decoded_id = decode_access_token(token, app.state.settings.jwt_secret)
                if decoded_id != user_id:
                    await websocket.close(code=4001)
                    manager.disconnect(user_id)
                    return
            except DomainError:
                await websocket.close(code=4001)
                manager.disconnect(user_id)
                return
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
        except WebSocketDisconnect:
            manager.disconnect(user_id)
        except Exception:
            manager.disconnect(user_id)

    return app


# ─── Query helpers ────────────────────────────────────────────────────────────

class SearchQuery(BaseModel):
    destination_latitude: float | None = None
    destination_longitude: float | None = None
    destination_radius_meters: float = 1000
    pickup_latitude: float | None = None
    pickup_longitude: float | None = None
    pickup_radius_meters: float = 5000
    route_buffer_meters: float = 1000
    target_date: date | None = None
    tag: str | None = None
    car_type: str | None = None
    luggage_size: str | None = None

    def to_store_query(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def current_user(request: Request, authorization: Annotated[str | None, Header()] = None) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = authorization.split(" ", 1)[1]
    settings = request.app.state.settings
    try:
        user_id = decode_access_token(token, settings.jwt_secret)
        user = request.app.state.store.user_for_id(user_id)
    except DomainError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    # Suspended accounts are locked out of every authenticated route, not just
    # blocked from publishing — a still-valid JWT shouldn't outlive a ban.
    if user.status == "suspended":
        raise HTTPException(status_code=403, detail="Your account has been suspended")
    return user


def optional_user(request: Request, authorization: Annotated[str | None, Header()] = None) -> User | None:
    if not authorization:
        return None
    return current_user(request, authorization)


CurrentUser = Annotated[User, Depends(current_user)]


def admin_user(user: CurrentUser, request: Request) -> User:
    if user.email.strip().lower() not in request.app.state.settings.admin_email_set:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


AdminUser = Annotated[User, Depends(admin_user)]


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def require_cron_secret(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
    # Expiry sweeps act globally across all users' data, so they must never be
    # reachable by an arbitrary signed-in user — only the scheduled Vercel Cron
    # job (or another caller holding the same shared secret) may trigger them.
    settings = request.app.state.settings
    if not settings.cron_secret:
        raise HTTPException(status_code=503, detail="Server is not configured with CRON_SECRET")
    if authorization != f"Bearer {settings.cron_secret}":
        raise HTTPException(status_code=401, detail="Invalid or missing cron secret")


RequireCronSecret = Annotated[None, Depends(require_cron_secret)]


# ─── Serializers ──────────────────────────────────────────────────────────────

def serialize_user(store: Store, user: User) -> dict[str, Any]:
    profile = store.get_profile(user.id)
    vehicle = store.get_vehicle(user.id)
    return {**serialize(user), "profile": serialize(profile), "vehicle": serialize(vehicle)}


def serialize_location(store: Store, location_id: str, exact: bool) -> dict[str, Any]:
    return store.location_view(location_id, exact=exact)


def serialize_report(store: Store, report: Any) -> dict[str, Any]:
    data = serialize(report)
    reporter = store.get_profile(report.reporter_id)
    reported = store.get_profile(report.reported_user_id)
    reporter_user = store.user_for_id(report.reporter_id)
    reported_user = store.user_for_id(report.reported_user_id)
    data["reporter_name"] = reporter.display_name if reporter else None
    data["reporter_email"] = reporter_user.email
    data["reported_name"] = reported.display_name if reported else None
    data["reported_email"] = reported_user.email
    data["reported_status"] = reported_user.status
    return data


def _public_profile(store: Store, user_id: str) -> dict[str, Any] | None:
    """A profile as other users may see it: never the phone number."""
    profile = store.get_profile(user_id)
    if profile is None:
        return None
    data = serialize(profile)
    data.pop("phone", None)
    return {**data, **store.user_stats(user_id)}


def serialize_ride_request(store: Store, request: Any, exact: bool) -> dict[str, Any]:
    data = serialize(request)
    data["pickup"] = serialize_location(store, request.pickup_location_id, exact)
    data["destination"] = serialize_location(store, request.destination_location_id, exact)
    rider_profile = store.get_profile(request.rider_id)
    data["rider_name"] = rider_profile.display_name if rider_profile else None
    data["rider_photo_url"] = rider_profile.photo_url if rider_profile else None
    data["rider_stats"] = store.user_stats(request.rider_id)
    return data


def serialize_driver_trip(store: Store, trip: Any, exact: bool) -> dict[str, Any]:
    data = serialize(trip)
    data.pop("route_distance_m", None)
    data.pop("route_duration_s", None)
    data["pickup"] = serialize_location(store, trip.pickup_location_id, exact)
    data["destination"] = serialize_location(store, trip.destination_location_id, exact)
    driver_profile = store.get_profile(trip.driver_id)
    data["driver_name"] = driver_profile.display_name if driver_profile else None
    data["driver_photo_url"] = driver_profile.photo_url if driver_profile else None
    data["driver_stats"] = store.user_stats(trip.driver_id)
    vehicle = store.get_vehicle(trip.driver_id)
    # Make/model/color help passengers spot the car; the plate waits for acceptance.
    data["vehicle"] = ({"make": vehicle.make, "model": vehicle.model, "color": vehicle.color,
                        "car_type": vehicle.car_type} if vehicle else None)
    data["pricing"] = store.trip_pricing(trip)
    data["duration_minutes"] = round(store.trip_duration_minutes(trip))
    data["estimated_arrival_time"] = serialize(store.trip_arrival_time(trip))
    return data


def serialize_connection(store: Store, connection: Any, viewer_id: str | None = None) -> dict[str, Any]:
    data = serialize(connection)
    exact = connection.status == "accepted"
    rr = store.get_ride_request(connection.ride_request_id)
    trip = store.get_driver_trip(connection.driver_trip_id)
    data["ride_request"] = serialize_ride_request(store, rr, exact=exact)
    data["driver_trip"] = serialize_driver_trip(store, trip, exact=exact)
    data["rider_profile"] = _public_profile(store, rr.rider_id)
    data["driver_profile"] = _public_profile(store, trip.driver_id)
    # Contact details unlock once the ride is accepted: the other party's
    # phone and, for the passenger, the plate to look for at pickup.
    if exact:
        passenger = store.get_profile(rr.rider_id)
        driver = store.get_profile(trip.driver_id)
        vehicle = store.get_vehicle(trip.driver_id)
        if data["rider_profile"] is not None:
            data["rider_profile"]["phone"] = passenger.phone if passenger else None
        if data["driver_profile"] is not None:
            data["driver_profile"]["phone"] = driver.phone if driver else None
        data["driver_trip"]["vehicle"] = {**(data["driver_trip"]["vehicle"] or {}),
                                          "plate": vehicle.plate if vehicle else None}
    data["my_rating"] = store.my_rating_for(viewer_id, connection.id) if viewer_id else None
    data["fare"] = store.connection_fare(connection)
    return data


def serialize_saved_route(store: Store, route: dict[str, Any]) -> dict[str, Any]:
    data = serialize({k: v for k, v in route.items() if k != "user_id"})
    data["pickup"] = serialize_location(store, route["pickup_location_id"], True)
    data["destination"] = serialize_location(store, route["destination_location_id"], True)
    return data


def serialize_pool(store: Store, pool: Any) -> dict[str, Any]:
    data = serialize(pool)
    data["pickup"] = serialize_location(store, pool.pickup_location_id, exact=True)
    data["destination"] = serialize_location(store, pool.destination_location_id, exact=True)
    members = store.get_pool_members(pool.id)
    data["member_count"] = len(members)
    data["members"] = [_serialize_pool_member(store, m) for m in members]
    return data


def _serialize_pool_member(store: Store, membership: Any) -> dict[str, Any]:
    data = serialize(membership)
    profile = store.get_profile(membership.user_id)
    data["display_name"] = profile.display_name if profile else None
    data["photo_url"] = profile.photo_url if profile else None
    return data


def serialize(value: Any) -> Any:
    if value is None:
        return None
    if is_dataclass(value):
        return serialize(asdict(value))
    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serialize(item) for item in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    return value


def _authorize_connection_participant(store: Store, user_id: str, connection_id: str) -> None:
    connection = store.get_connection(connection_id)
    rr = store.get_ride_request(connection.ride_request_id)
    trip = store.get_driver_trip(connection.driver_trip_id)
    if user_id not in {rr.rider_id, trip.driver_id}:
        raise HTTPException(status_code=403, detail="Only participants can access this connection")
