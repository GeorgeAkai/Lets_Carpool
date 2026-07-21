from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from math import asin, cos, radians, sin, sqrt
from typing import Any, Literal
from uuid import uuid4

import psycopg2.extras

from backend.app.db import get_conn, init_pool, run_migrations


ListingStatus = Literal["open", "expired", "matched", "cancelled", "completed"]
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

PENDING_CANNED_MESSAGES = {
    "timing": "Can we coordinate the exact timing?",
    "pickup": "Can we confirm the pickup area?",
    "luggage": "I have a luggage question.",
}


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


@dataclass
class Profile:
    user_id: str
    display_name: str
    photo_url: str | None = None
    bio: str | None = None
    photo_verified: bool = False


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


@dataclass
class Report:
    id: str
    reporter_id: str
    reported_user_id: str
    reason: str
    created_at: datetime


@dataclass
class Pool:
    id: str
    name: str
    organizer_id: str
    community_tag: str
    trip_date: date
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
        created_at=r["created_at"],
    )

def _row_to_profile(r: dict) -> Profile:
    return Profile(
        user_id=r["user_id"], display_name=r["display_name"],
        photo_url=r["photo_url"], bio=r["bio"],
        photo_verified=r["photo_verified"],
    )

def _row_to_vehicle(r: dict) -> Vehicle:
    return Vehicle(
        user_id=r["user_id"], make=r["make"], model=r["model"],
        color=r["color"], seats=r["seats"], car_type=r["car_type"],
        has_license=r["has_license"], has_insurance=r["has_insurance"],
        has_good_driving_record=r["has_good_driving_record"],
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
    )

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
    )

def _row_to_connection(r: dict) -> Connection:
    return Connection(
        id=r["id"], ride_request_id=r["ride_request_id"],
        driver_trip_id=r["driver_trip_id"],
        initiator_user_id=r["initiator_user_id"],
        status=r["status"], created_at=r["created_at"],
        updated_at=r["updated_at"],
        completed_confirmed_by=list(r["completed_confirmed_by"] or []),
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
        read=r["read"],
    )

