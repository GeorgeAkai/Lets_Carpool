from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Any, Literal
from uuid import uuid4

import psycopg2.extras

from backend.app.db import close_pool, get_conn, init_pool, run_migrations
from backend.app.routing import OSRMClient


ListingStatus = Literal["open", "paused", "expired", "matched", "cancelled", "completed"]
ConnectionStatus = Literal["pending", "expired", "accepted", "declined", "cancelled", "completed"]
LuggageSize = Literal["none", "small", "medium", "large", "oversized"]
CarType = Literal["sedan", "suv", "van", "minivan", "truck", "other"]
PoolStatus = Literal["open", "full", "cancelled", "completed"]

ALLOWED_TAGS = {"airport", "student", "church", "college", "work", "event"}
ALLOWED_LUGGAGE: set[str] = {"none", "small", "medium", "large", "oversized"}
ALLOWED_CAR_TYPES: set[str] = {"sedan", "suv", "van", "minivan", "truck", "other"}

_GAS_PRICE_PER_GALLON_USD = 3.50
_MPG_DEFAULT = 28.0
_KM_PER_MILE = 1.60934

# Corridor matching: how far a passenger's pickup/destination may be from the
# driver's route, and how many corridor survivors get a (routed) detour estimate.
ROUTE_BUFFER_METERS = 1000
# A driver heading to (or leaving from) a whole area such as "Sacramento" is
# visible to anyone whose exact address is within this distance of it.
GENERAL_AREA_RADIUS_METERS = 15000
MAX_DETOUR_CANDIDATES = 10

PENDING_CANNED_MESSAGES = {
    "timing": "Can we coordinate the exact timing?",
    "pickup": "Can we confirm the pickup area?",
    "luggage": "I have a luggage question.",
}


# Sentinel for "field not sent — keep the stored value" on partial updates.
_KEEP: Any = object()

_PHONE_RE = re.compile(r"^\+?[0-9 ()\-]{7,20}$")
_PLATE_RE = re.compile(r"^[A-Za-z0-9 \-]{2,10}$")


