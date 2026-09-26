from __future__ import annotations

import asyncio
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, time
from typing import Any, Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

from backend.app.auth import create_access_token, decode_access_token, verify_neon_auth_token
from backend.app.domain import DomainError, Store, User


class Settings(BaseSettings):
    database_url: str = "postgresql://carpool:carpool@localhost:5432/carpool"
    api_name: str = "carpool-api"
    jwt_secret: str = "dev-secret-change-in-production-please"
    jwt_expires_minutes: int = 60 * 24 * 7
    # Space-separated list of allowed CORS origins, e.g. "https://myapp.vercel.app"
    allowed_origins: str = "http://localhost:5173 http://127.0.0.1:5173"

    # Neon Auth server used to cryptographically verify sign-in tokens (must
    # match the frontend's VITE_NEON_AUTH_URL). Required for /auth/login to work.
    # Path confirmed against a live Neon Auth server (better-auth's plugin-
    # specific /jwks route 404s there; the standard OAuth/OIDC well-known
    # discovery path is what's actually served).
    neon_auth_url: str | None = None
    neon_auth_jwks_path: str = "/.well-known/jwks.json"
    # Issuer/audience aren't set by default — unlike the JWKS path, I couldn't
    # verify these against a real signed token, and guessing wrong here means
    # every sign-in fails closed with no way to tell why (same failure mode as
    # the wrong default JWKS path did). Signature + expiry are still verified
    # unconditionally either way. Set these once you've confirmed the actual
    # `iss`/`aud` claims your Neon Auth project issues (decode a real token).
    neon_auth_issuer: str | None = None
    neon_auth_audience: str | None = None

    # Shared secret Vercel Cron sends as `Authorization: Bearer <secret>` when
    # invoking scheduled requests. Required to trigger the /cron/expire sweep
    # or the manual expire endpoints below.
    cron_secret: str | None = None

    @property
    def neon_auth_jwks_url(self) -> str | None:
        if not self.neon_auth_url:
            return None
        return self.neon_auth_url.rstrip("/") + self.neon_auth_jwks_path


# ─── Request/Response models ──────────────────────────────────────────────────

class LoginRequest(BaseModel):
    # The raw Neon Auth session JWT (from the frontend's `authClient.getJWTToken()`),
    # verified server-side against the Neon Auth JWKS endpoint — never a client-
    # supplied name/email, which would let anyone authenticate as anyone.
    neon_token: str = Field(..., min_length=1)


class ProfileUpdate(BaseModel):
    display_name: str
    photo_url: str | None = None
    bio: str | None = None
    interests: list[str] = Field(default_factory=list)
    nationality: str | None = None


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


class LocationCreate(BaseModel):
    label: str
    latitude: float
    longitude: float
    provider: str | None = None
    provider_place_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RideRequestCreate(BaseModel):
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    passenger_count: int = Field(..., ge=1)
    tags: list[str] = Field(default_factory=list)
    luggage_size: str = "none"
    preferred_car_type: str | None = None


class DriverTripCreate(BaseModel):
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    seats_available: int = Field(..., ge=1)
    tags: list[str] = Field(default_factory=list)
    luggage_capacity: str = "medium"
    car_type: str | None = None


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


# ─── WebSocket connection manager ─────────────────────────────────────────────