def _row_to_pool(r: dict) -> Pool:
    return Pool(
        id=r["id"], name=r["name"], organizer_id=r["organizer_id"],
        community_tag=r["community_tag"], trip_date=r["trip_date"],
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


# ─── Store ────────────────────────────────────────────────────────────────────

class Store:
    def __init__(self, database_url: str) -> None:
        run_migrations(database_url)
        init_pool(database_url)
        # driver_locations stay in-memory — they're ephemeral live GPS data
        self.driver_locations: dict[str, DriverLocation] = {}

    def _cur(self, conn):
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ─── Auth ─────────────────────────────────────────────────────────────────

    def authenticate_email(self, email: str, display_name: str) -> User:
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
                return _row_to_user(row)

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
            return _row_to_user(cur.fetchone())

    def user_for_id(self, user_id: str) -> User:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Invalid or expired token", 401)
            return _row_to_user(row)

    # ─── Profile ──────────────────────────────────────────────────────────────

    def update_profile(self, user_id: str, display_name: str, photo_url: str | None, bio: str | None) -> Profile:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO profiles (user_id, display_name, photo_url, bio)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (user_id) DO UPDATE
                   SET display_name = EXCLUDED.display_name,
                       photo_url    = EXCLUDED.photo_url,
                       bio          = EXCLUDED.bio""",
                (user_id, display_name, photo_url, bio),
            )
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
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM vehicles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            v = _row_to_vehicle(row) if row else Vehicle(user_id=user_id)
            for f in ("make", "model", "color", "seats", "car_type",
                      "has_license", "has_insurance", "has_good_driving_record"):
                if f in data and data[f] is not None:
                    setattr(v, f, data[f])
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
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO locations (id, label, latitude, longitude, provider,
                       provider_place_id, metadata, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (loc.id, loc.label, loc.latitude, loc.longitude, loc.provider,
                 loc.provider_place_id, json.dumps(loc.metadata), loc.created_at),
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

        rr = RideRequest(
            id=new_id("rrq"), rider_id=rider_id,
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            target_date=data["target_date"], flexibility=data["flexibility"],
            passenger_count=passenger_count, tags=tags,
            status="open", created_at=now_utc(),
            luggage_size=luggage_size, preferred_car_type=preferred_car_type,
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO ride_requests (id, rider_id, pickup_location_id,
                       destination_location_id, target_date, flexibility,
                       passenger_count, tags, status, created_at, luggage_size,
                       preferred_car_type)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (rr.id, rr.rider_id, rr.pickup_location_id,
                 rr.destination_location_id, rr.target_date, rr.flexibility,
                 rr.passenger_count, rr.tags, rr.status, rr.created_at,
                 rr.luggage_size, rr.preferred_car_type),
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
                raise DomainError("Only the rider can cancel this request", 403)
            cur.execute("UPDATE ride_requests SET status = 'cancelled' WHERE id = %s", (request_id,))
            rr.status = "cancelled"
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

        trip = DriverTrip(
            id=new_id("trp"), driver_id=driver_id,
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            target_date=data["target_date"], flexibility=data["flexibility"],
            seats_available=seats_available, seats_reserved=0,
            tags=tags, status="open", created_at=now_utc(),
            luggage_capacity=luggage_capacity, car_type=car_type,
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO driver_trips (id, driver_id, pickup_location_id,
                       destination_location_id, target_date, flexibility,
                       seats_available, seats_reserved, tags, status, created_at,
                       luggage_capacity, car_type)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (trip.id, trip.driver_id, trip.pickup_location_id,
                 trip.destination_location_id, trip.target_date, trip.flexibility,
                 trip.seats_available, trip.seats_reserved, trip.tags,
                 trip.status, trip.created_at, trip.luggage_capacity, trip.car_type),
            )
        return trip

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
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE ride_requests SET status = 'expired' WHERE status = 'open' AND target_date < %s",
                (today,),
            )
            cur.execute(
                "UPDATE driver_trips SET status = 'expired' WHERE status = 'open' AND target_date < %s",
                (today,),
            )

    # ─── Search ───────────────────────────────────────────────────────────────

    def search_driver_trips(self, user_id: str, query: dict[str, Any]) -> list[DriverTrip]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT dt.* FROM driver_trips dt
                   WHERE dt.status IN ('open', 'matched')
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = dt.driver_id)
                          OR (blocker_id = dt.driver_id AND blocked_id = %s)
                   )
                   ORDER BY dt.created_at DESC""",
                (user_id, user_id),
            )
            trips = [_row_to_driver_trip(r) for r in cur.fetchall()]

        return [t for t in trips if self._listing_matches_query(t, query)]

    def search_ride_requests(self, user_id: str, query: dict[str, Any]) -> list[RideRequest]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT rr.* FROM ride_requests rr
                   WHERE rr.status IN ('open', 'matched')
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = rr.rider_id)
                          OR (blocker_id = rr.rider_id AND blocked_id = %s)
                   )
                   ORDER BY rr.created_at DESC""",
                (user_id, user_id),
            )
            requests = [_row_to_ride_request(r) for r in cur.fetchall()]

        return [r for r in requests if self._listing_matches_query(r, query)]

    # ─── Connections ──────────────────────────────────────────────────────────

    def create_connection(self, user_id: str, data: dict[str, Any]) -> Connection:
        rr = self.get_ride_request(data["ride_request_id"])
        trip = self.get_driver_trip(data["driver_trip_id"])
        if rr.status != "open" or trip.status != "open":
            raise DomainError("Connections require open listings")
        if rr.rider_id == trip.driver_id:
            raise DomainError("Cannot connect to your own listing", 400)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only the rider or driver can initiate this connection", 403)
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
        self.notify(recipient, "connection_received", "New carpool interest",
                    "You have a new pending connection.")
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
                        "Connection accepted", "Your carpool connection was accepted.")
            self.notify(rr.rider_id, "chat_unlocked", "Chat unlocked",
                        "Full chat is available for your accepted connection.")
            self.notify(trip.driver_id, "chat_unlocked", "Chat unlocked",
                        "Full chat is available for your accepted connection.")

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
        self.notify(other_id, "chat_message", "New chat message", content)
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
                    "A participant confirmed the gas split.")
        return confirmation

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
                       pickup_location_id, destination_location_id, max_participants,
                       status, created_at, description, seats_per_vehicle)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (pool.id, pool.name, pool.organizer_id, pool.community_tag,
                 pool.trip_date, pool.pickup_location_id, pool.destination_location_id,
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
                    f"Someone joined your pool: {pool.name}")
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

    # ─── Driver Location Tracking (in-memory — ephemeral live GPS) ────────────

    def update_driver_location(self, user_id: str, data: dict[str, Any]) -> DriverLocation:
        loc = DriverLocation(
            user_id=user_id,
            latitude=float(data["latitude"]),
            longitude=float(data["longitude"]),
            heading=data.get("heading"),
            speed_kmh=data.get("speed_kmh"),
            updated_at=now_utc(),
        )
        self.driver_locations[user_id] = loc
        return loc

    def get_nearby_drivers(self, lat: float, lng: float, radius_meters: float = 10000) -> list[dict[str, Any]]:
        results = []
        for user_id, loc in self.driver_locations.items():
            dist = haversine_meters(lat, lng, loc.latitude, loc.longitude)
            if dist <= radius_meters:
                profile = self.get_profile(user_id)
                vehicle = self.get_vehicle(user_id)
                results.append({
                    "user_id": user_id,
                    "display_name": profile.display_name if profile else "Driver",
                    "latitude": loc.latitude,
                    "longitude": loc.longitude,
                    "heading": loc.heading,
                    "speed_kmh": loc.speed_kmh,
                    "distance_meters": round(dist),
                    "car_type": vehicle.car_type if vehicle else None,
                    "vehicle": f"{vehicle.make or ''} {vehicle.model or ''}".strip() if vehicle else None,
                    "updated_at": loc.updated_at.isoformat(),
                })
        results.sort(key=lambda r: r["distance_meters"])
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

    def notify(self, user_id: str, type_: str, title: str, body: str) -> Notification:
        notification = Notification(
            id=new_id("ntf"), user_id=user_id, type=type_,
            title=title, body=body, created_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "INSERT INTO notifications (id, user_id, type, title, body, created_at, read) VALUES (%s, %s, %s, %s, %s, %s, FALSE)",
                (notification.id, notification.user_id, notification.type,
                 notification.title, notification.body, notification.created_at),
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

    # ─── Views ────────────────────────────────────────────────────────────────

    def location_view(self, location_id: str, exact: bool) -> dict[str, Any]:
        loc = self.get_location(location_id)
        base: dict[str, Any] = {"id": loc.id, "label": loc.label if exact else loc.approximate_label, "exact": exact}
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
        destination = self.get_location(listing.destination_location_id)
        pickup = self.get_location(listing.pickup_location_id)
        if query.get("destination_latitude") is not None:
            dist = haversine_meters(
                destination.latitude, destination.longitude,
                query["destination_latitude"], query["destination_longitude"],
            )
            if dist > query.get("destination_radius_meters", 1000):
                return False
        if query.get("pickup_latitude") is not None:
            dist = haversine_meters(
                pickup.latitude, pickup.longitude,
                query["pickup_latitude"], query["pickup_longitude"],
            )
            if dist > query.get("pickup_radius_meters", 5000):
                return False
        return True