class DomainError(ValueError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def now_utc() -> datetime:
    return datetime.now(UTC)


def email_domain(email: str) -> str:
    return email.split("@", 1)[1].lower()


def haversine_meters(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    radius = 6_371_000
    d_lat = radians(b_lat - a_lat)
    d_lng = radians(b_lng - a_lng)
    lat1 = radians(a_lat)
    lat2 = radians(b_lat)
    h = sin(d_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(d_lng / 2) ** 2
    return 2 * radius * asin(sqrt(h))


def calculate_fare_cents(distance_km: float, passenger_count: int = 1,
                          gas_price_per_gallon: float = _GAS_PRICE_PER_GALLON_USD,
                          mpg: float = _MPG_DEFAULT) -> int:
    km_per_gallon = mpg * _KM_PER_MILE
    gas_cost_usd = (distance_km / km_per_gallon) * gas_price_per_gallon
    per_passenger = gas_cost_usd / max(1, passenger_count)
    return max(100, round(per_passenger * 100))


# ─── Dataclasses (unchanged — used as return types by Store methods) ──────────

@dataclass
class User:
    id: str
    email: str
    email_domain: str
    provider: str
    provider_subject: str
    created_at: datetime
    status: str = "active"
    suspended_at: datetime | None = None
    suspended_reason: str | None = None
    id_verified: bool = False


@dataclass
class Profile:
    user_id: str
    display_name: str
    photo_url: str | None = None
    bio: str | None = None
    photo_verified: bool = False
    interests: list[str] = field(default_factory=list)
    nationality: str | None = None
    phone: str | None = None


@dataclass
class Vehicle:
    user_id: str
    make: str | None = None
    model: str | None = None
    color: str | None = None
    seats: int | None = None
    car_type: str | None = None
    has_license: bool = False
    has_insurance: bool = False
    has_good_driving_record: bool = False
    plate: str | None = None


@dataclass
class Location:
    id: str
    label: str
    latitude: float
    longitude: float
    provider: str | None = None
    provider_place_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=now_utc)
    is_general: bool = False

    @property
    def approximate_label(self) -> str:
        parts = [part.strip() for part in self.label.split(",") if part.strip()]
        return ", ".join(parts[-2:]) if len(parts) >= 2 else self.label


@dataclass
class RideRequest:
    id: str
    rider_id: str
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    passenger_count: int
    tags: list[str]
    status: ListingStatus
    created_at: datetime
    luggage_size: str = "none"
    preferred_car_type: str | None = None
    notes: str | None = None
    departure_time: time | None = None
    # Minutes this passenger would add to a driver's trip; only set on driver-side proposals.
    detour_minutes: float | None = None
    # Driver-side matches only: how far the passenger's pickup sits from the trip's
    # route (metres) and a 0-100 match score (detour + date/flexibility).
    off_route_m: float | None = None
    match_score: int | None = None


@dataclass
class DriverTrip:
    id: str
    driver_id: str
    pickup_location_id: str
    destination_location_id: str
    target_date: date
    flexibility: str
    seats_available: int
    seats_reserved: int
    tags: list[str]
    status: ListingStatus
    created_at: datetime
    luggage_capacity: str = "medium"
    car_type: str | None = None
    notes: str | None = None
    departure_time: time | None = None
    price_per_seat_cents: int | None = None
    auto_accept_verified: bool = False
    series_id: str | None = None
    route_distance_m: float | None = None
    route_duration_s: float | None = None
    # Minutes added to this trip if the searching passenger is picked up. Only set
    # on corridor-search results (needs the passenger's pickup + destination).
    detour_minutes: float | None = None


@dataclass
class Connection:
    id: str
    ride_request_id: str
    driver_trip_id: str
    initiator_user_id: str
    status: ConnectionStatus
    created_at: datetime
    updated_at: datetime
    completed_confirmed_by: list[str] = field(default_factory=list)
    rider_at_pickup_at: datetime | None = None
    picked_up_at: datetime | None = None


@dataclass
class Message:
    id: str
    connection_id: str
    sender_id: str
    content: str
    kind: Literal["canned", "free_text"]
    created_at: datetime


@dataclass
class GasSplitConfirmation:
    id: str
    connection_id: str
    confirmer_id: str
    amount_cents: int
    currency: str
    assumptions: dict[str, Any]
    created_at: datetime


@dataclass
class Notification:
    id: str
    user_id: str
    type: str
    title: str
    body: str
    created_at: datetime
    read: bool = False
    related_id: str | None = None


@dataclass
class Report:
    id: str
    reporter_id: str
    reported_user_id: str
    reason: str
    created_at: datetime
    status: str = "open"


@dataclass
class AuditLogEntry:
    id: str
    event_type: str
    actor_user_id: str | None
    actor_email: str | None
    ip_address: str | None
    detail: dict[str, Any]
    created_at: datetime


@dataclass
class Pool:
    id: str
    name: str
    organizer_id: str
    community_tag: str
    trip_date: date
    departure_time: time
    pickup_location_id: str
    destination_location_id: str
    max_participants: int
    status: PoolStatus
    created_at: datetime
    description: str | None = None
    seats_per_vehicle: int = 4


@dataclass
class PoolMembership:
    pool_id: str
    user_id: str
    role: str
    joined_at: datetime


@dataclass
class PoolMessage:
    id: str
    pool_id: str
    sender_id: str
    content: str
    created_at: datetime


@dataclass
class DriverLocation:
    user_id: str
    latitude: float
    longitude: float
    heading: float | None = None
    speed_kmh: float | None = None
    updated_at: datetime = field(default_factory=now_utc)


# ─── Row → Dataclass helpers ──────────────────────────────────────────────────

def _row_to_user(r: dict) -> User:
    return User(
        id=r["id"], email=r["email"], email_domain=r["email_domain"],
        provider=r["provider"], provider_subject=r["provider_subject"],
        created_at=r["created_at"], status=r.get("status", "active"),
        suspended_at=r.get("suspended_at"), suspended_reason=r.get("suspended_reason"),
        id_verified=bool(r.get("id_verified") or False),
    )

def _row_to_report(r: dict) -> Report:
    return Report(
        id=r["id"], reporter_id=r["reporter_id"], reported_user_id=r["reported_user_id"],
        reason=r["reason"], created_at=r["created_at"], status=r.get("status", "open"),
    )

def _row_to_audit_log(r: dict) -> AuditLogEntry:
    detail = r["detail"]
    if isinstance(detail, str):
        detail = json.loads(detail)
    return AuditLogEntry(
        id=r["id"], event_type=r["event_type"], actor_user_id=r["actor_user_id"],
        actor_email=r["actor_email"], ip_address=r["ip_address"],
        detail=detail or {}, created_at=r["created_at"],
    )

def _row_to_profile(r: dict) -> Profile:
    return Profile(
        user_id=r["user_id"], display_name=r["display_name"],
        photo_url=r["photo_url"], bio=r["bio"],
        photo_verified=r["photo_verified"],
        interests=list(r["interests"] or []), nationality=r["nationality"],
        phone=r.get("phone"),
    )

def _row_to_vehicle(r: dict) -> Vehicle:
    return Vehicle(
        user_id=r["user_id"], make=r["make"], model=r["model"],
        color=r["color"], seats=r["seats"], car_type=r["car_type"],
        has_license=r["has_license"], has_insurance=r["has_insurance"],
        has_good_driving_record=r["has_good_driving_record"],
        plate=r.get("plate"),
    )

def _row_to_location(r: dict) -> Location:
    meta = r["metadata"]
    if isinstance(meta, str):
        meta = json.loads(meta)
    return Location(
        id=r["id"], label=r["label"], latitude=r["latitude"],
        longitude=r["longitude"], provider=r["provider"],
        provider_place_id=r["provider_place_id"],
        metadata=meta or {},
        created_at=r["created_at"],
        is_general=bool(r.get("is_general")),
    )

def _row_to_ride_request(r: dict) -> RideRequest:
    return RideRequest(
        id=r["id"], rider_id=r["rider_id"],
        pickup_location_id=r["pickup_location_id"],
        destination_location_id=r["destination_location_id"],
        target_date=r["target_date"], flexibility=r["flexibility"],
        passenger_count=r["passenger_count"],
        tags=list(r["tags"] or []),
        status=r["status"], created_at=r["created_at"],
        luggage_size=r["luggage_size"] or "none",
        preferred_car_type=r["preferred_car_type"],
        notes=r["notes"], departure_time=r.get("departure_time"),
    )

def _proposal_score(detour_minutes: float | None, trip: DriverTrip, rr: RideRequest) -> float:
    """0..1: 70% detour (0 min = 1, 15+ min or unknown = 0), 30% date/flexibility
    closeness. Mirrors the frontend's Best Matches weighting minus the
    profile-based terms, which a proposal doesn't have."""
    detour = 0.0 if detour_minutes is None else max(0.0, 1 - detour_minutes / 15)
    days = abs((trip.target_date - rr.target_date).days)
    date_score = 1.0 if days == 0 else 0.7
    if trip.flexibility == rr.flexibility:
        flex_score = 1.0
    elif "flexible" in (trip.flexibility, rr.flexibility):
        flex_score = 0.6
    else:
        flex_score = 0.2
    return 0.7 * detour + 0.3 * (0.6 * date_score + 0.4 * flex_score)


def _row_to_driver_trip(r: dict) -> DriverTrip:
    return DriverTrip(
        id=r["id"], driver_id=r["driver_id"],
        pickup_location_id=r["pickup_location_id"],
        destination_location_id=r["destination_location_id"],
        target_date=r["target_date"], flexibility=r["flexibility"],
        seats_available=r["seats_available"], seats_reserved=r["seats_reserved"],
        tags=list(r["tags"] or []),
        status=r["status"], created_at=r["created_at"],
        luggage_capacity=r["luggage_capacity"] or "medium",
        car_type=r["car_type"],
        notes=r["notes"], departure_time=r.get("departure_time"),
        price_per_seat_cents=r.get("price_per_seat_cents"),
        auto_accept_verified=bool(r.get("auto_accept_verified") or False),
        series_id=r.get("series_id"),
        route_distance_m=r.get("route_distance_m"), route_duration_s=r.get("route_duration_s"),
    )

def _row_to_connection(r: dict) -> Connection:
    return Connection(
        id=r["id"], ride_request_id=r["ride_request_id"],
        driver_trip_id=r["driver_trip_id"],
        initiator_user_id=r["initiator_user_id"],
        status=r["status"], created_at=r["created_at"],
        updated_at=r["updated_at"],
        completed_confirmed_by=list(r["completed_confirmed_by"] or []),
        rider_at_pickup_at=r.get("rider_at_pickup_at"),
        picked_up_at=r.get("picked_up_at"),
    )

def _row_to_message(r: dict) -> Message:
    return Message(
        id=r["id"], connection_id=r["connection_id"],
        sender_id=r["sender_id"], content=r["content"],
        kind=r["kind"], created_at=r["created_at"],
    )

def _row_to_gas_split(r: dict) -> GasSplitConfirmation:
    assumptions = r["assumptions"]
    if isinstance(assumptions, str):
        assumptions = json.loads(assumptions)
    return GasSplitConfirmation(
        id=r["id"], connection_id=r["connection_id"],
        confirmer_id=r["confirmer_id"], amount_cents=r["amount_cents"],
        currency=r["currency"], assumptions=assumptions or {},
        created_at=r["created_at"],
    )

def _row_to_notification(r: dict) -> Notification:
    return Notification(
        id=r["id"], user_id=r["user_id"], type=r["type"],
        title=r["title"], body=r["body"], created_at=r["created_at"],
        read=r["read"], related_id=r["related_id"],
    )

def _row_to_pool(r: dict) -> Pool:
    return Pool(
        id=r["id"], name=r["name"], organizer_id=r["organizer_id"],
        community_tag=r["community_tag"], trip_date=r["trip_date"],
        departure_time=r["departure_time"],
        pickup_location_id=r["pickup_location_id"],
        destination_location_id=r["destination_location_id"],
        max_participants=r["max_participants"], status=r["status"],
        created_at=r["created_at"], description=r["description"],
        seats_per_vehicle=r["seats_per_vehicle"],
    )

def _row_to_membership(r: dict) -> PoolMembership:
    return PoolMembership(
        pool_id=r["pool_id"], user_id=r["user_id"],
        role=r["role"], joined_at=r["joined_at"],
    )

def _row_to_pool_message(r: dict) -> PoolMessage:
    return PoolMessage(
        id=r["id"], pool_id=r["pool_id"], sender_id=r["sender_id"],
        content=r["content"], created_at=r["created_at"],
    )


# ─── Store ────────────────────────────────────────────────────────────────────

class Store:
    def __init__(self, database_url: str, router: OSRMClient | None = None) -> None:
        # Optional: with no router, trips are stored without a route and search
        # falls back to endpoint-radius matching.
        self.router = router
        run_migrations(database_url)
        # Closes any pool from a previous Store instance in this process before
        # opening a new one — otherwise each new Store() (every test's client())
        # leaks the old pool's connections instead of releasing them.
        close_pool()
        init_pool(database_url)

    def _cur(self, conn):
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ─── Auth ─────────────────────────────────────────────────────────────────

    def authenticate_email(self, email: str, display_name: str) -> tuple[User, bool]:
        """Returns (user, is_new_signup) — the latter drives the USER_REGISTERED audit event."""
        normalized_email = email.strip().lower()
        normalized_name = display_name.strip()
        if not normalized_name:
            raise DomainError("Display name is required")
        if "@" not in normalized_email:
            raise DomainError("Enter a valid email address")

        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM users WHERE email = %s", (normalized_email,))
            row = cur.fetchone()
            if row:
                return _row_to_user(row), False

            user_id = new_id("usr")
            cur.execute(
                """INSERT INTO users (id, email, email_domain, provider, provider_subject, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (user_id, normalized_email, email_domain(normalized_email),
                 "email", normalized_email, now_utc()),
            )
            cur.execute(
                """INSERT INTO profiles (user_id, display_name) VALUES (%s, %s)
                   ON CONFLICT (user_id) DO NOTHING""",
                (user_id, normalized_name),
            )
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            return _row_to_user(cur.fetchone()), True

    def user_for_id(self, user_id: str) -> User:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Invalid or expired token", 401)
            return _row_to_user(row)

    # ─── Profile ──────────────────────────────────────────────────────────────

    def update_profile(
        self, user_id: str, display_name: str, photo_url: str | None, bio: str | None,
        interests: list[str] | None = None, nationality: str | None = None,
        phone: Any = _KEEP,
    ) -> Profile:
        if phone is not _KEEP:
            phone = (phone or "").strip() or None
            if phone and not _PHONE_RE.match(phone):
                raise DomainError("Enter a valid phone number")
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO profiles (user_id, display_name, photo_url, bio, interests, nationality)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (user_id) DO UPDATE
                   SET display_name = EXCLUDED.display_name,
                       photo_url    = EXCLUDED.photo_url,
                       bio          = EXCLUDED.bio,
                       interests    = EXCLUDED.interests,
                       nationality  = EXCLUDED.nationality""",
                (user_id, display_name, photo_url, bio, interests or [], nationality),
            )
            if phone is not _KEEP:
                cur.execute("UPDATE profiles SET phone = %s WHERE user_id = %s", (phone, user_id))
            cur.execute("SELECT * FROM profiles WHERE user_id = %s", (user_id,))
            return _row_to_profile(cur.fetchone())

    def upload_photo(self, user_id: str, photo_data_url: str) -> Profile:
        if not photo_data_url.startswith("data:image/"):
            raise DomainError("Photo must be a valid image data URL")
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO profiles (user_id, display_name, photo_url, photo_verified)
                   VALUES (%s, '', %s, TRUE)
                   ON CONFLICT (user_id) DO UPDATE
                   SET photo_url = EXCLUDED.photo_url,
                       photo_verified = TRUE""",
                (user_id, photo_data_url),
            )
            cur.execute("SELECT * FROM profiles WHERE user_id = %s", (user_id,))
            return _row_to_profile(cur.fetchone())

    def get_profile(self, user_id: str) -> Profile | None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM profiles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            return _row_to_profile(row) if row else None

    # ─── Vehicle ──────────────────────────────────────────────────────────────

    def update_vehicle(self, user_id: str, data: dict[str, Any]) -> Vehicle:
        if data.get("car_type") and data["car_type"] not in ALLOWED_CAR_TYPES:
            raise DomainError(f"Invalid car type: {data['car_type']}")
        if data.get("plate") is not None:
            plate = data["plate"].strip().upper()
            if plate and not _PLATE_RE.match(plate):
                raise DomainError("Enter a valid license plate")
            data = {**data, "plate": plate or None}
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM vehicles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            v = _row_to_vehicle(row) if row else Vehicle(user_id=user_id)
            for f in ("make", "model", "color", "seats", "car_type",
                      "has_license", "has_insurance", "has_good_driving_record"):
                if f in data and data[f] is not None:
                    setattr(v, f, data[f])
            if "plate" in data:
                v.plate = data["plate"]
            cur.execute(
                """INSERT INTO vehicles (user_id, make, model, color, seats, car_type,
                       has_license, has_insurance, has_good_driving_record)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (user_id) DO UPDATE SET
                       make = EXCLUDED.make, model = EXCLUDED.model,
                       color = EXCLUDED.color, seats = EXCLUDED.seats,
                       car_type = EXCLUDED.car_type,
                       has_license = EXCLUDED.has_license,
                       has_insurance = EXCLUDED.has_insurance,
                       has_good_driving_record = EXCLUDED.has_good_driving_record""",
                (v.user_id, v.make, v.model, v.color, v.seats, v.car_type,
                 v.has_license, v.has_insurance, v.has_good_driving_record),
            )
            cur.execute("UPDATE vehicles SET plate = %s WHERE user_id = %s", (v.plate, v.user_id))
            return v

    def get_vehicle(self, user_id: str) -> Vehicle | None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM vehicles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            return _row_to_vehicle(row) if row else None

    # ─── Locations ────────────────────────────────────────────────────────────

    def create_location(self, data: dict[str, Any]) -> Location:
        loc = Location(
            id=new_id("loc"),
            label=data["label"],
            latitude=data["latitude"],
            longitude=data["longitude"],
            provider=data.get("provider"),
            provider_place_id=data.get("provider_place_id"),
            metadata=data.get("metadata") or {},
            is_general=bool(data.get("is_general")),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO locations (id, label, latitude, longitude, provider,
                       provider_place_id, metadata, created_at, is_general, geog)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                           ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)""",
                (loc.id, loc.label, loc.latitude, loc.longitude, loc.provider,
                 loc.provider_place_id, json.dumps(loc.metadata), loc.created_at, loc.is_general,
                 loc.longitude, loc.latitude),
            )
        return loc

    def get_location(self, location_id: str) -> Location:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM locations WHERE id = %s", (location_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError(f"Location {location_id} not found", 404)
            return _row_to_location(row)

    # ─── Ride Requests ────────────────────────────────────────────────────────

    def create_ride_request(self, rider_id: str, data: dict[str, Any]) -> RideRequest:
        self._validate_location_ids(data["pickup_location_id"], data["destination_location_id"])
        tags = self._validate_tags(data.get("tags") or [])
        passenger_count = int(data["passenger_count"])
        if passenger_count < 1:
            raise DomainError("Passenger count must be at least 1")
        luggage_size = data.get("luggage_size") or "none"
        if luggage_size not in ALLOWED_LUGGAGE:
            raise DomainError(f"Invalid luggage size: {luggage_size}")
        preferred_car_type = data.get("preferred_car_type")
        if preferred_car_type and preferred_car_type not in ALLOWED_CAR_TYPES:
            raise DomainError(f"Invalid car type: {preferred_car_type}")
        notes = (data.get("notes") or "").strip() or None

        rr = RideRequest(
            id=new_id("rrq"), rider_id=rider_id,
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            target_date=data["target_date"], flexibility=data["flexibility"],
            passenger_count=passenger_count, tags=tags,
            status="open", created_at=now_utc(),
            luggage_size=luggage_size, preferred_car_type=preferred_car_type,
            notes=notes, departure_time=data.get("departure_time"),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO ride_requests (id, rider_id, pickup_location_id,
                       destination_location_id, target_date, flexibility,
                       passenger_count, tags, status, created_at, luggage_size,
                       preferred_car_type, notes, departure_time)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (rr.id, rr.rider_id, rr.pickup_location_id,
                 rr.destination_location_id, rr.target_date, rr.flexibility,
                 rr.passenger_count, rr.tags, rr.status, rr.created_at,
                 rr.luggage_size, rr.preferred_car_type, rr.notes, rr.departure_time),
            )
        return rr

    def cancel_ride_request(self, user_id: str, request_id: str) -> RideRequest:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM ride_requests WHERE id = %s", (request_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Ride request not found", 404)
            rr = _row_to_ride_request(row)
            if rr.rider_id != user_id:
                raise DomainError("Only the passenger can cancel this request", 403)
            cur.execute("UPDATE ride_requests SET status = 'cancelled' WHERE id = %s", (request_id,))
            rr.status = "cancelled"
            return rr

    def update_ride_request_pickup(self, user_id: str, request_id: str, pickup_location_id: str) -> RideRequest:
        rr = self.get_ride_request(request_id)
        if rr.rider_id != user_id:
            raise DomainError("Only the passenger can update this request's pickup", 403)
        self.get_location(pickup_location_id)  # 404s if it doesn't exist
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE ride_requests SET pickup_location_id = %s WHERE id = %s",
                (pickup_location_id, request_id),
            )
        rr.pickup_location_id = pickup_location_id
        return rr

    def get_ride_request(self, request_id: str) -> RideRequest:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM ride_requests WHERE id = %s", (request_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Ride request not found", 404)
            return _row_to_ride_request(row)

    def get_user_ride_requests(self, user_id: str) -> list[RideRequest]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM ride_requests WHERE rider_id = %s ORDER BY created_at DESC",
                (user_id,),
            )
            return [_row_to_ride_request(r) for r in cur.fetchall()]

    # ─── Driver Trips ─────────────────────────────────────────────────────────

    def create_driver_trip(self, driver_id: str, data: dict[str, Any]) -> DriverTrip:
        self._validate_location_ids(data["pickup_location_id"], data["destination_location_id"])
        tags = self._validate_tags(data.get("tags") or [])
        seats_available = int(data["seats_available"])
        if seats_available < 1:
            raise DomainError("Seats available must be at least 1")
        luggage_capacity = data.get("luggage_capacity") or "medium"
        if luggage_capacity not in ALLOWED_LUGGAGE:
            raise DomainError(f"Invalid luggage capacity: {luggage_capacity}")
        car_type = data.get("car_type")
        if car_type and car_type not in ALLOWED_CAR_TYPES:
            raise DomainError(f"Invalid car type: {car_type}")
        notes = (data.get("notes") or "").strip() or None
        price = data.get("price_per_seat_cents")
        if price is not None and not (0 <= int(price) <= 100_000):
            raise DomainError("Price per seat must be between $0 and $1,000")

        trip = DriverTrip(
            id=new_id("trp"), driver_id=driver_id,
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            target_date=data["target_date"], flexibility=data["flexibility"],
            seats_available=seats_available, seats_reserved=0,
            tags=tags, status="open", created_at=now_utc(),
            luggage_capacity=luggage_capacity, car_type=car_type,
            notes=notes, departure_time=data.get("departure_time"),
            price_per_seat_cents=None if price is None else int(price),
            auto_accept_verified=bool(data.get("auto_accept_verified")),
            series_id=data.get("series_id"),
        )
        # One routing call per trip creation (not per search). Done before
        # opening the DB connection so a slow OSRM doesn't hold a pooled one.
        route_wkt, route_distance_m, route_duration_s = data.get("_route") or self._compute_trip_route(trip)
        trip.route_distance_m, trip.route_duration_s = route_distance_m, route_duration_s
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO driver_trips (id, driver_id, pickup_location_id,
                       destination_location_id, target_date, flexibility,
                       seats_available, seats_reserved, tags, status, created_at,
                       luggage_capacity, car_type, notes,
                       route_geog, route_distance_m, route_duration_s,
                       departure_time, price_per_seat_cents, auto_accept_verified, series_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           ST_GeogFromText(%s), %s, %s, %s, %s, %s, %s)""",
                (trip.id, trip.driver_id, trip.pickup_location_id,
                 trip.destination_location_id, trip.target_date, trip.flexibility,
                 trip.seats_available, trip.seats_reserved, trip.tags,
                 trip.status, trip.created_at, trip.luggage_capacity, trip.car_type,
                 trip.notes, route_wkt, route_distance_m, route_duration_s,
                 trip.departure_time, trip.price_per_seat_cents, trip.auto_accept_verified,
                 trip.series_id),
            )
        self._fulfil_ride_alerts(trip)
        return trip

    def create_driver_trip_series(self, driver_id: str, data: dict[str, Any], weekdays: list[int]) -> list[DriverTrip]:
        """'Repeat on weekdays': one trip per matching day in the 7 days starting
        at target_date (target_date itself always included), linked by series_id
        so passengers can book any day of the week. Each day stays an ordinary
        one-off trip for search, seats and expiry."""
        if any(d not in range(7) for d in weekdays):
            raise DomainError("Weekdays must be 0 (Mon) to 6 (Sun)")
        start: date = data["target_date"]
        days = [start] + [start + timedelta(days=i) for i in range(1, 7)
                          if (start + timedelta(days=i)).weekday() in set(weekdays)]
        series_id = new_id("ser")
        first = self.create_driver_trip(driver_id, {**data, "series_id": series_id})
        # Same route for every day: reuse the first day's routing result.
        route = (None, first.route_distance_m, first.route_duration_s)
        if first.route_distance_m is not None:
            with get_conn() as conn:
                cur = self._cur(conn)
                cur.execute("SELECT ST_AsText(route_geog) AS wkt FROM driver_trips WHERE id = %s", (first.id,))
                row = cur.fetchone()
                route = (row["wkt"] if row else None, first.route_distance_m, first.route_duration_s)
        trips = [first]
        for day in days[1:]:
            trips.append(self.create_driver_trip(
                driver_id, {**data, "target_date": day, "series_id": series_id, "_route": route}))
        return trips

    # ─── Pricing / timing ─────────────────────────────────────────────────────

    def trip_distance_km(self, trip: DriverTrip) -> float:
        if trip.route_distance_m:
            return trip.route_distance_m / 1000
        pickup = self.get_location(trip.pickup_location_id)
        destination = self.get_location(trip.destination_location_id)
        # Straight-line distance understates roads; 1.25 is a typical detour index.
        return haversine_meters(pickup.latitude, pickup.longitude,
                                destination.latitude, destination.longitude) / 1000 * 1.25

    def trip_duration_minutes(self, trip: DriverTrip) -> float:
        if trip.route_duration_s:
            return trip.route_duration_s / 60
        return self.trip_distance_km(trip) / 50 * 60  # ~50 km/h mixed driving

    def trip_pricing(self, trip: DriverTrip) -> dict[str, Any]:
        """Gas cost for the whole trip, split evenly between the driver and every
        offered seat — cost-neutral for the driver. A driver-set price wins."""
        distance_km = self.trip_distance_km(trip)
        gas_cents = calculate_fare_cents(distance_km, 1)
        suggested = max(100, round(gas_cents / (trip.seats_available + 1)))
        return {
            "distance_km": round(distance_km, 1),
            "gas_cost_cents": gas_cents,
            "split_between": trip.seats_available + 1,
            "suggested_price_cents": suggested,
            "price_per_seat_cents": trip.price_per_seat_cents if trip.price_per_seat_cents is not None else suggested,
        }

    def trip_arrival_time(self, trip: DriverTrip) -> time | None:
        if trip.departure_time is None:
            return None
        start = datetime.combine(trip.target_date, trip.departure_time)
        return (start + timedelta(minutes=round(self.trip_duration_minutes(trip)))).time()

    def _compute_trip_route(self, trip: DriverTrip) -> tuple[str | None, float | None, float | None]:
        if self.router is None:
            return None, None, None
        pickup = self.get_location(trip.pickup_location_id)
        destination = self.get_location(trip.destination_location_id)
        route = self.router.route([
            (pickup.latitude, pickup.longitude), (destination.latitude, destination.longitude),
        ])
        wkt = route.to_wkt() if route else None
        if route is None or wkt is None:
            return None, None, None
        return wkt, route.distance_m, route.duration_s

    def cancel_driver_trip(self, user_id: str, trip_id: str) -> DriverTrip:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM driver_trips WHERE id = %s", (trip_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Driver trip not found", 404)
            trip = _row_to_driver_trip(row)
            if trip.driver_id != user_id:
                raise DomainError("Only the driver can cancel this trip", 403)
            cur.execute("UPDATE driver_trips SET status = 'cancelled' WHERE id = %s", (trip_id,))
            trip.status = "cancelled"
            return trip

    def _own_trip(self, user_id: str, trip_id: str, action: str) -> DriverTrip:
        trip = self.get_driver_trip(trip_id)
        if trip.driver_id != user_id:
            raise DomainError(f"Only the driver can {action} this trip", 403)
        return trip

    def pause_driver_trip(self, user_id: str, trip_id: str) -> DriverTrip:
        """Hide an open trip from search and proposals without cancelling it.
        Passengers already accepted keep their seats."""
        trip = self._own_trip(user_id, trip_id, "pause")
        if trip.status != "open":
            raise DomainError("Only open trips can be paused")
        with get_conn() as conn:
            self._cur(conn).execute("UPDATE driver_trips SET status = 'paused' WHERE id = %s", (trip_id,))
        trip.status = "paused"
        return trip

    def resume_driver_trip(self, user_id: str, trip_id: str) -> DriverTrip:
        trip = self._own_trip(user_id, trip_id, "resume")
        if trip.status != "paused":
            raise DomainError("Only paused trips can be resumed")
        status = "matched" if trip.seats_reserved >= trip.seats_available else "open"
        with get_conn() as conn:
            self._cur(conn).execute("UPDATE driver_trips SET status = %s WHERE id = %s", (status, trip_id))
        trip.status = status
        return trip

    def update_driver_trip(self, user_id: str, trip_id: str, data: dict[str, Any]) -> DriverTrip:
        """Edit the schedule, seats and note of a trip that hasn't run yet. The
        route stays fixed (post a new trip to change it)."""
        trip = self._own_trip(user_id, trip_id, "edit")
        if trip.status not in {"open", "paused", "matched"}:
            raise DomainError("This trip can no longer be edited")
        if data.get("seats_available") is not None:
            seats = int(data["seats_available"])
            if seats < max(1, trip.seats_reserved):
                raise DomainError("Seats can't be fewer than the seats already booked")
            trip.seats_available = seats
            if trip.status == "matched" and seats > trip.seats_reserved:
                trip.status = "open"
            elif trip.status == "open" and seats <= trip.seats_reserved:
                trip.status = "matched"
        if data.get("target_date") is not None:
            trip.target_date = data["target_date"]
        if data.get("flexibility") is not None:
            trip.flexibility = data["flexibility"]
        if "departure_time" in data:
            trip.departure_time = data["departure_time"]
        if "notes" in data:
            trip.notes = (data.get("notes") or "").strip() or None
        with get_conn() as conn:
            self._cur(conn).execute(
                """UPDATE driver_trips SET seats_available = %s, target_date = %s, flexibility = %s,
                       departure_time = %s, notes = %s, status = %s WHERE id = %s""",
                (trip.seats_available, trip.target_date, trip.flexibility, trip.departure_time,
                 trip.notes, trip.status, trip_id),
            )
        return trip

    def get_driver_trip(self, trip_id: str) -> DriverTrip:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM driver_trips WHERE id = %s", (trip_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Driver trip not found", 404)
            return _row_to_driver_trip(row)

    def get_user_driver_trips(self, user_id: str) -> list[DriverTrip]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM driver_trips WHERE driver_id = %s ORDER BY created_at DESC",
                (user_id,),
            )
            return [_row_to_driver_trip(r) for r in cur.fetchall()]

    def expire_listings(self, today: date) -> None:
        # `today` (and CURRENT_DATE in the search queries) is evaluated in the
        # DB server's timezone (UTC), but a listing's target_date reflects the
        # passenger/driver's own local "today". Once it's past midnight UTC — early
        # evening in any US timezone — a listing dated "today" locally already
        # reads as "yesterday" server-side. A 1-day grace period keeps this from
        # archiving (or hiding) a still-relevant same-day listing; it just delays
        # archiving genuinely stale ones by up to a day, which is the safe side
        # to err on.
        cutoff = today - timedelta(days=1)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE ride_requests SET status = 'expired' WHERE status = 'open' AND target_date < %s",
                (cutoff,),
            )
            cur.execute(
                "UPDATE driver_trips SET status = 'expired' WHERE status IN ('open', 'paused') AND target_date < %s",
                (cutoff,),
            )

    # ─── Search ───────────────────────────────────────────────────────────────

    def search_driver_trips(self, user_id: str, query: dict[str, Any]) -> list[DriverTrip]:
        # Actually archive stale listings here too, not just filter them out of
        # this result set — search is the one path guaranteed to run on every
        # page load, so it doesn't depend on the cron sweep (GET /cron/expire)
        # actually being scheduled yet. Idempotent and cheap: matches ~0 rows
        # once a listing has already been archived once.
        self.expire_listings(now_utc().date())
        corridor = self._corridor_search(query)
        if corridor:
            joins, geo_conditions, geo_params = corridor
        else:
            joins, geo_conditions, geo_params = self._geo_search_clauses(
                query, "dt.destination_location_id", "dt.pickup_location_id",
            )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"""SELECT DISTINCT dt.*,
                          tp.latitude AS trip_pickup_lat, tp.longitude AS trip_pickup_lng,
                          td.latitude AS trip_dest_lat, td.longitude AS trip_dest_lng
                   FROM driver_trips dt
                   JOIN locations tp ON tp.id = dt.pickup_location_id
                   JOIN locations td ON td.id = dt.destination_location_id
                   {joins}
                   WHERE dt.status IN ('open', 'matched')
                   AND dt.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND dt.driver_id != %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = dt.driver_id AND u.status = 'suspended')
                   {geo_conditions}
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = dt.driver_id)
                          OR (blocker_id = dt.driver_id AND blocked_id = %s)
                   )
                   ORDER BY dt.created_at DESC""",
                (user_id, *geo_params, user_id, user_id),
            )
            rows = cur.fetchall()

        trips = [_row_to_driver_trip(r) for r in rows]
        if corridor:
            self._attach_detours(trips, rows, query)
        return [t for t in trips if self._listing_matches_query(t, query)]

    # ─── Proposed matches (Empower-style) ─────────────────────────────────────

    def propose_match(self, user_id: str, ride_request_id: str) -> dict[str, Any]:
        """The system's single best driver trip for a passenger's open request.

        Not a new connection state: a proposal is just a ranked search the passenger
        answers by accepting (POST /connections, as before) or skipping
        (skip_match). Candidates are the corridor search over the request's own
        pickup/destination, minus trips already skipped or connected to this
        request, trips without enough free seats, and dates more than a day
        apart. Ranked mostly by detour, with date/flexibility closeness second."""
        rr = self.get_ride_request(ride_request_id)
        if rr.rider_id != user_id:
            raise DomainError("Only the passenger can get proposals for this request", 403)
        if rr.status != "open":
            return {"trip": None, "remaining": 0}
        pickup = self.get_location(rr.pickup_location_id)
        destination = self.get_location(rr.destination_location_id)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT driver_trip_id FROM match_skips WHERE ride_request_id = %s", (rr.id,))
            excluded = {r["driver_trip_id"] for r in cur.fetchall()}
            cur.execute("SELECT driver_trip_id FROM connections WHERE ride_request_id = %s", (rr.id,))
            excluded |= {r["driver_trip_id"] for r in cur.fetchall()}

        candidates = self.search_driver_trips(user_id, {
            "pickup_latitude": pickup.latitude, "pickup_longitude": pickup.longitude,
            "destination_latitude": destination.latitude, "destination_longitude": destination.longitude,
        })
        eligible = [
            t for t in candidates
            if t.status == "open" and t.id not in excluded
            and t.seats_available - t.seats_reserved >= rr.passenger_count
            and abs((t.target_date - rr.target_date).days) <= 1
        ]
        eligible.sort(key=lambda t: -_proposal_score(t.detour_minutes, t, rr))
        return {"trip": eligible[0] if eligible else None, "remaining": max(len(eligible) - 1, 0)}

    def propose_rider(self, user_id: str, driver_trip_id: str) -> dict[str, Any]:
        """Driver-side mirror of propose_match: the best open ride request along
        a driver's own trip. Same corridor rules (both of the passenger's points
        within the buffer of the trip's route, destination ahead of pickup);
        trips with no stored route fall back to endpoint radii. Accepting is a
        driver-initiated POST /connections; skipping is remembered per trip."""
        trip = self.get_driver_trip(driver_trip_id)
        if trip.driver_id != user_id:
            raise DomainError("Only the driver can get proposals for this trip", 403)
        if trip.status != "open":
            return {"request": None, "remaining": 0}
        requests = self._ranked_requests_for_trip(user_id, trip, include_skipped=False)
        return {"request": requests[0] if requests else None, "remaining": max(len(requests) - 1, 0)}

    def rider_matches(self, user_id: str, driver_trip_id: str, limit: int = 10) -> list[RideRequest]:
        """Every open ride request along the driver's trip, best first, each with
        its detour, distance off the route and match score. Skips don't hide a
        passenger here; passengers already connected to the trip do."""
        trip = self.get_driver_trip(driver_trip_id)
        if trip.driver_id != user_id:
            raise DomainError("Only the driver can see matches for this trip", 403)
        if trip.status != "open":
            return []
        return self._ranked_requests_for_trip(user_id, trip, include_skipped=True)[:limit]

    def _ranked_requests_for_trip(self, user_id: str, trip: DriverTrip, include_skipped: bool) -> list[RideRequest]:
        with get_conn() as conn:
            cur = self._cur(conn)
            excluded: set[str] = set()
            if not include_skipped:
                cur.execute("SELECT ride_request_id FROM driver_match_skips WHERE driver_trip_id = %s", (trip.id,))
                excluded |= {r["ride_request_id"] for r in cur.fetchall()}
            cur.execute("SELECT ride_request_id FROM connections WHERE driver_trip_id = %s", (trip.id,))
            excluded |= {r["ride_request_id"] for r in cur.fetchall()}
            cur.execute(
                """SELECT rr.*,
                          rp.latitude AS rider_pickup_lat, rp.longitude AS rider_pickup_lng,
                          rd.latitude AS rider_dest_lat, rd.longitude AS rider_dest_lng,
                          tp.latitude AS trip_pickup_lat, tp.longitude AS trip_pickup_lng,
                          td.latitude AS trip_dest_lat, td.longitude AS trip_dest_lng,
                          t.route_duration_s,
                          CASE WHEN t.route_geog IS NOT NULL
                               THEN ST_Distance(t.route_geog, rp.geog)
                               ELSE ST_Distance(tp.geog, rp.geog) END AS off_route_m
                   FROM ride_requests rr
                   JOIN locations rp ON rp.id = rr.pickup_location_id
                   JOIN locations rd ON rd.id = rr.destination_location_id
                   JOIN driver_trips t ON t.id = %s
                   JOIN locations tp ON tp.id = t.pickup_location_id
                   JOIN locations td ON td.id = t.destination_location_id
                   WHERE rr.status = 'open'
                   AND rr.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND rr.rider_id != %s
                   AND rr.passenger_count <= %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rr.rider_id AND u.status = 'suspended')
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = rr.rider_id)
                          OR (blocker_id = rr.rider_id AND blocked_id = %s)
                   )
                   AND (
                       (t.route_geog IS NOT NULL
                        AND ST_DWithin(t.route_geog, rp.geog, CASE WHEN tp.is_general THEN %s ELSE %s END)
                        AND ST_DWithin(t.route_geog, rd.geog, CASE WHEN td.is_general THEN %s ELSE %s END)
                        AND ST_LineLocatePoint(t.route_geog::geometry, rp.geog::geometry)
                            < ST_LineLocatePoint(t.route_geog::geometry, rd.geog::geometry))
                       OR
                       (t.route_geog IS NULL
                        AND ST_DWithin(tp.geog, rp.geog, CASE WHEN tp.is_general THEN %s ELSE 5000 END)
                        AND ST_DWithin(td.geog, rd.geog, CASE WHEN td.is_general THEN %s ELSE 1000 END))
                   )
                   ORDER BY rr.created_at DESC""",
                (trip.id, user_id, trip.seats_available - trip.seats_reserved,
                 user_id, user_id,
                 GENERAL_AREA_RADIUS_METERS, ROUTE_BUFFER_METERS, GENERAL_AREA_RADIUS_METERS, ROUTE_BUFFER_METERS,
                 GENERAL_AREA_RADIUS_METERS, GENERAL_AREA_RADIUS_METERS),
            )
            rows = [r for r in cur.fetchall() if r["id"] not in excluded]

        rows = [r for r in rows if abs((r["target_date"] - trip.target_date).days) <= 1]
        requests = [_row_to_ride_request(r) for r in rows]
        self._attach_request_detours(requests, rows)
        for rr, r in zip(requests, rows):
            rr.off_route_m = None if r.get("off_route_m") is None else round(r["off_route_m"])
            rr.match_score = round(100 * _proposal_score(rr.detour_minutes, trip, rr))
        requests.sort(key=lambda rr: -(rr.match_score or 0))
        return requests

    def _attach_request_detours(self, requests: list[RideRequest], rows: list[dict]) -> None:
        """Per-request insertion detour against the trip's stored route duration
        (same definition as _attach_detours, other direction), capped, parallel."""
        if self.router is None:
            return
        candidates = [
            (rr, r) for rr, r in zip(requests, rows) if r.get("route_duration_s") is not None
        ][:MAX_DETOUR_CANDIDATES]
        if not candidates:
            return

        def detour(pair: tuple[RideRequest, dict]) -> float | None:
            _, r = pair
            with_rider = self.router.route([
                (r["trip_pickup_lat"], r["trip_pickup_lng"]),
                (r["rider_pickup_lat"], r["rider_pickup_lng"]),
                (r["rider_dest_lat"], r["rider_dest_lng"]),
                (r["trip_dest_lat"], r["trip_dest_lng"]),
            ])
            if with_rider is None:
                return None
            return round(max(0.0, (with_rider.duration_s - r["route_duration_s"]) / 60), 1)

        with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
            for (rr, _), minutes in zip(candidates, pool.map(detour, candidates)):
                rr.detour_minutes = minutes

    def skip_rider(self, user_id: str, driver_trip_id: str, ride_request_id: str) -> None:
        trip = self.get_driver_trip(driver_trip_id)
        if trip.driver_id != user_id:
            raise DomainError("Only the driver can skip proposals for this trip", 403)
        self.get_ride_request(ride_request_id)  # 404s if it doesn't exist
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO driver_match_skips (driver_trip_id, ride_request_id) VALUES (%s, %s)
                   ON CONFLICT DO NOTHING""",
                (driver_trip_id, ride_request_id),
            )

    def skip_match(self, user_id: str, ride_request_id: str, driver_trip_id: str) -> None:
        rr = self.get_ride_request(ride_request_id)
        if rr.rider_id != user_id:
            raise DomainError("Only the passenger can skip proposals for this request", 403)
        self.get_driver_trip(driver_trip_id)  # 404s if it doesn't exist
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO match_skips (ride_request_id, driver_trip_id) VALUES (%s, %s)
                   ON CONFLICT DO NOTHING""",
                (ride_request_id, driver_trip_id),
            )

    @staticmethod
    def _corridor_search(query: dict[str, Any]) -> tuple[str, str, list[Any]] | None:
        """Route-corridor filter, used when the search carries both the passenger's
        pickup and destination: the driver's stored route must pass within the
        buffer of both points, with the destination *ahead* of the pickup along
        the route (ST_LineLocatePoint fractions) so an opposite-direction driver
        on the same road doesn't match. Trips with no stored route (legacy rows,
        or OSRM was down at creation) fall back to the endpoint-radius rules."""
        keys = ("pickup_latitude", "pickup_longitude", "destination_latitude", "destination_longitude")
        if any(query.get(k) is None for k in keys):
            return None
        buffer_m = query.get("route_buffer_meters", ROUTE_BUFFER_METERS)
        pickup_pt = "ST_SetSRID(ST_MakePoint(%s, %s), 4326)"
        # A trip whose pickup/destination is a general area (tp/td.is_general)
        # matches anything inside that area, not just within the street-level buffer.
        corridor = f"""(dt.route_geog IS NOT NULL
                AND ST_DWithin(dt.route_geog, {pickup_pt}::geography, CASE WHEN tp.is_general THEN %s ELSE %s END)
                AND ST_DWithin(dt.route_geog, {pickup_pt}::geography, CASE WHEN td.is_general THEN %s ELSE %s END)
                AND ST_LineLocatePoint(dt.route_geog::geometry, {pickup_pt})
                    < ST_LineLocatePoint(dt.route_geog::geometry, {pickup_pt}))"""
        fallback = """(dt.route_geog IS NULL
                AND ST_DWithin(tp.geog, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, CASE WHEN tp.is_general THEN %s ELSE %s END)
                AND ST_DWithin(td.geog, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, CASE WHEN td.is_general THEN %s ELSE %s END))"""
        plng, plat = query["pickup_longitude"], query["pickup_latitude"]
        dlng, dlat = query["destination_longitude"], query["destination_latitude"]
        area = GENERAL_AREA_RADIUS_METERS
        params = [
            plng, plat, area, buffer_m, dlng, dlat, area, buffer_m, plng, plat, dlng, dlat,
            plng, plat, area, query.get("pickup_radius_meters", 5000),
            dlng, dlat, area, query.get("destination_radius_meters", 1000),
        ]
        return "", f"AND ({corridor} OR {fallback})", params

    def _attach_detours(self, trips: list[DriverTrip], rows: list[dict], query: dict[str, Any]) -> None:
        """Minutes each candidate's trip grows by if the passenger is inserted
        (driver pickup → passenger pickup → passenger dest → driver dest, vs. the stored
        direct route). Only runs on corridor survivors, capped, in parallel."""
        if self.router is None:
            return
        rider_pickup = (query["pickup_latitude"], query["pickup_longitude"])
        rider_dest = (query["destination_latitude"], query["destination_longitude"])
        candidates = [
            (t, r) for t, r in zip(trips, rows) if r.get("route_duration_s") is not None
        ][:MAX_DETOUR_CANDIDATES]
        if not candidates:
            return

        def detour(pair: tuple[DriverTrip, dict]) -> float | None:
            _, r = pair
            with_rider = self.router.route([
                (r["trip_pickup_lat"], r["trip_pickup_lng"]), rider_pickup, rider_dest,
                (r["trip_dest_lat"], r["trip_dest_lng"]),
            ])
            if with_rider is None:
                return None
            return round(max(0.0, (with_rider.duration_s - r["route_duration_s"]) / 60), 1)

        with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
            for (trip, _), minutes in zip(candidates, pool.map(detour, candidates)):
                trip.detour_minutes = minutes

    def search_ride_requests(self, user_id: str, query: dict[str, Any]) -> list[RideRequest]:
        self.expire_listings(now_utc().date())
        joins, geo_conditions, geo_params = self._geo_search_clauses(
            query, "rr.destination_location_id", "rr.pickup_location_id",
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"""SELECT DISTINCT rr.* FROM ride_requests rr
                   {joins}
                   WHERE rr.status IN ('open', 'matched')
                   AND rr.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND rr.rider_id != %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rr.rider_id AND u.status = 'suspended')
                   {geo_conditions}
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = rr.rider_id)
                          OR (blocker_id = rr.rider_id AND blocked_id = %s)
                   )
                   ORDER BY rr.created_at DESC""",
                (user_id, *geo_params, user_id, user_id),
            )
            requests = [_row_to_ride_request(r) for r in cur.fetchall()]

        return [r for r in requests if self._listing_matches_query(r, query)]

    @staticmethod
    def _geo_search_clauses(
        query: dict[str, Any], destination_fk: str, pickup_fk: str,
    ) -> tuple[str, str, list[Any]]:
        """Builds the JOIN/WHERE fragments and params for PostGIS ST_DWithin
        radius filtering, pushed into SQL instead of fetched-then-Python-filtered.
        Fragment strings are static (never built from request input); only the
        bind parameters carry request-supplied values."""
        joins: list[str] = []
        conditions: list[str] = []
        params: list[Any] = []
        if query.get("destination_latitude") is not None:
            joins.append(f"JOIN locations dest_loc ON dest_loc.id = {destination_fk}")
            conditions.append("AND ST_DWithin(dest_loc.geog, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, CASE WHEN dest_loc.is_general THEN %s ELSE %s END)")
            params += [
                query["destination_longitude"], query["destination_latitude"],
                GENERAL_AREA_RADIUS_METERS, query.get("destination_radius_meters", 1000),
            ]
        if query.get("pickup_latitude") is not None:
            joins.append(f"JOIN locations pickup_loc ON pickup_loc.id = {pickup_fk}")
            conditions.append("AND ST_DWithin(pickup_loc.geog, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, CASE WHEN pickup_loc.is_general THEN %s ELSE %s END)")
            params += [
                query["pickup_longitude"], query["pickup_latitude"],
                GENERAL_AREA_RADIUS_METERS, query.get("pickup_radius_meters", 5000),
            ]
        return " ".join(joins), " ".join(conditions), params

    # ─── Connections ──────────────────────────────────────────────────────────

    def create_connection(self, user_id: str, data: dict[str, Any]) -> Connection:
        rr = self.get_ride_request(data["ride_request_id"])
        trip = self.get_driver_trip(data["driver_trip_id"])
        if rr.status != "open" or trip.status != "open":
            raise DomainError("Connections require open listings")
        if rr.rider_id == trip.driver_id:
            raise DomainError("Cannot connect to your own listing", 400)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only the passenger or driver can initiate this connection", 403)
        if self.is_blocked(rr.rider_id, trip.driver_id):
            raise DomainError("Blocked users cannot connect", 403)

        conn_obj = Connection(
            id=new_id("con"), ride_request_id=rr.id,
            driver_trip_id=trip.id, initiator_user_id=user_id,
            status="pending", created_at=now_utc(), updated_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO connections (id, ride_request_id, driver_trip_id,
                       initiator_user_id, status, created_at, updated_at,
                       completed_confirmed_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (conn_obj.id, conn_obj.ride_request_id, conn_obj.driver_trip_id,
                 conn_obj.initiator_user_id, conn_obj.status,
                 conn_obj.created_at, conn_obj.updated_at, []),
            )
        recipient = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        # Driver opted in to auto-accepting ID-verified passengers: skip the wait.
        if (user_id == rr.rider_id and trip.auto_accept_verified
                and self.user_for_id(rr.rider_id).id_verified):
            return self.transition_connection(trip.driver_id, conn_obj.id, "accept")
        self.notify(recipient, "connection_received", "New carpool interest",
                    "You have a new pending connection.", related_id=conn_obj.id)
        return conn_obj

    def get_connection(self, connection_id: str) -> Connection:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM connections WHERE id = %s", (connection_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Connection not found", 404)
            return _row_to_connection(row)

    def get_user_connections(self, user_id: str) -> list[Connection]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT c.* FROM connections c
                   JOIN ride_requests rr ON rr.id = c.ride_request_id
                   JOIN driver_trips dt ON dt.id = c.driver_trip_id
                   WHERE rr.rider_id = %s OR dt.driver_id = %s
                   ORDER BY c.updated_at DESC""",
                (user_id, user_id),
            )
            return [_row_to_connection(r) for r in cur.fetchall()]

    def transition_connection(self, user_id: str, connection_id: str, action: str) -> Connection:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        participants = {rr.rider_id, trip.driver_id}
        if user_id not in participants:
            raise DomainError("Only participants can update this connection", 403)

        if action == "accept":
            if connection.status != "pending":
                raise DomainError("Only pending connections can be accepted")
            new_reserved = trip.seats_reserved + rr.passenger_count
            if new_reserved > trip.seats_available:
                raise DomainError("Driver trip does not have enough available seats", 409)
            new_trip_status = "matched" if new_reserved >= trip.seats_available else "open"
            with get_conn() as conn:
                cur = self._cur(conn)
                cur.execute("UPDATE connections SET status = 'accepted', updated_at = %s WHERE id = %s",
                            (now_utc(), connection_id))
                cur.execute("UPDATE ride_requests SET status = 'matched' WHERE id = %s", (rr.id,))
                cur.execute(
                    "UPDATE driver_trips SET seats_reserved = %s, status = %s WHERE id = %s",
                    (new_reserved, new_trip_status, trip.id),
                )
            connection.status = "accepted"
            self.notify(connection.initiator_user_id, "connection_accepted",
                        "Connection accepted", "Your carpool connection was accepted.", related_id=connection.id)
            self.notify(rr.rider_id, "chat_unlocked", "Chat unlocked",
                        "Full chat is available for your accepted connection.", related_id=connection.id)
            self.notify(trip.driver_id, "chat_unlocked", "Chat unlocked",
                        "Full chat is available for your accepted connection.", related_id=connection.id)

        elif action == "decline":
            if connection.status != "pending":
                raise DomainError("Only pending connections can be declined")
            with get_conn() as conn:
                cur = self._cur(conn)
                cur.execute("UPDATE connections SET status = 'declined', updated_at = %s WHERE id = %s",
                            (now_utc(), connection_id))
            connection.status = "declined"

        elif action == "cancel":
            if connection.status == "accepted":
                new_reserved = max(0, trip.seats_reserved - rr.passenger_count)
                with get_conn() as conn:
                    cur = self._cur(conn)
                    cur.execute("UPDATE connections SET status = 'cancelled', updated_at = %s WHERE id = %s",
                                (now_utc(), connection_id))
                    cur.execute(
                        "UPDATE driver_trips SET seats_reserved = %s, status = CASE WHEN status = 'matched' THEN 'open' ELSE status END WHERE id = %s",
                        (new_reserved, trip.id),
                    )
            else:
                with get_conn() as conn:
                    cur = self._cur(conn)
                    cur.execute("UPDATE connections SET status = 'cancelled', updated_at = %s WHERE id = %s",
                                (now_utc(), connection_id))
            connection.status = "cancelled"

        elif action == "complete":
            if connection.status != "accepted":
                raise DomainError("Only accepted connections can be completed")
            confirmed = list(connection.completed_confirmed_by)
            if user_id not in confirmed:
                confirmed.append(user_id)
            with get_conn() as conn:
                cur = self._cur(conn)
                cur.execute(
                    "UPDATE connections SET status = 'completed', completed_confirmed_by = %s, updated_at = %s WHERE id = %s",
                    (confirmed, now_utc(), connection_id),
                )
                cur.execute("UPDATE ride_requests SET status = 'completed' WHERE id = %s", (rr.id,))
                cur.execute("UPDATE driver_trips SET status = 'completed' WHERE id = %s", (trip.id,))
            connection.status = "completed"
            connection.completed_confirmed_by = confirmed
            self._settle_fare(connection, rr, trip)
        else:
            raise DomainError(f"Unsupported connection action: {action}")

        connection.updated_at = now_utc()
        return connection

    def expire_connections(self, today: date) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """UPDATE connections SET status = 'expired', updated_at = %s
                   WHERE status = 'pending'
                   AND (
                       ride_request_id IN (SELECT id FROM ride_requests WHERE target_date < %s)
                       OR driver_trip_id IN (SELECT id FROM driver_trips WHERE target_date < %s)
                   )""",
                (now_utc(), today, today),
            )

    # ─── Messages ─────────────────────────────────────────────────────────────

    def add_message(self, user_id: str, connection_id: str, data: dict[str, Any]) -> Message:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only participants can message", 403)
        if self.is_blocked(rr.rider_id, trip.driver_id):
            raise DomainError("Blocked users cannot message", 403)

        if connection.status == "pending":
            canned_key = data.get("canned_key")
            if canned_key not in PENDING_CANNED_MESSAGES:
                raise DomainError("Pending connections only allow approved canned messages")
            content = PENDING_CANNED_MESSAGES[canned_key]
            kind: Literal["canned", "free_text"] = "canned"
        elif connection.status == "accepted":
            content = str(data.get("content") or "").strip()
            if not content:
                raise DomainError("Message content is required")
            kind = "free_text"
        else:
            raise DomainError("Chat is not available for this connection state")

        msg = Message(
            id=new_id("msg"), connection_id=connection_id,
            sender_id=user_id, content=content, kind=kind, created_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "INSERT INTO messages (id, connection_id, sender_id, content, kind, created_at) VALUES (%s, %s, %s, %s, %s, %s)",
                (msg.id, msg.connection_id, msg.sender_id, msg.content, msg.kind, msg.created_at),
            )
        other_id = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        self.notify(other_id, "chat_message", "New chat message", content, related_id=msg.connection_id)
        return msg

    def get_messages(self, connection_id: str) -> list[Message]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM messages WHERE connection_id = %s ORDER BY created_at ASC",
                (connection_id,),
            )
            return [_row_to_message(r) for r in cur.fetchall()]

    # ─── Gas Split / Fare ─────────────────────────────────────────────────────

    def suggest_gas_split(self, connection_id: str) -> dict[str, Any]:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        pickup = self.get_location(rr.pickup_location_id)
        destination = self.get_location(rr.destination_location_id)
        distance_km = haversine_meters(
            pickup.latitude, pickup.longitude,
            destination.latitude, destination.longitude,
        ) / 1000
        passenger_count = max(1, rr.passenger_count)
        cents = calculate_fare_cents(distance_km, passenger_count)
        return {
            "amount_cents": cents,
            "currency": "USD",
            "assumptions": {
                "distance_km": round(distance_km, 2),
                "passenger_count": passenger_count,
                "gas_price_per_gallon_usd": _GAS_PRICE_PER_GALLON_USD,
                "mpg": _MPG_DEFAULT,
                "method": "haversine_distance",
            },
        }

    def confirm_gas_split(self, user_id: str, connection_id: str, data: dict[str, Any]) -> GasSplitConfirmation:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only participants can confirm a split", 403)
        if connection.status not in {"accepted", "completed"}:
            raise DomainError("Gas split can only be confirmed for accepted or completed connections")

        confirmation = GasSplitConfirmation(
            id=new_id("gsc"), connection_id=connection_id,
            confirmer_id=user_id, amount_cents=int(data["amount_cents"]),
            currency=data.get("currency") or "USD",
            assumptions=data.get("assumptions") or {},
            created_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO gas_split_confirmations (id, connection_id, confirmer_id,
                       amount_cents, currency, assumptions, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (confirmation.id, confirmation.connection_id, confirmation.confirmer_id,
                 confirmation.amount_cents, confirmation.currency,
                 json.dumps(confirmation.assumptions), confirmation.created_at),
            )
        other_id = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        self.notify(other_id, "gas_split_confirmed", "Gas split confirmed",
                    "A participant confirmed the gas split.", related_id=confirmation.connection_id)
        return confirmation

    def connection_fare(self, connection: Connection) -> dict[str, Any]:
        """The automatic fare for a ride: the passenger's share of gas for the
        pickup→destination distance, times their party size. Once the ride is
        completed it reports the settled amount instead of the estimate."""
        settled = self.get_gas_splits(connection.id) if connection.status == "completed" else []
        suggestion = self.suggest_gas_split(connection.id)
        passengers = suggestion["assumptions"]["passenger_count"]
        estimate = suggestion["amount_cents"] * passengers
        if settled:
            return {"amount_cents": settled[-1].amount_cents, "currency": settled[-1].currency,
                    "distance_km": suggestion["assumptions"]["distance_km"], "passengers": passengers,
                    "status": "paid"}
        return {"amount_cents": estimate, "currency": suggestion["currency"],
                "distance_km": suggestion["assumptions"]["distance_km"], "passengers": passengers,
                "status": "estimated"}

    def _settle_fare(self, connection: Connection, rr: RideRequest, trip: DriverTrip) -> None:
        """Record the fare as settled when a ride completes and tell both sides.
        There is no card processor behind this: it marks the fare as paid in-app
        so the passenger and driver see the same confirmation."""
        if self.get_gas_splits(connection.id):
            amount_cents = self.get_gas_splits(connection.id)[-1].amount_cents
        else:
            fare = self.connection_fare(connection)
            amount_cents = fare["amount_cents"]
            with get_conn() as conn:
                self._cur(conn).execute(
                    """INSERT INTO gas_split_confirmations (id, connection_id, confirmer_id,
                           amount_cents, currency, assumptions, created_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (new_id("gsc"), connection.id, rr.rider_id, amount_cents, fare["currency"],
                     json.dumps({"method": "auto_fare", "distance_km": fare["distance_km"],
                                 "passenger_count": fare["passengers"]}), now_utc()),
                )
        amount = f"${amount_cents / 100:.2f}"
        self.notify(rr.rider_id, "payment_processed", "Payment processed",
                    f"Your fare of {amount} has been paid. Thanks for riding!", related_id=connection.id)
        self.notify(trip.driver_id, "payment_processed", "Payment received",
                    f"You received {amount} for this ride.", related_id=connection.id)

    def get_gas_splits(self, connection_id: str) -> list[GasSplitConfirmation]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM gas_split_confirmations WHERE connection_id = %s ORDER BY created_at ASC",
                (connection_id,),
            )
            return [_row_to_gas_split(r) for r in cur.fetchall()]

    # ─── Community Pools ──────────────────────────────────────────────────────

    def create_pool(self, organizer_id: str, data: dict[str, Any]) -> Pool:
        self._validate_location_ids(data["pickup_location_id"], data["destination_location_id"])
        name = str(data.get("name") or "").strip()
        if not name:
            raise DomainError("Pool name is required")
        community_tag = str(data.get("community_tag") or "event").strip()
        max_participants = int(data.get("max_participants") or 10)
        if max_participants < 2:
            raise DomainError("A pool needs at least 2 participants")

        pool = Pool(
            id=new_id("pol"), name=name, organizer_id=organizer_id,
            community_tag=community_tag, trip_date=data["trip_date"],
            departure_time=data["departure_time"],
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            max_participants=max_participants, status="open",
            created_at=now_utc(), description=data.get("description"),
            seats_per_vehicle=int(data.get("seats_per_vehicle") or 4),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO pools (id, name, organizer_id, community_tag, trip_date,
                       departure_time, pickup_location_id, destination_location_id, max_participants,
                       status, created_at, description, seats_per_vehicle)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (pool.id, pool.name, pool.organizer_id, pool.community_tag,
                 pool.trip_date, pool.departure_time, pool.pickup_location_id, pool.destination_location_id,
                 pool.max_participants, pool.status, pool.created_at,
                 pool.description, pool.seats_per_vehicle),
            )
            cur.execute(
                "INSERT INTO pool_memberships (pool_id, user_id, role, joined_at) VALUES (%s, %s, %s, %s)",
                (pool.id, organizer_id, "organizer", now_utc()),
            )
        return pool

    def get_pool(self, pool_id: str) -> Pool:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM pools WHERE id = %s", (pool_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Pool not found", 404)
            return _row_to_pool(row)

    def join_pool(self, user_id: str, pool_id: str, role: str = "passenger") -> PoolMembership:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM pools WHERE id = %s", (pool_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Pool not found", 404)
            pool = _row_to_pool(row)
            if pool.status != "open":
                raise DomainError("Pool is not open for new members")
            cur.execute(
                "SELECT COUNT(*) AS cnt FROM pool_memberships WHERE pool_id = %s", (pool_id,)
            )
            count = cur.fetchone()["cnt"]
            cur.execute(
                "SELECT 1 FROM pool_memberships WHERE pool_id = %s AND user_id = %s",
                (pool_id, user_id),
            )
            if cur.fetchone():
                raise DomainError("Already a member of this pool")
            if count >= pool.max_participants:
                cur.execute("UPDATE pools SET status = 'full' WHERE id = %s", (pool_id,))
                raise DomainError("Pool is full")
            membership = PoolMembership(pool_id=pool_id, user_id=user_id, role=role, joined_at=now_utc())
            cur.execute(
                "INSERT INTO pool_memberships (pool_id, user_id, role, joined_at) VALUES (%s, %s, %s, %s)",
                (membership.pool_id, membership.user_id, membership.role, membership.joined_at),
            )
            if count + 1 >= pool.max_participants:
                cur.execute("UPDATE pools SET status = 'full' WHERE id = %s", (pool_id,))
        self.notify(pool.organizer_id, "pool_joined", "New pool member",
                    f"Someone joined your pool: {pool.name}", related_id=pool_id)
        return membership

    def leave_pool(self, user_id: str, pool_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM pools WHERE id = %s", (pool_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Pool not found", 404)
            pool = _row_to_pool(row)
            cur.execute(
                "DELETE FROM pool_memberships WHERE pool_id = %s AND user_id = %s",
                (pool_id, user_id),
            )
            if cur.rowcount == 0:
                raise DomainError("User is not a member of this pool")
            if pool.status == "full":
                cur.execute("UPDATE pools SET status = 'open' WHERE id = %s", (pool_id,))

    def list_pools(self, community_tag: str | None = None, trip_date: date | None = None) -> list[Pool]:
        with get_conn() as conn:
            cur = self._cur(conn)
            sql = "SELECT * FROM pools WHERE status IN ('open', 'full')"
            params: list[Any] = []
            if community_tag:
                sql += " AND community_tag = %s"
                params.append(community_tag)
            if trip_date:
                sql += " AND trip_date = %s"
                params.append(trip_date)
            sql += " ORDER BY created_at DESC"
            cur.execute(sql, params)
            return [_row_to_pool(r) for r in cur.fetchall()]

    def get_pool_members(self, pool_id: str) -> list[PoolMembership]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM pool_memberships WHERE pool_id = %s ORDER BY joined_at ASC",
                (pool_id,),
            )
            return [_row_to_membership(r) for r in cur.fetchall()]

    def is_pool_member(self, user_id: str, pool_id: str) -> bool:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT 1 FROM pool_memberships WHERE pool_id = %s AND user_id = %s",
                (pool_id, user_id),
            )
            return cur.fetchone() is not None

    def add_pool_message(self, user_id: str, pool_id: str, data: dict[str, Any]) -> PoolMessage:
        if not self.is_pool_member(user_id, pool_id):
            raise DomainError("Only pool members can message", 403)
        content = str(data.get("content") or "").strip()
        if not content:
            raise DomainError("Message content is required")
        msg = PoolMessage(
            id=new_id("pmsg"), pool_id=pool_id, sender_id=user_id,
            content=content, created_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "INSERT INTO pool_messages (id, pool_id, sender_id, content, created_at) VALUES (%s, %s, %s, %s, %s)",
                (msg.id, msg.pool_id, msg.sender_id, msg.content, msg.created_at),
            )
        return msg

    def get_pool_messages(self, user_id: str, pool_id: str) -> list[PoolMessage]:
        if not self.is_pool_member(user_id, pool_id):
            raise DomainError("Only pool members can read messages", 403)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM pool_messages WHERE pool_id = %s ORDER BY created_at ASC",
                (pool_id,),
            )
            return [_row_to_pool_message(r) for r in cur.fetchall()]

    # ─── Driver Location Tracking (Postgres + PostGIS — persists across cold starts) ──

    # Locations older than this are treated as stale and excluded from nearby
    # results, rather than deleted outright, so a driver who briefly drops
    # offline doesn't lose their last-known position for no reason.
    DRIVER_LOCATION_TTL_MINUTES = 5

    def update_driver_location(self, user_id: str, data: dict[str, Any]) -> DriverLocation:
        loc = DriverLocation(
            user_id=user_id,
            latitude=float(data["latitude"]),
            longitude=float(data["longitude"]),
            heading=data.get("heading"),
            speed_kmh=data.get("speed_kmh"),
            updated_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO driver_locations (user_id, geog, heading, speed_kmh, updated_at)
                   VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s, %s, %s)
                   ON CONFLICT (user_id) DO UPDATE
                   SET geog = EXCLUDED.geog, heading = EXCLUDED.heading,
                       speed_kmh = EXCLUDED.speed_kmh, updated_at = EXCLUDED.updated_at""",
                (user_id, loc.longitude, loc.latitude, loc.heading, loc.speed_kmh, loc.updated_at),
            )
        return loc

    def get_nearby_drivers(self, lat: float, lng: float, radius_meters: float = 10000) -> list[dict[str, Any]]:
        stale_before = now_utc() - timedelta(minutes=self.DRIVER_LOCATION_TTL_MINUTES)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT dl.user_id, ST_Y(dl.geog::geometry) AS latitude, ST_X(dl.geog::geometry) AS longitude,
                          dl.heading, dl.speed_kmh, dl.updated_at,
                          ST_Distance(dl.geog, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography) AS distance_meters,
                          p.display_name, v.car_type, v.make, v.model
                   FROM driver_locations dl
                   LEFT JOIN profiles p ON p.user_id = dl.user_id
                   LEFT JOIN vehicles v ON v.user_id = dl.user_id
                   WHERE dl.updated_at > %s
                     AND ST_DWithin(dl.geog, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
                   ORDER BY distance_meters ASC""",
                (lng, lat, stale_before, lng, lat, radius_meters),
            )
            rows = cur.fetchall()

        results = []
        for r in rows:
            vehicle_str = f"{r['make'] or ''} {r['model'] or ''}".strip()
            results.append({
                "user_id": r["user_id"],
                "display_name": r["display_name"] or "Driver",
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "heading": r["heading"],
                "speed_kmh": r["speed_kmh"],
                "distance_meters": round(r["distance_meters"]),
                "car_type": r["car_type"],
                "vehicle": vehicle_str or None,
                "updated_at": r["updated_at"].isoformat(),
            })
        return results

    def suggest_route(self, pickup_lat: float, pickup_lng: float,
                      dest_lat: float, dest_lng: float,
                      passenger_count: int = 1) -> dict[str, Any]:
        distance_km = haversine_meters(pickup_lat, pickup_lng, dest_lat, dest_lng) / 1000
        road_distance_km = round(distance_km * 1.3, 2)
        duration_minutes = round((road_distance_km / 35) * 60)
        fare_cents = calculate_fare_cents(road_distance_km, passenger_count)
        return {
            "distance_km": road_distance_km,
            "straight_line_km": round(distance_km, 2),
            "duration_minutes": duration_minutes,
            "fare_suggestion_cents": fare_cents,
            "fare_assumptions": {
                "gas_price_per_gallon_usd": _GAS_PRICE_PER_GALLON_USD,
                "mpg": _MPG_DEFAULT,
                "passenger_count": passenger_count,
            },
        }

    # ─── Notifications ────────────────────────────────────────────────────────

    def notify(self, user_id: str, type_: str, title: str, body: str, related_id: str | None = None) -> Notification:
        notification = Notification(
            id=new_id("ntf"), user_id=user_id, type=type_,
            title=title, body=body, created_at=now_utc(), related_id=related_id,
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "INSERT INTO notifications (id, user_id, type, title, body, created_at, read, related_id) "
                "VALUES (%s, %s, %s, %s, %s, %s, FALSE, %s)",
                (notification.id, notification.user_id, notification.type,
                 notification.title, notification.body, notification.created_at, notification.related_id),
            )
        return notification

    def get_notifications(self, user_id: str) -> list[Notification]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT * FROM notifications WHERE user_id = %s ORDER BY created_at DESC LIMIT 50",
                (user_id,),
            )
            return [_row_to_notification(r) for r in cur.fetchall()]

    def mark_notifications_read(self, user_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE notifications SET read = TRUE WHERE user_id = %s AND read = FALSE",
                (user_id,),
            )

    def dismiss_notification(self, user_id: str, notification_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "DELETE FROM notifications WHERE id = %s AND user_id = %s",
                (notification_id, user_id),
            )
            if cur.rowcount == 0:
                raise DomainError("Notification not found", 404)

    # ─── Ratings & trust ──────────────────────────────────────────────────────

    def rate_connection(self, user_id: str, connection_id: str, stars: int, comment: str | None) -> dict[str, Any]:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only participants can rate this ride", 403)
        if connection.status != "completed":
            raise DomainError("You can rate a ride once it's completed")
        if not 1 <= stars <= 5:
            raise DomainError("Rating must be 1 to 5 stars")
        ratee = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        rating = {
            "id": new_id("rtg"), "connection_id": connection_id, "rater_id": user_id,
            "ratee_id": ratee, "stars": stars, "comment": (comment or "").strip() or None,
            "created_at": now_utc(),
        }
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO ratings (id, connection_id, rater_id, ratee_id, stars, comment, created_at)
                   VALUES (%(id)s, %(connection_id)s, %(rater_id)s, %(ratee_id)s, %(stars)s, %(comment)s, %(created_at)s)
                   ON CONFLICT (connection_id, rater_id) DO UPDATE
                   SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, created_at = EXCLUDED.created_at""",
                rating,
            )
        return rating

    def my_rating_for(self, user_id: str, connection_id: str) -> int | None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT stars FROM ratings WHERE connection_id = %s AND rater_id = %s",
                        (connection_id, user_id))
            row = cur.fetchone()
            return row["stars"] if row else None

    def user_stats(self, user_id: str) -> dict[str, Any]:
        """Public trust signals: average stars, number of ratings, completed rides
        (as driver or passenger) and the admin-set ID check."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT
                     (SELECT AVG(stars) FROM ratings WHERE ratee_id = %(u)s) AS rating_avg,
                     (SELECT COUNT(*) FROM ratings WHERE ratee_id = %(u)s) AS rating_count,
                     (SELECT COUNT(*) FROM connections c
                        JOIN ride_requests rr ON rr.id = c.ride_request_id
                        JOIN driver_trips dt ON dt.id = c.driver_trip_id
                       WHERE c.status = 'completed' AND (rr.rider_id = %(u)s OR dt.driver_id = %(u)s)) AS completed_trips,
                     (SELECT id_verified FROM users WHERE id = %(u)s) AS id_verified""",
                {"u": user_id},
            )
            r = cur.fetchone()
        avg = r["rating_avg"]
        return {
            "rating_avg": round(float(avg), 1) if avg is not None else None,
            "rating_count": int(r["rating_count"]),
            "completed_trips": int(r["completed_trips"]),
            "id_verified": bool(r["id_verified"]),
        }

    def set_id_verified(self, target_user_id: str, verified: bool) -> User:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE users SET id_verified = %s WHERE id = %s RETURNING *", (verified, target_user_id))
            row = cur.fetchone()
            if not row:
                raise DomainError("User not found", 404)
            return _row_to_user(row)

    # ─── Saved routes ("Your routes") ─────────────────────────────────────────

    def create_saved_route(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        self._validate_location_ids(data["pickup_location_id"], data["destination_location_id"])
        label = (data.get("label") or "").strip()
        if not label:
            raise DomainError("Give the route a name")
        weekdays = sorted(set(data.get("weekdays") or []))
        if any(d not in range(7) for d in weekdays):
            raise DomainError("Weekdays must be 0 (Mon) to 6 (Sun)")
        route = {
            "id": new_id("rte"), "user_id": user_id, "label": label[:60],
            "pickup_location_id": data["pickup_location_id"],
            "destination_location_id": data["destination_location_id"],
            "departure_time": data.get("departure_time"), "weekdays": weekdays, "created_at": now_utc(),
        }
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT COUNT(*) AS n FROM saved_routes WHERE user_id = %s", (user_id,))
            if cur.fetchone()["n"] >= 10:
                raise DomainError("You can save up to 10 routes")
            cur.execute(
                """INSERT INTO saved_routes (id, user_id, label, pickup_location_id, destination_location_id,
                       departure_time, weekdays, created_at)
                   VALUES (%(id)s, %(user_id)s, %(label)s, %(pickup_location_id)s, %(destination_location_id)s,
                           %(departure_time)s, %(weekdays)s, %(created_at)s)""",
                route,
            )
        return route

    def list_saved_routes(self, user_id: str) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM saved_routes WHERE user_id = %s ORDER BY created_at", (user_id,))
            return [dict(r) for r in cur.fetchall()]

    def delete_saved_route(self, user_id: str, route_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("DELETE FROM saved_routes WHERE id = %s AND user_id = %s", (route_id, user_id))
            if cur.rowcount == 0:
                raise DomainError("Route not found", 404)

    # ─── Ride alerts ("Get notified when a ride is posted") ───────────────────

    def create_ride_alert(self, user_id: str, destination_location_id: str, target_date: date,
                          radius_meters: int = 5000) -> dict[str, Any]:
        self.get_location(destination_location_id)
        alert = {
            "id": new_id("alr"), "user_id": user_id, "destination_location_id": destination_location_id,
            "target_date": target_date, "radius_meters": max(500, min(radius_meters, 50_000)),
            "created_at": now_utc(), "fulfilled_at": None,
        }
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO ride_alerts (id, user_id, destination_location_id, target_date, radius_meters, created_at)
                   VALUES (%(id)s, %(user_id)s, %(destination_location_id)s, %(target_date)s, %(radius_meters)s, %(created_at)s)""",
                alert,
            )
        return alert

    def _fulfil_ride_alerts(self, trip: DriverTrip) -> None:
        """Notify passengers waiting on a ride to near this trip's destination that day.
        Each alert fires once."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """UPDATE ride_alerts a SET fulfilled_at = %s
                   FROM locations al, locations td
                   WHERE a.fulfilled_at IS NULL AND a.target_date = %s AND a.user_id <> %s
                     AND al.id = a.destination_location_id AND td.id = %s
                     AND ST_DWithin(al.geog, td.geog, a.radius_meters)
                   RETURNING a.user_id""",
                (now_utc(), trip.target_date, trip.driver_id, trip.destination_location_id),
            )
            user_ids = [r["user_id"] for r in cur.fetchall()]
        for uid in user_ids:
            self.notify(uid, "ride_alert", "A ride you wanted was posted",
                        f"A driver is heading your way on {trip.target_date:%a %b} {trip.target_date.day}.", related_id=trip.id)

    # ─── Trip day ─────────────────────────────────────────────────────────────

    def trip_day_status(self, user_id: str, connection_id: str) -> dict[str, Any]:
        """Live pickup status for an accepted ride: the driver's last shared
        position (if fresh), straight-line distance to the passenger's pickup and a
        rough ETA. Participants only."""
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only participants can see trip status", 403)
        if connection.status != "accepted":
            raise DomainError("Live status is only available for accepted rides")
        pickup = self.get_location(rr.pickup_location_id)
        destination = self.get_location(rr.destination_location_id)
        stale_before = now_utc() - timedelta(minutes=self.DRIVER_LOCATION_TTL_MINUTES)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, speed_kmh, updated_at
                   FROM driver_locations WHERE user_id = %s AND updated_at > %s""",
                (trip.driver_id, stale_before),
            )
            loc = cur.fetchone()
        driver: dict[str, Any] | None = None
        if loc:
            meters = haversine_meters(loc["lat"], loc["lng"], pickup.latitude, pickup.longitude)
            speed = loc["speed_kmh"] if loc["speed_kmh"] and loc["speed_kmh"] > 5 else 30.0
            driver = {
                "latitude": loc["lat"], "longitude": loc["lng"], "updated_at": loc["updated_at"],
                "distance_to_pickup_m": round(meters),
                # Straight line × 1.3 road factor at current (or city) speed.
                "eta_minutes": max(0, round(meters * 1.3 / 1000 / speed * 60)),
            }
        return {
            "connection_id": connection_id,
            "pickup": {"label": pickup.label, "latitude": pickup.latitude, "longitude": pickup.longitude},
            "destination": {"label": destination.label, "latitude": destination.latitude, "longitude": destination.longitude},
            "departure_time": trip.departure_time,
            "driver": driver,
            "rider_at_pickup_at": connection.rider_at_pickup_at,
            "picked_up_at": connection.picked_up_at,
        }

    def mark_picked_up(self, user_id: str, connection_id: str) -> Connection:
        """Driver confirms the passenger is in the car; the ride is now en route."""
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id != trip.driver_id:
            raise DomainError("Only the driver can confirm the pickup", 403)
        if connection.status != "accepted":
            raise DomainError("Only accepted rides can be picked up")
        if connection.picked_up_at is None:
            at = now_utc()
            with get_conn() as conn:
                self._cur(conn).execute("UPDATE connections SET picked_up_at = %s WHERE id = %s", (at, connection_id))
            connection.picked_up_at = at
            self.notify(rr.rider_id, "ride_started", "Your ride has started",
                        "You're on your way to the destination.", related_id=connection_id)
        return connection

    def mark_rider_at_pickup(self, user_id: str, connection_id: str) -> Connection:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id != rr.rider_id:
            raise DomainError("Only the passenger can check in at the pickup", 403)
        if connection.status != "accepted":
            raise DomainError("Only accepted rides have a pickup")
        at = now_utc()
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE connections SET rider_at_pickup_at = %s WHERE id = %s", (at, connection_id))
        connection.rider_at_pickup_at = at
        passenger = self.get_profile(rr.rider_id)
        self.notify(trip.driver_id, "rider_at_pickup", "Your passenger is at the pickup",
                    f"{passenger.display_name if passenger else 'Your passenger'} is waiting at the pickup spot.",
                    related_id=connection_id)
        return connection

    # ─── Blocks / Reports ─────────────────────────────────────────────────────

    def block_user(self, blocker_id: str, blocked_id: str) -> None:
        if blocker_id == blocked_id:
            raise DomainError("Users cannot block themselves")
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "INSERT INTO blocks (blocker_id, blocked_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (blocker_id, blocked_id),
            )

    def report_user(self, reporter_id: str, reported_user_id: str, reason: str) -> Report:
        if reporter_id == reported_user_id:
            raise DomainError("Users cannot report themselves")
        report = Report(
            id=new_id("rpt"), reporter_id=reporter_id,
            reported_user_id=reported_user_id, reason=reason, created_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "INSERT INTO reports (id, reporter_id, reported_user_id, reason, created_at) VALUES (%s, %s, %s, %s, %s)",
                (report.id, report.reporter_id, report.reported_user_id,
                 report.reason, report.created_at),
            )
        return report

    def is_blocked(self, user_a: str, user_b: str) -> bool:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "SELECT 1 FROM blocks WHERE (blocker_id = %s AND blocked_id = %s) OR (blocker_id = %s AND blocked_id = %s)",
                (user_a, user_b, user_b, user_a),
            )
            return cur.fetchone() is not None

    # ─── Admin ────────────────────────────────────────────────────────────────

    def _user_filter_clause(self, search: str | None, status: str | None) -> tuple[str, list[Any]]:
        conditions = []
        params: list[Any] = []
        if search:
            conditions.append("(u.email ILIKE %s OR p.display_name ILIKE %s)")
            pattern = f"%{search}%"
            params.extend([pattern, pattern])
        if status:
            conditions.append("u.status = %s")
            params.append(status)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        return where, params

    def list_users(self, search: str | None = None, status: str | None = None,
                    limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        where, params = self._user_filter_clause(search, status)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"""SELECT u.id, u.email, u.email_domain, u.created_at, u.status,
                           u.suspended_at, u.suspended_reason, u.id_verified,
                           p.display_name, p.photo_url,
                           EXISTS(SELECT 1 FROM driver_trips dt WHERE dt.driver_id = u.id) AS is_driver,
                           EXISTS(SELECT 1 FROM ride_requests rr WHERE rr.rider_id = u.id) AS is_rider,
                           (SELECT COUNT(*) FROM reports r WHERE r.reported_user_id = u.id AND r.status = 'open') AS open_report_count
                    FROM users u
                    LEFT JOIN profiles p ON p.user_id = u.id
                    {where}
                    ORDER BY u.created_at DESC
                    LIMIT %s OFFSET %s""",
                (*params, limit, offset),
            )
            return [dict(r) for r in cur.fetchall()]

    def count_users(self, search: str | None = None, status: str | None = None) -> int:
        where, params = self._user_filter_clause(search, status)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"SELECT COUNT(*) AS c FROM users u LEFT JOIN profiles p ON p.user_id = u.id {where}",
                params,
            )
            return cur.fetchone()["c"]

    def suspend_user(self, admin_id: str, target_user_id: str, reason: str | None = None) -> User:
        if admin_id == target_user_id:
            raise DomainError("Admins cannot suspend their own account")
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE users SET status = 'suspended', suspended_at = %s, suspended_reason = %s WHERE id = %s",
                (now_utc(), reason, target_user_id),
            )
            if cur.rowcount == 0:
                raise DomainError("User not found", 404)
            cur.execute("SELECT * FROM users WHERE id = %s", (target_user_id,))
            return _row_to_user(cur.fetchone())

    def unsuspend_user(self, target_user_id: str) -> User:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE users SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = %s",
                (target_user_id,),
            )
            if cur.rowcount == 0:
                raise DomainError("User not found", 404)
            cur.execute("SELECT * FROM users WHERE id = %s", (target_user_id,))
            return _row_to_user(cur.fetchone())

    def get_admin_stats(self) -> dict[str, Any]:
        with get_conn() as conn:
            cur = self._cur(conn)

            def count(sql: str, params: tuple[Any, ...] = ()) -> int:
                cur.execute(sql, params)
                return cur.fetchone()["c"]

            return {
                "total_users": count("SELECT COUNT(*) AS c FROM users"),
                "new_users_7d": count("SELECT COUNT(*) AS c FROM users WHERE created_at >= %s", (now_utc() - timedelta(days=7),)),
                "suspended_users": count("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'"),
                "total_drivers": count("SELECT COUNT(DISTINCT driver_id) AS c FROM driver_trips"),
                "total_riders": count("SELECT COUNT(DISTINCT rider_id) AS c FROM ride_requests"),
                "active_drivers": count("SELECT COUNT(DISTINCT driver_id) AS c FROM driver_trips WHERE status IN ('open', 'matched')"),
                "active_riders": count("SELECT COUNT(DISTINCT rider_id) AS c FROM ride_requests WHERE status IN ('open', 'matched')"),
                "completed_rides": count("SELECT COUNT(*) AS c FROM connections WHERE status = 'completed'"),
                "open_reports": count("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'"),
            }

    def list_reports(self, status: str | None = None, limit: int = 100) -> list[Report]:
        with get_conn() as conn:
            cur = self._cur(conn)
            if status:
                cur.execute("SELECT * FROM reports WHERE status = %s ORDER BY created_at DESC LIMIT %s", (status, limit))
            else:
                cur.execute("SELECT * FROM reports ORDER BY created_at DESC LIMIT %s", (limit,))
            return [_row_to_report(r) for r in cur.fetchall()]

    def _set_report_status(self, report_id: str, status: str) -> Report:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE reports SET status = %s WHERE id = %s", (status, report_id))
            if cur.rowcount == 0:
                raise DomainError("Report not found", 404)
            cur.execute("SELECT * FROM reports WHERE id = %s", (report_id,))
            return _row_to_report(cur.fetchone())

    def dismiss_report(self, report_id: str) -> Report:
        return self._set_report_status(report_id, "dismissed")

    def mark_report_actioned(self, report_id: str) -> Report:
        return self._set_report_status(report_id, "actioned")

    def list_active_driver_trips(self, limit: int = 200) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT dt.id, dt.driver_id, dt.target_date, dt.seats_available, dt.seats_reserved,
                          dt.status, dt.created_at, p.display_name AS driver_name,
                          pu.label AS pickup_label, du.label AS destination_label
                   FROM driver_trips dt
                   LEFT JOIN profiles p ON p.user_id = dt.driver_id
                   LEFT JOIN locations pu ON pu.id = dt.pickup_location_id
                   LEFT JOIN locations du ON du.id = dt.destination_location_id
                   WHERE dt.status IN ('open', 'matched')
                   ORDER BY dt.created_at DESC LIMIT %s""",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]

    def list_active_ride_requests(self, limit: int = 200) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT rr.id, rr.rider_id, rr.target_date, rr.passenger_count,
                          rr.status, rr.created_at, p.display_name AS rider_name,
                          pu.label AS pickup_label, du.label AS destination_label
                   FROM ride_requests rr
                   LEFT JOIN profiles p ON p.user_id = rr.rider_id
                   LEFT JOIN locations pu ON pu.id = rr.pickup_location_id
                   LEFT JOIN locations du ON du.id = rr.destination_location_id
                   WHERE rr.status IN ('open', 'matched')
                   ORDER BY rr.created_at DESC LIMIT %s""",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]

    def admin_remove_ride_request(self, request_id: str) -> RideRequest:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE ride_requests SET status = 'cancelled' WHERE id = %s", (request_id,))
            if cur.rowcount == 0:
                raise DomainError("Ride request not found", 404)
            cur.execute("SELECT * FROM ride_requests WHERE id = %s", (request_id,))
            return _row_to_ride_request(cur.fetchone())

    def admin_remove_driver_trip(self, trip_id: str) -> DriverTrip:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE driver_trips SET status = 'cancelled' WHERE id = %s", (trip_id,))
            if cur.rowcount == 0:
                raise DomainError("Driver trip not found", 404)
            cur.execute("SELECT * FROM driver_trips WHERE id = %s", (trip_id,))
            return _row_to_driver_trip(cur.fetchone())

    def popular_destinations(self, limit: int = 10) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT l.label, COUNT(*) AS trip_count
                   FROM (
                       SELECT destination_location_id FROM ride_requests
                       UNION ALL
                       SELECT destination_location_id FROM driver_trips
                   ) dest
                   JOIN locations l ON l.id = dest.destination_location_id
                   GROUP BY l.label
                   ORDER BY trip_count DESC
                   LIMIT %s""",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]

    def log_audit(self, event_type: str, actor_user_id: str | None, actor_email: str | None,
                   ip_address: str | None, detail: dict[str, Any] | None = None) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO audit_logs (id, event_type, actor_user_id, actor_email, ip_address, detail, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (new_id("log"), event_type, actor_user_id, actor_email, ip_address,
                 json.dumps(detail or {}), now_utc()),
            )

    def list_audit_logs(self, event_type: str | None = None, actor_email: str | None = None,
                         date_from: datetime | None = None, date_to: datetime | None = None,
                         limit: int = 200) -> list[AuditLogEntry]:
        conditions = []
        params: list[Any] = []
        if event_type:
            conditions.append("event_type = %s")
            params.append(event_type)
        if actor_email:
            conditions.append("actor_email ILIKE %s")
            params.append(f"%{actor_email}%")
        if date_from:
            conditions.append("created_at >= %s")
            params.append(date_from)
        if date_to:
            conditions.append("created_at <= %s")
            params.append(date_to)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"SELECT * FROM audit_logs {where} ORDER BY created_at DESC LIMIT %s",
                (*params, limit),
            )
            return [_row_to_audit_log(r) for r in cur.fetchall()]

    # ─── Views ────────────────────────────────────────────────────────────────

    def location_view(self, location_id: str, exact: bool) -> dict[str, Any]:
        loc = self.get_location(location_id)
        base: dict[str, Any] = {"id": loc.id, "label": loc.label if exact else loc.approximate_label, "exact": exact, "general": loc.is_general}
        if exact:
            base.update({"latitude": loc.latitude, "longitude": loc.longitude})
        return base

    # ─── Private helpers ──────────────────────────────────────────────────────

    def _validate_location_ids(self, pickup_id: str, destination_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT id FROM locations WHERE id = ANY(%s)", ([pickup_id, destination_id],))
            found = {r["id"] for r in cur.fetchall()}
        if pickup_id not in found or destination_id not in found:
            raise DomainError("Pickup and destination locations are required")

    def _validate_tags(self, tags: list[str]) -> list[str]:
        invalid = set(tags) - ALLOWED_TAGS
        if invalid:
            raise DomainError(f"Unsupported tags: {', '.join(sorted(invalid))}")
        return sorted(set(tags))

    def _listing_matches_query(self, listing: RideRequest | DriverTrip, query: dict[str, Any]) -> bool:
        # Destination/pickup radius filtering happens in SQL via ST_DWithin
        # (see _geo_search_clauses) before rows ever reach this method.
        if query.get("target_date") and listing.target_date != query["target_date"]:
            return False
        if query.get("tag") and query["tag"] not in listing.tags:
            return False
        if query.get("car_type"):
            if isinstance(listing, DriverTrip) and listing.car_type and listing.car_type != query["car_type"]:
                return False
        if query.get("luggage_size"):
            luggage_order = ["none", "small", "medium", "large", "oversized"]
            if isinstance(listing, DriverTrip):
                needed = luggage_order.index(query["luggage_size"])
                capacity = luggage_order.index(listing.luggage_capacity)
                if capacity < needed:
                    return False
        return True