class ConnectionManager:
    def __init__(self) -> None:
        self._sockets: dict[str, WebSocket] = {}

    async def connect(self, user_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._sockets[user_id] = ws

    def disconnect(self, user_id: str) -> None:
        self._sockets.pop(user_id, None)

    async def send(self, user_id: str, data: dict[str, Any]) -> None:
        ws = self._sockets.get(user_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception:
                self.disconnect(user_id)

    async def broadcast(self, user_ids: list[str], data: dict[str, Any]) -> None:
        await asyncio.gather(*[self.send(uid, data) for uid in user_ids], return_exceptions=True)


# ─── App factory ──────────────────────────────────────────────────────────────

def create_app(store: Store | None = None, settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="Carpool API")
    s = settings or Settings()
    origins = s.allowed_origins.split()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.store = store or Store(s.database_url)
    app.state.settings = s
    app.state.ws_manager = ConnectionManager()

    @app.exception_handler(DomainError)
    async def handle_domain_error(_: Any, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    # ── Core ──────────────────────────────────────────────────────────────────

    @app.get("/")
    def root() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": app.state.settings.api_name,
            "message": "Carpool API is running. Use /health or /docs for API information.",
        }

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "service": app.state.settings.api_name, "database": "neon"}

    # ── Auth ──────────────────────────────────────────────────────────────────

    @app.post("/auth/login")
    def login(payload: LoginRequest) -> dict[str, Any]:
        settings = app.state.settings
        if not settings.neon_auth_jwks_url:
            raise DomainError("Server is not configured with NEON_AUTH_URL", 500)
        claims = verify_neon_auth_token(
            payload.neon_token,
            jwks_url=settings.neon_auth_jwks_url,
            issuer=settings.neon_auth_issuer,
            audience=settings.neon_auth_audience,
        )
        email = claims.get("email")
        if not isinstance(email, str) or not email:
            raise DomainError("Neon Auth token did not include an email claim", 401)
        name = claims.get("name") or email.split("@")[0]
        user = app.state.store.authenticate_email(email, str(name))
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
        profile = app.state.store.update_profile(
            user.id, payload.display_name, payload.photo_url, payload.bio,
            payload.interests, payload.nationality,
        )
        return serialize(profile)

    @app.post("/me/photo")
    def upload_photo(payload: PhotoUpload, user: CurrentUser) -> dict[str, Any]:
        profile = app.state.store.upload_photo(user.id, payload.photo_data_url)
        return serialize(profile)

    @app.put("/me/driver-readiness")
    def update_driver_readiness(payload: VehicleUpdate, user: CurrentUser) -> dict[str, Any]:
        vehicle = app.state.store.update_vehicle(user.id, payload.model_dump())
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
    def create_ride_request(payload: RideRequestCreate, user: CurrentUser) -> dict[str, Any]:
        request = app.state.store.create_ride_request(user.id, payload.model_dump())
        return serialize_ride_request(app.state.store, request, exact=True)

    @app.post("/ride-requests/expire")
    def expire_ride_requests(payload: ExpireRequest, _cron: RequireCronSecret) -> dict[str, Any]:
        app.state.store.expire_listings(payload.today)
        return {"status": "ok"}

    @app.post("/ride-requests/{request_id}/cancel")
    def cancel_ride_request(request_id: str, user: CurrentUser) -> dict[str, Any]:
        request = app.state.store.cancel_ride_request(user.id, request_id)
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
    def create_driver_trip(payload: DriverTripCreate, user: CurrentUser) -> dict[str, Any]:
        trip = app.state.store.create_driver_trip(user.id, payload.model_dump())
        return serialize_driver_trip(app.state.store, trip, exact=True)

    @app.post("/driver-trips/expire")
    def expire_driver_trips(payload: ExpireRequest, _cron: RequireCronSecret) -> dict[str, Any]:
        app.state.store.expire_listings(payload.today)
        return {"status": "ok"}

    @app.post("/driver-trips/{trip_id}/cancel")
    def cancel_driver_trip(trip_id: str, user: CurrentUser) -> dict[str, Any]:
        trip = app.state.store.cancel_driver_trip(user.id, trip_id)
        return serialize_driver_trip(app.state.store, trip, exact=True)

    @app.get("/driver-trips/search")
    def search_driver_trips(user: CurrentUser, query: SearchQuery = Depends()) -> list[dict[str, Any]]:
        trips = app.state.store.search_driver_trips(user.id, query.to_store_query())
        return [serialize_driver_trip(app.state.store, t, exact=False) for t in trips]

    @app.get("/me/driver-trips")
    def my_driver_trips(user: CurrentUser) -> list[dict[str, Any]]:
        trips = app.state.store.get_user_driver_trips(user.id)
        return [serialize_driver_trip(app.state.store, t, exact=True) for t in trips]

    # ── Connections ───────────────────────────────────────────────────────────

    @app.post("/connections")
    def create_connection(payload: ConnectionCreate, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.create_connection(user.id, payload.model_dump())
        return serialize_connection(app.state.store, connection)

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
        return [serialize_connection(app.state.store, c) for c in connections]

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
        return serialize_connection(app.state.store, connection)

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
        }

    # ── User actions ──────────────────────────────────────────────────────────

    @app.post("/users/{target_user_id}/block")
    def block_user(target_user_id: str, user: CurrentUser) -> dict[str, str]:
        app.state.store.block_user(user.id, target_user_id)
        return {"status": "blocked"}

    @app.post("/users/{target_user_id}/report")
    def report_user(target_user_id: str, payload: ReportCreate, user: CurrentUser) -> dict[str, Any]:
        report = app.state.store.report_user(user.id, target_user_id, payload.reason)
        return serialize(report)

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
        return request.app.state.store.user_for_id(user_id)
    except DomainError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def optional_user(request: Request, authorization: Annotated[str | None, Header()] = None) -> User | None:
    if not authorization:
        return None
    return current_user(request, authorization)


CurrentUser = Annotated[User, Depends(current_user)]


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


def serialize_ride_request(store: Store, request: Any, exact: bool) -> dict[str, Any]:
    data = serialize(request)
    data["pickup"] = serialize_location(store, request.pickup_location_id, exact)
    data["destination"] = serialize_location(store, request.destination_location_id, exact)
    rider_profile = store.get_profile(request.rider_id)
    data["rider_name"] = rider_profile.display_name if rider_profile else None
    data["rider_photo_url"] = rider_profile.photo_url if rider_profile else None
    return data


def serialize_driver_trip(store: Store, trip: Any, exact: bool) -> dict[str, Any]:
    data = serialize(trip)
    data["pickup"] = serialize_location(store, trip.pickup_location_id, exact)
    data["destination"] = serialize_location(store, trip.destination_location_id, exact)
    driver_profile = store.get_profile(trip.driver_id)
    data["driver_name"] = driver_profile.display_name if driver_profile else None
    data["driver_photo_url"] = driver_profile.photo_url if driver_profile else None
    return data


def serialize_connection(store: Store, connection: Any) -> dict[str, Any]:
    data = serialize(connection)
    exact = connection.status == "accepted"
    rr = store.get_ride_request(connection.ride_request_id)
    trip = store.get_driver_trip(connection.driver_trip_id)
    data["ride_request"] = serialize_ride_request(store, rr, exact=exact)
    data["driver_trip"] = serialize_driver_trip(store, trip, exact=exact)
    rider_profile = store.get_profile(rr.rider_id)
    driver_profile = store.get_profile(trip.driver_id)
    data["rider_profile"] = serialize(rider_profile)
    data["driver_profile"] = serialize(driver_profile)
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
    return value


def _authorize_connection_participant(store: Store, user_id: str, connection_id: str) -> None:
    connection = store.get_connection(connection_id)
    rr = store.get_ride_request(connection.ride_request_id)
    trip = store.get_driver_trip(connection.driver_trip_id)
    if user_id not in {rr.rider_id, trip.driver_id}:
        raise HTTPException(status_code=403, detail="Only participants can access this connection")
