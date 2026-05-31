from __future__ import annotations

from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from typing import Any, Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

from backend.app.auth import create_access_token, decode_access_token
from backend.app.domain import DomainError, Store, User


class Settings(BaseSettings):
    database_url: str = "postgresql://carpool:carpool@localhost:5432/carpool"
    api_name: str = "carpool-api"
    jwt_secret: str = "dev-secret-change-in-production-please"
    jwt_expires_minutes: int = 60 * 24 * 7


class LoginRequest(BaseModel):
    name: str = Field(..., min_length=1, examples=["Ada Lovelace"])
    email: str = Field(..., examples=["ada@berkeley.edu"])


class ProfileUpdate(BaseModel):
    display_name: str
    photo_url: str | None = None
    bio: str | None = None


class VehicleUpdate(BaseModel):
    make: str | None = None
    model: str | None = None
    color: str | None = None
    seats: int | None = Field(default=None, ge=1)
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


class DriverTripCreate(BaseModel):
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    seats_available: int = Field(..., ge=1)
    tags: list[str] = Field(default_factory=list)


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


def create_app(store: Store | None = None, settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="Carpool API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.store = store or Store()
    app.state.settings = settings or Settings()

    @app.exception_handler(DomainError)
    async def handle_domain_error(_: Any, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    @app.get("/")
    def root() -> dict[str, Any]:
        settings = app.state.settings
        return {
            "status": "ok",
            "service": settings.api_name,
            "message": "Carpool API is running. Use /health or /docs for API information.",
        }

    @app.get("/health")
    def health() -> dict[str, Any]:
        settings = app.state.settings
        return {
            "status": "ok",
            "service": settings.api_name,
            "database": {
                "configured": bool(settings.database_url),
                "engine": "postgresql",
                "postgis_extension": "required",
            },
        }

    @app.post("/auth/login")
    def login(payload: LoginRequest) -> dict[str, Any]:
        settings = app.state.settings
        user = app.state.store.authenticate_email(str(payload.email), payload.name)
        access_token = create_access_token(
            user_id=user.id,
            email=user.email,
            secret=settings.jwt_secret,
            expires_minutes=settings.jwt_expires_minutes,
        )
        return {"access_token": access_token, "token_type": "bearer", "user": serialize_user(app.state.store, user)}

    @app.get("/me")
    def get_me(user: CurrentUser) -> dict[str, Any]:
        return serialize_user(app.state.store, user)

    @app.patch("/me/profile")
    def update_profile(payload: ProfileUpdate, user: CurrentUser) -> dict[str, Any]:
        profile = app.state.store.update_profile(user.id, payload.display_name, payload.photo_url, payload.bio)
        return serialize(profile)

    @app.put("/me/driver-readiness")
    def update_driver_readiness(payload: VehicleUpdate, user: CurrentUser) -> dict[str, Any]:
        vehicle = app.state.store.update_vehicle(user.id, payload.model_dump())
        return serialize(vehicle)

    @app.post("/locations")
    def create_location(payload: LocationCreate, user: CurrentUser) -> dict[str, Any]:
        _ = user
        location = app.state.store.create_location(payload.model_dump())
        return serialize_location(app.state.store, location.id, exact=True)

    @app.get("/locations/{location_id}")
    def get_location(location_id: str, exact: bool = False, user: CurrentUser | None = Depends(optional_user)) -> dict[str, Any]:
        _ = user
        return app.state.store.location_view(location_id, exact=exact)

    @app.post("/ride-requests")
    def create_ride_request(payload: RideRequestCreate, user: CurrentUser) -> dict[str, Any]:
        request = app.state.store.create_ride_request(user.id, payload.model_dump())
        return serialize_ride_request(app.state.store, request, exact=True)

    @app.post("/ride-requests/expire")
    def expire_ride_requests(payload: ExpireRequest, user: CurrentUser) -> dict[str, Any]:
        _ = user
        app.state.store.expire_listings(payload.today)
        return {"status": "ok"}

    @app.post("/ride-requests/{request_id}/cancel")
    def cancel_ride_request(request_id: str, user: CurrentUser) -> dict[str, Any]:
        request = app.state.store.cancel_ride_request(user.id, request_id)
        return serialize_ride_request(app.state.store, request, exact=True)

    @app.post("/driver-trips")
    def create_driver_trip(payload: DriverTripCreate, user: CurrentUser) -> dict[str, Any]:
        trip = app.state.store.create_driver_trip(user.id, payload.model_dump())
        return serialize_driver_trip(app.state.store, trip, exact=True)

    @app.post("/driver-trips/expire")
    def expire_driver_trips(payload: ExpireRequest, user: CurrentUser) -> dict[str, Any]:
        _ = user
        app.state.store.expire_listings(payload.today)
        return {"status": "ok"}

    @app.post("/driver-trips/{trip_id}/cancel")
    def cancel_driver_trip(trip_id: str, user: CurrentUser) -> dict[str, Any]:
        trip = app.state.store.cancel_driver_trip(user.id, trip_id)
        return serialize_driver_trip(app.state.store, trip, exact=True)

    @app.get("/driver-trips/search")
    def search_driver_trips(user: CurrentUser, query: SearchQuery = Depends()) -> list[dict[str, Any]]:
        trips = app.state.store.search_driver_trips(user.id, query.to_store_query())
        return [serialize_driver_trip(app.state.store, trip, exact=False) for trip in trips]

    @app.get("/ride-requests/search")
    def search_ride_requests(user: CurrentUser, query: SearchQuery = Depends()) -> list[dict[str, Any]]:
        requests = app.state.store.search_ride_requests(user.id, query.to_store_query())
        return [serialize_ride_request(app.state.store, request, exact=False) for request in requests]

    @app.post("/connections")
    def create_connection(payload: ConnectionCreate, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.create_connection(user.id, payload.model_dump())
        return serialize_connection(app.state.store, connection)

    @app.post("/connections/expire")
    def expire_connections(payload: ExpireRequest, user: CurrentUser) -> dict[str, Any]:
        _ = user
        app.state.store.expire_connections(payload.today)
        return {"status": "ok"}

    @app.post("/connections/{connection_id}/transition")
    def transition_connection(connection_id: str, payload: ConnectionAction, user: CurrentUser) -> dict[str, Any]:
        connection = app.state.store.transition_connection(user.id, connection_id, payload.action)
        return serialize_connection(app.state.store, connection)

    @app.post("/connections/{connection_id}/messages")
    def add_message(connection_id: str, payload: MessageCreate, user: CurrentUser) -> dict[str, Any]:
        message = app.state.store.add_message(user.id, connection_id, payload.model_dump())
        return serialize(message)

    @app.get("/connections/{connection_id}/messages")
    def get_messages(connection_id: str, user: CurrentUser) -> list[dict[str, Any]]:
        connection = app.state.store.connections[connection_id]
        request = app.state.store.ride_requests[connection.ride_request_id]
        trip = app.state.store.driver_trips[connection.driver_trip_id]
        if user.id not in {request.rider_id, trip.driver_id}:
            raise HTTPException(status_code=403, detail="Only participants can read messages")
        return [serialize(message) for message in app.state.store.messages.get(connection_id, [])]

    @app.get("/connections/{connection_id}/gas-split/suggestion")
    def suggest_gas_split(connection_id: str, user: CurrentUser) -> dict[str, Any]:
        _authorize_connection_participant(app.state.store, user.id, connection_id)
        return app.state.store.suggest_gas_split(connection_id)

    @app.post("/connections/{connection_id}/gas-split/confirm")
    def confirm_gas_split(connection_id: str, payload: GasSplitConfirm, user: CurrentUser) -> dict[str, Any]:
        confirmation = app.state.store.confirm_gas_split(user.id, connection_id, payload.model_dump())
        return serialize(confirmation)

    @app.get("/notifications")
    def notifications(user: CurrentUser) -> list[dict[str, Any]]:
        return [serialize(notification) for notification in app.state.store.notifications.get(user.id, [])]

    @app.post("/users/{target_user_id}/block")
    def block_user(target_user_id: str, user: CurrentUser) -> dict[str, str]:
        app.state.store.block_user(user.id, target_user_id)
        return {"status": "blocked"}

    @app.post("/users/{target_user_id}/report")
    def report_user(target_user_id: str, payload: ReportCreate, user: CurrentUser) -> dict[str, Any]:
        report = app.state.store.report_user(user.id, target_user_id, payload.reason)
        return serialize(report)

    return app


class SearchQuery(BaseModel):
    destination_latitude: float | None = None
    destination_longitude: float | None = None
    destination_radius_meters: float = 1000
    pickup_latitude: float | None = None
    pickup_longitude: float | None = None
    pickup_radius_meters: float = 5000
    target_date: date | None = None
    tag: str | None = None

    def to_store_query(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


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


def serialize_user(store: Store, user: User) -> dict[str, Any]:
    return {**serialize(user), "profile": serialize(store.profiles[user.id]), "vehicle": serialize(store.vehicles.get(user.id))}


def serialize_location(store: Store, location_id: str, exact: bool) -> dict[str, Any]:
    return store.location_view(location_id, exact=exact)


def serialize_ride_request(store: Store, request: Any, exact: bool) -> dict[str, Any]:
    data = serialize(request)
    data["pickup"] = serialize_location(store, request.pickup_location_id, exact)
    data["destination"] = serialize_location(store, request.destination_location_id, exact)
    return data


def serialize_driver_trip(store: Store, trip: Any, exact: bool) -> dict[str, Any]:
    data = serialize(trip)
    data["pickup"] = serialize_location(store, trip.pickup_location_id, exact)
    data["destination"] = serialize_location(store, trip.destination_location_id, exact)
    return data


def serialize_connection(store: Store, connection: Any) -> dict[str, Any]:
    data = serialize(connection)
    data["ride_request"] = serialize_ride_request(store, store.ride_requests[connection.ride_request_id], exact=connection.status == "accepted")
    data["driver_trip"] = serialize_driver_trip(store, store.driver_trips[connection.driver_trip_id], exact=connection.status == "accepted")
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
    connection = store.connections[connection_id]
    request = store.ride_requests[connection.ride_request_id]
    trip = store.driver_trips[connection.driver_trip_id]
    if user_id not in {request.rider_id, trip.driver_id}:
        raise HTTPException(status_code=403, detail="Only participants can access this connection")


app = create_app()
