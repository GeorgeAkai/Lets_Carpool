from __future__ import annotations

import json
import re
import secrets
import threading
from collections.abc import Iterable, Iterator
from time import monotonic
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
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
# "Ride vibe" chips: riders rank by them, drivers advertise them on their trips.
ALLOWED_VIBES: set[str] = {"quiet", "music_ok", "chatty", "pets_ok", "room_for_bags", "no_smoking"}
# Quick feedback chips on the rating screen.
ALLOWED_RATING_TAGS: set[str] = {"on_time", "safe_driving", "clean_car", "great_chat", "friendly", "easy_pickup"}
# How people settle the gas split outside the app.
ALLOWED_SETTLEMENT_METHODS: set[str] = {"cash", "venmo", "zelle", "paypal", "cash_app", "other"}
ALLOWED_GENDERS: set[str] = {"woman", "man", "nonbinary"}
ALLOWED_REPORT_CATEGORIES: set[str] = {"safety", "driving", "no_show", "payment", "conduct", "other"}
ALLOWED_SHARE_MODES: set[str] = {"every_trip", "night_only", "off"}
# "Max walk to pickup" → search radius, at an unhurried walking pace.
WALK_METERS_PER_MINUTE = 80
MAX_EMERGENCY_CONTACTS = 5
MAX_SAVED_PLACES = 10

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
# Pair-matching: stored candidates per listing, and how many of the newest get a
# routed detour at write time.
MAX_CANDIDATES_PER_LISTING = 50
CANDIDATE_DETOUR_LIMIT = 20
# Two listings that both give an exact departure time are not proposed to each
# other when those times are further apart than this.
MAX_TIME_GAP_MINUTES = 180
# Best matches pushed to the other side when a listing is published.
MAX_MATCH_NOTIFICATIONS = 3
# A passenger may have this many requests out at once; the first accept cancels the rest.
MAX_PENDING_REQUESTS_PER_RIDE = 3
# Replies needed before "usually replies in N min" is shown for someone.
MIN_REPLIES_FOR_STAT = 3
# A recipient who hasn't answered gets one nudge after this long, and the request
# lapses (the sender is pointed at the next-best match) after the TTL.
PENDING_REMINDER_AFTER = timedelta(minutes=30)
# How long before the departure time a driver may tap "Start trip".
START_TRIP_EARLY = timedelta(minutes=60)
PENDING_TTL = timedelta(hours=24)
# Most listings one search returns (newest first); callers may ask for fewer.
SEARCH_LIMIT = 100

_POINT_GEOM_SQL = "ST_SetSRID(ST_MakePoint(%s, %s), 4326)"
_POINT_SQL = f"{_POINT_GEOM_SQL}::geography"
_LUGGAGE_ORDER_SQL = "ARRAY['none','small','medium','large','oversized']"


def _within_area_aware(geog: str, is_general: str, lng: float, lat: float,
                      area_m: float, radius_m: float) -> tuple[str, list[Any]]:
    """ST_DWithin against a point where a "general area" location (a whole
    city) gets a wider radius than a street address. Each branch carries a
    constant radius, unlike CASE WHEN is_general THEN a ELSE b END as the
    distance argument, which the planner can't use a GiST index for."""
    sql = (f"(({is_general} AND ST_DWithin({geog}, {_POINT_SQL}, %s)) "
           f"OR (NOT {is_general} AND ST_DWithin({geog}, {_POINT_SQL}, %s)))")
    return sql, [lng, lat, area_m, lng, lat, radius_m]


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


_PUBLIC_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
    "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com",
}


def _is_public_email_domain(domain: str) -> bool:
    """Two Gmail users aren't coworkers: only a shared work/school domain counts."""
    return domain.lower() in _PUBLIC_EMAIL_DOMAINS


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
    onboarded_at: datetime | None = None


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
    gender: str | None = None


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
    # Minutes between this request's and the trip's exact departure times, when both set.
    time_gap_minutes: int | None = None


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
    vibes: list[str] = field(default_factory=list)
    # Minutes added to this trip if the searching passenger is picked up. Only set
    # on corridor-search results (needs the passenger's pickup + destination).
    detour_minutes: float | None = None
    # Minutes between the searching passenger's exact departure time and this trip's.
    time_gap_minutes: int | None = None
    # Search-only, relative to the searching rider's preferences.
    is_coworker: bool | None = None
    is_buddy: bool | None = None
    shared_vibes: list[str] | None = None


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
    responded_at: datetime | None = None
    completed_at: datetime | None = None
    # Read out by the rider, entered by the driver; never shown to the driver.
    ride_pin: str | None = None
    pin_verified_at: datetime | None = None
    picked_up_at: datetime | None = None
    driver_started_at: datetime | None = None


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
    connection_id: str | None = None
    category: str = "other"


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
        onboarded_at=r.get("onboarded_at"),
    )

def _row_to_report(r: dict) -> Report:
    return Report(
        id=r["id"], reporter_id=r["reporter_id"], reported_user_id=r["reported_user_id"],
        reason=r["reason"], created_at=r["created_at"], status=r.get("status", "open"),
        connection_id=r.get("connection_id"), category=r.get("category") or "other",
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
        phone=r.get("phone"), gender=r.get("gender"),
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

def _time_gap_minutes(trip: DriverTrip, rr: RideRequest) -> int | None:
    """How far apart the two exact departure times are; None unless both gave one."""
    if trip.departure_time is None or rr.departure_time is None:
        return None
    a = datetime.combine(trip.target_date, trip.departure_time)
    b = datetime.combine(rr.target_date, rr.departure_time)
    return round(abs((a - b).total_seconds()) / 60)


def _proposal_score(detour_minutes: float | None, trip: DriverTrip, rr: RideRequest) -> float:
    """0..1: 70% detour (0 min = 1, 15+ min or unknown = 0), 30% date and
    timing closeness. Timing is the gap between exact departure times when both
    listings have one (0 min = 1, 2 h+ = 0), otherwise how well the loose
    flexibility labels agree. Mirrors the frontend's Best Matches weighting minus
    the profile-based terms, which a proposal doesn't have."""
    detour = 0.0 if detour_minutes is None else max(0.0, 1 - detour_minutes / 15)
    days = abs((trip.target_date - rr.target_date).days)
    date_score = 1.0 if days == 0 else 0.7
    gap = _time_gap_minutes(trip, rr)
    if gap is not None:
        flex_score = max(0.0, 1 - gap / 120)
    elif trip.flexibility == rr.flexibility:
        flex_score = 1.0
    elif "flexible" in (trip.flexibility, rr.flexibility):
        flex_score = 0.6
    else:
        flex_score = 0.2
    return 0.7 * detour + 0.3 * (0.6 * date_score + 0.4 * flex_score)


# Every driver_trips column except route_geog. The stored route is only used
# inside SQL (corridor search); selecting it would ship the whole OSRM line
# (tens of KB per trip) to the app on every read, which is most of our
# database egress.
_TRIP_COLUMNS = (
    "id", "driver_id", "pickup_location_id", "destination_location_id", "target_date",
    "flexibility", "seats_available", "seats_reserved", "tags", "status", "created_at",
    "luggage_capacity", "car_type", "notes", "route_distance_m", "route_duration_s",
    "departure_time", "price_per_seat_cents", "auto_accept_verified", "series_id", "vibes",
)


def _trip_columns(alias: str = "") -> str:
    prefix = f"{alias}." if alias else ""
    return ", ".join(prefix + c for c in _TRIP_COLUMNS)


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
        vibes=list(r.get("vibes") or []),
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
        responded_at=r.get("responded_at"), completed_at=r.get("completed_at"),
        ride_pin=r.get("ride_pin"), pin_verified_at=r.get("pin_verified_at"),
        picked_up_at=r.get("picked_up_at"),
        driver_started_at=r.get("driver_started_at"),
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

def _receipt_view(r: dict) -> dict[str, Any]:
    data = dict(r)
    data["receipt_number"] = f"CP-{int(r['receipt_number']):05d}"
    return data


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
        # user_id -> (expires_at, stats). Stats ride along on every listing and
        # profile in every response, so recomputing them per row per poll was
        # a large share of database round trips. Per process and short-lived,
        # so other instances catch up within the TTL.
        self._stats_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def _cur(self, conn):
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ─── Read scope ───────────────────────────────────────────────────────────
    # Serializing a list (search results, my connections) looks up the same
    # locations, profiles, vehicles and stats again and again. Inside read_scope
    # those by-id getters are answered from a per-thread memo that prefetch()
    # fills with one query per table, and everything shares one pooled connection.
    # Only open a scope once the writes for the request are done: the memo is
    # never invalidated, and it hands out shared objects.

    _scope = threading.local()

    @contextmanager
    def read_scope(
        self, *, connections: Iterable[Connection] = (), requests: Iterable[RideRequest] = (),
        trips: Iterable[DriverTrip] = (), viewer_id: str | None = None,
    ) -> Iterator[None]:
        if getattr(self._scope, "memo", None) is not None:
            yield  # nested: the outer scope's memo and connection already apply
            return
        with get_conn():
            self._scope.memo = {}
            try:
                self.prefetch(connections=list(connections), requests=list(requests),
                              trips=list(trips), viewer_id=viewer_id)
                yield
            finally:
                self._scope.memo = None

    def _memo_get(self, kind: str, key: str) -> Any:
        memo = getattr(self._scope, "memo", None)
        return None if memo is None else memo.get((kind, key))

    def _memo_put(self, kind: str, key: str, value: Any) -> Any:
        memo = getattr(self._scope, "memo", None)
        if memo is not None and value is not None:
            memo[(kind, key)] = value
        return value

    def prefetch(
        self, *, connections: list[Connection], requests: list[RideRequest],
        trips: list[DriverTrip], viewer_id: str | None,
    ) -> None:
        """Load everything the serializers will ask for in a handful of queries."""
        memo = self._scope.memo
        request_by_id = {r.id: r for r in requests}
        trip_by_id = {t.id: t for t in trips}
        with get_conn() as conn:
            cur = self._cur(conn)
            want_requests = {c.ride_request_id for c in connections} - request_by_id.keys()
            want_trips = {c.driver_trip_id for c in connections} - trip_by_id.keys()
            if want_requests:
                cur.execute("SELECT * FROM ride_requests WHERE id = ANY(%s)", (list(want_requests),))
                request_by_id.update({r["id"]: _row_to_ride_request(r) for r in cur.fetchall()})
            if want_trips:
                cur.execute("SELECT * FROM driver_trips WHERE id = ANY(%s)", (list(want_trips),))
                trip_by_id.update({r["id"]: _row_to_driver_trip(r) for r in cur.fetchall()})
            for rr in request_by_id.values():
                memo[("request", rr.id)] = rr
            for t in trip_by_id.values():
                memo[("trip", t.id)] = t

            location_ids = {rr.pickup_location_id for rr in request_by_id.values()}
            location_ids |= {rr.destination_location_id for rr in request_by_id.values()}
            location_ids |= {t.pickup_location_id for t in trip_by_id.values()}
            location_ids |= {t.destination_location_id for t in trip_by_id.values()}
            user_ids = {rr.rider_id for rr in request_by_id.values()}
            user_ids |= {t.driver_id for t in trip_by_id.values()}
            if location_ids:
                cur.execute("SELECT * FROM locations WHERE id = ANY(%s)", (list(location_ids),))
                for r in cur.fetchall():
                    memo[("location", r["id"])] = _row_to_location(r)
            if user_ids:
                cur.execute("SELECT * FROM profiles WHERE user_id = ANY(%s)", (list(user_ids),))
                for r in cur.fetchall():
                    memo[("profile", r["user_id"])] = _row_to_profile(r)
                cur.execute("SELECT * FROM vehicles WHERE user_id = ANY(%s)", (list(user_ids),))
                for r in cur.fetchall():
                    memo[("vehicle", r["user_id"])] = _row_to_vehicle(r)
                for uid, stats in self._load_user_stats(cur, list(user_ids)).items():
                    memo[("stats", uid)] = stats
            if viewer_id and connections:
                cur.execute(
                    "SELECT connection_id, stars FROM ratings WHERE rater_id = %s AND connection_id = ANY(%s)",
                    (viewer_id, [c.id for c in connections]),
                )
                rated = {r["connection_id"]: r["stars"] for r in cur.fetchall()}
                for c in connections:
                    memo[("rating", f"{c.id}:{viewer_id}")] = rated.get(c.id, 0)  # 0 = not rated

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
        phone: Any = _KEEP, gender: Any = _KEEP,
    ) -> Profile:
        if gender is not _KEEP and gender is not None and gender not in ALLOWED_GENDERS:
            raise DomainError(f"Invalid gender: {gender}")
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
            if gender is not _KEEP:
                cur.execute("UPDATE profiles SET gender = %s WHERE user_id = %s", (gender, user_id))
                if gender != "woman":
                    # The preference only makes sense for women; drop it rather
                    # than silently filtering on a stale answer.
                    cur.execute("UPDATE ride_preferences SET women_only = FALSE WHERE user_id = %s", (user_id,))
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
        hit = self._memo_get("profile", user_id)
        if hit is not None:
            return hit
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM profiles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            return self._memo_put("profile", user_id, _row_to_profile(row) if row else None)

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
        hit = self._memo_get("vehicle", user_id)
        if hit is not None:
            return hit
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM vehicles WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            return self._memo_put("vehicle", user_id, _row_to_vehicle(row) if row else None)

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
        hit = self._memo_get("location", location_id)
        if hit is not None:
            return hit
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM locations WHERE id = %s", (location_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError(f"Location {location_id} not found", 404)
            return self._memo_put("location", location_id, _row_to_location(row))

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
                # The stored matches were computed for the old pickup: mark them stale.
                "UPDATE ride_requests SET pickup_location_id = %s, matches_computed_at = NULL WHERE id = %s",
                (pickup_location_id, request_id),
            )
        rr.pickup_location_id = pickup_location_id
        return rr

    def get_ride_request(self, request_id: str) -> RideRequest:
        hit = self._memo_get("request", request_id)
        if hit is not None:
            return hit
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM ride_requests WHERE id = %s", (request_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Ride request not found", 404)
            return self._memo_put("request", request_id, _row_to_ride_request(row))

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
            vibes=self.get_ride_preferences(driver_id)["vibes"],
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
                       departure_time, price_per_seat_cents, auto_accept_verified, series_id, vibes)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           ST_GeogFromText(%s), %s, %s, %s, %s, %s, %s, %s)""",
                (trip.id, trip.driver_id, trip.pickup_location_id,
                 trip.destination_location_id, trip.target_date, trip.flexibility,
                 trip.seats_available, trip.seats_reserved, trip.tags,
                 trip.status, trip.created_at, trip.luggage_capacity, trip.car_type,
                 trip.notes, route_wkt, route_distance_m, route_duration_s,
                 trip.departure_time, trip.price_per_seat_cents, trip.auto_accept_verified,
                 trip.series_id, trip.vibes),
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
            cur.execute(f"SELECT {_trip_columns()} FROM driver_trips WHERE id = %s", (trip_id,))
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
        date_changed = data.get("target_date") is not None and data["target_date"] != trip.target_date
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
                       departure_time = %s, notes = %s, status = %s,
                       matches_computed_at = CASE WHEN %s THEN NULL ELSE matches_computed_at END  -- new date, new candidates
                       WHERE id = %s""",
                (trip.seats_available, trip.target_date, trip.flexibility, trip.departure_time,
                 trip.notes, trip.status, date_changed, trip_id),
            )
        return trip

    def get_driver_trip(self, trip_id: str) -> DriverTrip:
        hit = self._memo_get("trip", trip_id)
        if hit is not None:
            return hit
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(f"SELECT {_trip_columns()} FROM driver_trips WHERE id = %s", (trip_id,))
            row = cur.fetchone()
            if not row:
                raise DomainError("Driver trip not found", 404)
            return self._memo_put("trip", trip_id, _row_to_driver_trip(row))

    def get_user_driver_trips(self, user_id: str) -> list[DriverTrip]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"SELECT {_trip_columns()} FROM driver_trips WHERE driver_id = %s ORDER BY created_at DESC",
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
            # Candidates for listings that can no longer be proposed are dead weight.
            cur.execute(
                """DELETE FROM match_candidates mc
                   WHERE NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.id = mc.ride_request_id AND r.status = 'open')
                      OR NOT EXISTS (SELECT 1 FROM driver_trips t WHERE t.id = mc.driver_trip_id
                                     AND t.status IN ('open', 'matched', 'paused'))"""
            )

    # ─── Search ───────────────────────────────────────────────────────────────

    def search_driver_trips(self, user_id: str, query: dict[str, Any]) -> list[DriverTrip]:
        # Stale listings are hidden by the date filter below; archiving them is
        # the cron sweep's job (GET /cron/expire), not a write on the read path.
        prefs = self.get_ride_preferences(user_id) if query.get("apply_preferences", True) else None
        if prefs and prefs["max_walk_minutes"]:
            walk_m = prefs["max_walk_minutes"] * WALK_METERS_PER_MINUTE
            query = {**query, "pickup_radius_meters": walk_m, "route_buffer_meters": walk_m}
        corridor = self._corridor_search(query)
        if corridor:
            joins, geo_conditions, geo_params = corridor
        else:
            joins, geo_conditions, geo_params = self._geo_search_clauses(query, "dt")
        attr_conditions, attr_params = self._attribute_clauses(query, "dt", is_trip=True)
        limit = int(query.get("limit", SEARCH_LIMIT))
        pref_conditions = ""
        if prefs and prefs["verified_only"]:
            pref_conditions += " AND EXISTS (SELECT 1 FROM users vu WHERE vu.id = dt.driver_id AND vu.id_verified)"
        if prefs and prefs["women_only"]:
            # The driver and every rider already booked on the trip are women.
            pref_conditions += """ AND EXISTS (SELECT 1 FROM profiles gp WHERE gp.user_id = dt.driver_id AND gp.gender = 'woman')
                AND NOT EXISTS (SELECT 1 FROM connections wc
                                JOIN ride_requests wr ON wr.id = wc.ride_request_id
                                LEFT JOIN profiles wp ON wp.user_id = wr.rider_id
                                WHERE wc.driver_trip_id = dt.id AND wc.status = 'accepted'
                                AND wp.gender IS DISTINCT FROM 'woman')"""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"""SELECT dt.*,
                          ST_Y(dt.pickup_geog::geometry) AS trip_pickup_lat, ST_X(dt.pickup_geog::geometry) AS trip_pickup_lng,
                          ST_Y(dt.dest_geog::geometry) AS trip_dest_lat, ST_X(dt.dest_geog::geometry) AS trip_dest_lng
                   FROM driver_trips dt
                   {joins}
                   WHERE dt.status IN ('open', 'matched')
                   AND dt.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND dt.driver_id != %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = dt.driver_id AND u.status = 'suspended')
                   {geo_conditions}
                   {attr_conditions}
                   {pref_conditions}
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = dt.driver_id)
                          OR (blocker_id = dt.driver_id AND blocked_id = %s)
                   )
                   ORDER BY dt.created_at DESC
                   LIMIT %s""",
                (user_id, *geo_params, *attr_params, user_id, user_id, limit),
            )
            rows = cur.fetchall()

        trips = [_row_to_driver_trip(r) for r in rows]
        if corridor:
            self._attach_detours(trips, rows, query)
        if prefs is not None:
            self._rank_by_preferences(user_id, trips, prefs)
        return trips

    def _rank_by_preferences(self, user_id: str, trips: list[DriverTrip], prefs: dict[str, Any]) -> None:
        """Marks each trip with what it has in common with the rider (coworker,
        ride buddy, shared vibes) and, with "Coworkers first", moves coworkers
        and buddies to the top. A stable sort, so the SQL order holds within
        each group. Vibes only rank, never filter: an empty result for "Quiet
        ride" helps no one."""
        if not trips:
            return
        driver_ids = list({t.driver_id for t in trips})
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT u.id, u.email_domain = me.email_domain AS coworker,
                          EXISTS (SELECT 1 FROM ride_buddies b WHERE b.user_id = me.id AND b.buddy_id = u.id) AS buddy
                   FROM users u, users me WHERE me.id = %s AND u.id = ANY(%s)""",
                (user_id, driver_ids),
            )
            flags = {r["id"]: r for r in cur.fetchall()}
        wanted = set(prefs["vibes"])
        work_domain = not _is_public_email_domain(self.user_for_id(user_id).email_domain)
        for t in trips:
            f = flags.get(t.driver_id)
            t.is_coworker = bool(work_domain and f and f["coworker"])
            t.is_buddy = bool(f and f["buddy"])
            t.shared_vibes = sorted(wanted & set(t.vibes))
        if prefs["coworkers_first"]:
            trips.sort(key=lambda t: (not t.is_buddy, not t.is_coworker, -len(t.shared_vibes or [])))

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
        eligible = self._ranked_trips_for_request(user_id, rr)
        return {"trip": eligible[0] if eligible else None, "remaining": max(len(eligible) - 1, 0)}

    def _ranked_trips_for_request(self, user_id: str, rr: RideRequest) -> list[DriverTrip]:
        self._ensure_matches(rr.id, "ride_requests", self.compute_matches_for_request)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT dt.*, mc.detour_minutes AS candidate_detour
                   FROM match_candidates mc
                   JOIN driver_trips dt ON dt.id = mc.driver_trip_id
                   WHERE mc.ride_request_id = %s
                   AND dt.status = 'open'
                   AND dt.seats_available - dt.seats_reserved >= %s
                   AND dt.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND abs(dt.target_date - %s::date) <= 1
                   AND dt.driver_id != %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = dt.driver_id AND u.status = 'suspended')
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = dt.driver_id)
                          OR (blocker_id = dt.driver_id AND blocked_id = %s)
                   )
                   AND NOT EXISTS (SELECT 1 FROM match_skips ms
                                   WHERE ms.ride_request_id = mc.ride_request_id AND ms.driver_trip_id = mc.driver_trip_id)
                   AND NOT EXISTS (SELECT 1 FROM connections c
                                   WHERE c.ride_request_id = mc.ride_request_id AND c.driver_trip_id = mc.driver_trip_id)""",
                (rr.id, rr.passenger_count, rr.target_date, user_id, user_id, user_id),
            )
            rows = cur.fetchall()
        eligible = []
        for row in rows:
            trip = _row_to_driver_trip(row)
            trip.detour_minutes = row["candidate_detour"]
            trip.time_gap_minutes = _time_gap_minutes(trip, rr)
            if trip.time_gap_minutes is None or trip.time_gap_minutes <= MAX_TIME_GAP_MINUTES:
                eligible.append(trip)
        eligible.sort(key=lambda t: -_proposal_score(t.detour_minutes, t, rr))
        return eligible

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
        self._ensure_matches(trip.id, "driver_trips", self.compute_matches_for_trip)
        skip_clause = "" if include_skipped else (
            "AND NOT EXISTS (SELECT 1 FROM driver_match_skips s "
            "WHERE s.driver_trip_id = mc.driver_trip_id AND s.ride_request_id = mc.ride_request_id)"
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"""SELECT rr.*, mc.detour_minutes AS candidate_detour, mc.off_route_m
                   FROM match_candidates mc
                   JOIN ride_requests rr ON rr.id = mc.ride_request_id
                   WHERE mc.driver_trip_id = %s
                   AND rr.status = 'open'
                   AND rr.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND abs(rr.target_date - %s::date) <= 1
                   AND rr.rider_id != %s
                   AND rr.passenger_count <= %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rr.rider_id AND u.status = 'suspended')
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = rr.rider_id)
                          OR (blocker_id = rr.rider_id AND blocked_id = %s)
                   )
                   AND NOT EXISTS (SELECT 1 FROM connections c
                                   WHERE c.ride_request_id = mc.ride_request_id AND c.driver_trip_id = mc.driver_trip_id)
                   {skip_clause}""",
                (trip.id, trip.target_date, user_id, trip.seats_available - trip.seats_reserved, user_id, user_id),
            )
            rows = cur.fetchall()

        requests = []
        for row in rows:
            rr = _row_to_ride_request(row)
            rr.detour_minutes = row["candidate_detour"]
            rr.off_route_m = None if row["off_route_m"] is None else round(row["off_route_m"])
            rr.time_gap_minutes = _time_gap_minutes(trip, rr)
            if rr.time_gap_minutes is not None and rr.time_gap_minutes > MAX_TIME_GAP_MINUTES:
                continue
            rr.match_score = round(100 * _proposal_score(rr.detour_minutes, trip, rr))
            requests.append(rr)
        requests.sort(key=lambda rr: -(rr.match_score or 0))
        return requests

    # ─── Match notifications ──────────────────────────────────────────────────

    def notify_new_matches(self, kind: str, listing_id: str) -> None:
        """Tell the best few people on the other side that a listing they fit was
        just published. Called once, after a listing is created; each person gets
        at most one unread nudge per listing of theirs, so a busy day or a weekly
        series can't pile up."""
        if kind == "trip":
            trip = self.get_driver_trip(listing_id)
            if trip.status != "open":
                return
            for rr in self._ranked_requests_for_trip(trip.driver_id, trip, include_skipped=False)[:MAX_MATCH_NOTIFICATIONS]:
                self._notify_match(rr.rider_id, rr.id, "A driver is going your way",
                                   f"A driver posted a trip on {trip.target_date:%a %b} {trip.target_date.day} that fits your request.")
        else:
            rr = self.get_ride_request(listing_id)
            if rr.status != "open":
                return
            for trip in self._ranked_trips_for_request(rr.rider_id, rr)[:MAX_MATCH_NOTIFICATIONS]:
                self._notify_match(trip.driver_id, trip.id, "A passenger needs a ride along your route",
                                   f"A passenger on {rr.target_date:%a %b} {rr.target_date.day} is headed the way you are.")

    def _notify_match(self, user_id: str, related_id: str, title: str, body: str) -> bool:
        """Insert a `new_match` notification unless that user already has an
        unread one for the same listing. True if one was sent."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO notifications (id, user_id, type, title, body, created_at, read, related_id)
                   SELECT %s, %s, 'new_match', %s, %s, %s, FALSE, %s
                   WHERE NOT EXISTS (SELECT 1 FROM notifications
                                     WHERE user_id = %s AND type = 'new_match' AND related_id = %s AND NOT read)""",
                (new_id("ntf"), user_id, title, body, now_utc(), related_id, user_id, related_id),
            )
            return cur.rowcount == 1

    def _suggest_next_match(self, connection: Connection) -> None:
        """A pending connection ended without a ride (declined or lapsed): point
        whoever sent it at the next-best option instead of leaving them to search."""
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if connection.initiator_user_id == rr.rider_id:
            if rr.status == "open":
                nxt = self._ranked_trips_for_request(rr.rider_id, rr)
                if nxt:
                    self._notify_match(rr.rider_id, rr.id, "Another driver is going your way",
                                       "That request didn't work out, but there's another option for you.")
        elif trip.status == "open":
            nxt_requests = self._ranked_requests_for_trip(trip.driver_id, trip, include_skipped=False)
            if nxt_requests:
                self._notify_match(trip.driver_id, trip.id, "Another passenger is along your route",
                                   "That offer didn't work out, but there's another passenger for your trip.")

    # ─── Match candidates (computed when a listing is written) ───────────────

    def _ensure_matches(self, listing_id: str, table: str, compute: Any) -> None:
        """Listings that predate match_candidates (or whose background compute
        hasn't finished) get theirs computed on first use."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(f"SELECT matches_computed_at FROM {table} WHERE id = %s", (listing_id,))  # table is a literal from callers
            row = cur.fetchone()
        if row and row["matches_computed_at"] is None:
            compute(listing_id)

    def compute_matches_for_request(self, request_id: str) -> None:
        """Find the trips along which this request fits and store them with their
        routed detour. Replaces whatever was stored for the request."""
        rr = self.get_ride_request(request_id)
        rows: list[dict[str, Any]] = []
        if rr.status == "open":
            with get_conn() as conn:
                cur = self._cur(conn)
                cur.execute(
                    """SELECT t.id AS trip_id, t.route_duration_s,
                              ST_Y(t.pickup_geog::geometry) AS trip_pickup_lat, ST_X(t.pickup_geog::geometry) AS trip_pickup_lng,
                              ST_Y(t.dest_geog::geometry) AS trip_dest_lat, ST_X(t.dest_geog::geometry) AS trip_dest_lng,
                              ST_Y(r.pickup_geog::geometry) AS rider_pickup_lat, ST_X(r.pickup_geog::geometry) AS rider_pickup_lng,
                              ST_Y(r.dest_geog::geometry) AS rider_dest_lat, ST_X(r.dest_geog::geometry) AS rider_dest_lng,
                              CASE WHEN t.route_geog IS NOT NULL THEN ST_Distance(t.route_geog, r.pickup_geog)
                                   ELSE ST_Distance(t.pickup_geog, r.pickup_geog) END AS off_route_m
                       FROM ride_requests r
                       JOIN driver_trips t ON t.status IN ('open', 'matched', 'paused')
                        AND t.driver_id != r.rider_id
                        AND t.target_date >= CURRENT_DATE - INTERVAL '1 day'
                        AND abs(t.target_date - r.target_date) <= 1
                        AND (
                            (t.route_geog IS NOT NULL
                             AND (  (t.pickup_is_general AND ST_DWithin(t.route_geog, r.pickup_geog, %(area)s))
                                 OR (NOT t.pickup_is_general AND ST_DWithin(t.route_geog, r.pickup_geog, %(buffer)s)))
                             AND (  (t.dest_is_general AND ST_DWithin(t.route_geog, r.dest_geog, %(area)s))
                                 OR (NOT t.dest_is_general AND ST_DWithin(t.route_geog, r.dest_geog, %(buffer)s)))
                             AND ST_LineLocatePoint(t.route_geog::geometry, r.pickup_geog::geometry)
                                 < ST_LineLocatePoint(t.route_geog::geometry, r.dest_geog::geometry))
                            OR
                            (t.route_geog IS NULL
                             AND (  (t.pickup_is_general AND ST_DWithin(t.pickup_geog, r.pickup_geog, %(area)s))
                                 OR (NOT t.pickup_is_general AND ST_DWithin(t.pickup_geog, r.pickup_geog, %(pickup_r)s)))
                             AND (  (t.dest_is_general AND ST_DWithin(t.dest_geog, r.dest_geog, %(area)s))
                                 OR (NOT t.dest_is_general AND ST_DWithin(t.dest_geog, r.dest_geog, %(dest_r)s))))
                        )
                       WHERE r.id = %(id)s
                       ORDER BY t.created_at DESC LIMIT %(limit)s""",
                    {"id": rr.id, "area": GENERAL_AREA_RADIUS_METERS, "buffer": ROUTE_BUFFER_METERS,
                     "pickup_r": 5000, "dest_r": 1000, "limit": MAX_CANDIDATES_PER_LISTING},
                )
                rows = cur.fetchall()
        self._store_candidates("ride_requests", rr.id, "ride_request_id", "driver_trip_id", "trip_id", rows)

    def compute_matches_for_trip(self, trip_id: str) -> None:
        """Mirror of compute_matches_for_request: the open requests along this trip."""
        trip = self.get_driver_trip(trip_id)
        rows: list[dict[str, Any]] = []
        if trip.status in ("open", "matched", "paused"):
            with get_conn() as conn:
                cur = self._cur(conn)
                # The trip's area flags settle the radii as constants, which is
                # what lets the planner use the requests' spatial indexes.
                cur.execute("SELECT pickup_is_general, dest_is_general FROM driver_trips WHERE id = %s", (trip.id,))
                flags = cur.fetchone()
                pickup_corridor = GENERAL_AREA_RADIUS_METERS if flags["pickup_is_general"] else ROUTE_BUFFER_METERS
                dest_corridor = GENERAL_AREA_RADIUS_METERS if flags["dest_is_general"] else ROUTE_BUFFER_METERS
                pickup_endpoint = GENERAL_AREA_RADIUS_METERS if flags["pickup_is_general"] else 5000
                dest_endpoint = GENERAL_AREA_RADIUS_METERS if flags["dest_is_general"] else 1000
                cur.execute(
                    """SELECT r.id AS request_id, t.route_duration_s,
                              ST_Y(t.pickup_geog::geometry) AS trip_pickup_lat, ST_X(t.pickup_geog::geometry) AS trip_pickup_lng,
                              ST_Y(t.dest_geog::geometry) AS trip_dest_lat, ST_X(t.dest_geog::geometry) AS trip_dest_lng,
                              ST_Y(r.pickup_geog::geometry) AS rider_pickup_lat, ST_X(r.pickup_geog::geometry) AS rider_pickup_lng,
                              ST_Y(r.dest_geog::geometry) AS rider_dest_lat, ST_X(r.dest_geog::geometry) AS rider_dest_lng,
                              CASE WHEN t.route_geog IS NOT NULL THEN ST_Distance(t.route_geog, r.pickup_geog)
                                   ELSE ST_Distance(t.pickup_geog, r.pickup_geog) END AS off_route_m
                       FROM driver_trips t
                       JOIN ride_requests r ON r.status = 'open'
                        AND r.rider_id != t.driver_id
                        AND r.target_date >= CURRENT_DATE - INTERVAL '1 day'
                        AND abs(r.target_date - t.target_date) <= 1
                        AND (
                            (t.route_geog IS NOT NULL
                             AND ST_DWithin(r.pickup_geog, t.route_geog, %(pc)s)
                             AND ST_DWithin(r.dest_geog, t.route_geog, %(dc)s)
                             AND ST_LineLocatePoint(t.route_geog::geometry, r.pickup_geog::geometry)
                                 < ST_LineLocatePoint(t.route_geog::geometry, r.dest_geog::geometry))
                            OR
                            (t.route_geog IS NULL
                             AND ST_DWithin(r.pickup_geog, t.pickup_geog, %(pe)s)
                             AND ST_DWithin(r.dest_geog, t.dest_geog, %(de)s))
                        )
                       WHERE t.id = %(id)s
                       ORDER BY r.created_at DESC LIMIT %(limit)s""",
                    {"id": trip.id, "pc": pickup_corridor, "dc": dest_corridor, "pe": pickup_endpoint,
                     "de": dest_endpoint, "limit": MAX_CANDIDATES_PER_LISTING},
                )
                rows = cur.fetchall()
        self._store_candidates("driver_trips", trip.id, "driver_trip_id", "ride_request_id", "request_id", rows)

    def _store_candidates(self, table: str, listing_id: str, own_col: str, other_col: str,
                          other_key: str, rows: list[dict[str, Any]]) -> None:
        """Replace this listing's candidate rows. The routed detour is computed
        outside any transaction (it is slow I/O), for the newest few only."""
        detours = self._pair_detours(rows[:CANDIDATE_DETOUR_LIMIT])
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(f"DELETE FROM match_candidates WHERE {own_col} = %s", (listing_id,))
            for i, row in enumerate(rows):
                cur.execute(
                    f"""INSERT INTO match_candidates ({own_col}, {other_col}, detour_minutes, off_route_m)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (ride_request_id, driver_trip_id) DO UPDATE
                        SET detour_minutes = EXCLUDED.detour_minutes, off_route_m = EXCLUDED.off_route_m,
                            computed_at = now()""",
                    (listing_id, row[other_key], detours[i] if i < len(detours) else None, row["off_route_m"]),
                )
            cur.execute(f"UPDATE {table} SET matches_computed_at = now() WHERE id = %s", (listing_id,))  # table is a literal from callers

    def _pair_detours(self, rows: list[dict[str, Any]]) -> list[float | None]:
        """Minutes each pair's trip grows if the passenger is inserted (driver
        pickup -> passenger pickup -> passenger dest -> driver dest, against the
        stored direct route). Routed in parallel; unknown (no router, no stored
        route, OSRM down) is None."""
        if self.router is None or not rows:
            return [None] * len(rows)

        def detour(r: dict[str, Any]) -> float | None:
            if r["route_duration_s"] is None:
                return None
            with_rider = self.router.route([
                (r["trip_pickup_lat"], r["trip_pickup_lng"]),
                (r["rider_pickup_lat"], r["rider_pickup_lng"]),
                (r["rider_dest_lat"], r["rider_dest_lng"]),
                (r["trip_dest_lat"], r["trip_dest_lng"]),
            ])
            if with_rider is None:
                return None
            return round(max(0.0, (with_rider.duration_s - r["route_duration_s"]) / 60), 1)

        with ThreadPoolExecutor(max_workers=len(rows)) as pool:
            return list(pool.map(detour, rows))

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
        plng, plat = query["pickup_longitude"], query["pickup_latitude"]
        dlng, dlat = query["destination_longitude"], query["destination_latitude"]
        area = GENERAL_AREA_RADIUS_METERS
        # A trip whose pickup/destination is a general area (pickup/dest_is_general)
        # matches anything inside that area, not just within the street-level buffer.
        route_pickup, route_pickup_p = _within_area_aware("dt.route_geog", "dt.pickup_is_general", plng, plat, area, buffer_m)
        route_dest, route_dest_p = _within_area_aware("dt.route_geog", "dt.dest_is_general", dlng, dlat, area, buffer_m)
        corridor = f"""(dt.route_geog IS NOT NULL
                AND {route_pickup}
                AND {route_dest}
                AND ST_LineLocatePoint(dt.route_geog::geometry, {_POINT_GEOM_SQL})
                    < ST_LineLocatePoint(dt.route_geog::geometry, {_POINT_GEOM_SQL}))"""
        end_pickup, end_pickup_p = _within_area_aware(
            "dt.pickup_geog", "dt.pickup_is_general", plng, plat, area, query.get("pickup_radius_meters", 5000))
        end_dest, end_dest_p = _within_area_aware(
            "dt.dest_geog", "dt.dest_is_general", dlng, dlat, area, query.get("destination_radius_meters", 1000))
        fallback = f"(dt.route_geog IS NULL AND {end_pickup} AND {end_dest})"
        params = [*route_pickup_p, *route_dest_p, plng, plat, dlng, dlat, *end_pickup_p, *end_dest_p]
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
        joins, geo_conditions, geo_params = self._geo_search_clauses(query, "rr")
        attr_conditions, attr_params = self._attribute_clauses(query, "rr", is_trip=False)
        limit = int(query.get("limit", SEARCH_LIMIT))
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                f"""SELECT rr.* FROM ride_requests rr
                   {joins}
                   WHERE rr.status IN ('open', 'matched')
                   AND rr.target_date >= CURRENT_DATE - INTERVAL '1 day'
                   AND rr.rider_id != %s
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rr.rider_id AND u.status = 'suspended')
                   {geo_conditions}
                   {attr_conditions}
                   AND NOT EXISTS (
                       SELECT 1 FROM blocks
                       WHERE (blocker_id = %s AND blocked_id = rr.rider_id)
                          OR (blocker_id = rr.rider_id AND blocked_id = %s)
                   )
                   ORDER BY rr.created_at DESC
                   LIMIT %s""",
                (user_id, *geo_params, *attr_params, user_id, user_id, limit),
            )
            return [_row_to_ride_request(r) for r in cur.fetchall()]

    @staticmethod
    def _geo_search_clauses(query: dict[str, Any], alias: str) -> tuple[str, str, list[Any]]:
        """WHERE fragments and params for PostGIS ST_DWithin radius filtering on a
        listing's own denormalized pickup/destination points, so no join to
        `locations` is needed. Fragment strings are static (never built from
        request input); only the bind parameters carry request-supplied values.
        The empty first element keeps the (joins, conditions, params) shape."""
        conditions: list[str] = []
        params: list[Any] = []
        if query.get("destination_latitude") is not None:
            sql, p = _within_area_aware(
                f"{alias}.dest_geog", f"{alias}.dest_is_general", query["destination_longitude"],
                query["destination_latitude"], GENERAL_AREA_RADIUS_METERS,
                query.get("destination_radius_meters", 1000))
            conditions.append(f"AND {sql}")
            params += p
        if query.get("pickup_latitude") is not None:
            sql, p = _within_area_aware(
                f"{alias}.pickup_geog", f"{alias}.pickup_is_general", query["pickup_longitude"],
                query["pickup_latitude"], GENERAL_AREA_RADIUS_METERS,
                query.get("pickup_radius_meters", 5000))
            conditions.append(f"AND {sql}")
            params += p
        return "", " ".join(conditions), params

    @staticmethod
    def _attribute_clauses(query: dict[str, Any], alias: str, is_trip: bool) -> tuple[str, list[Any]]:
        """Date, tag, car type and luggage filters as SQL, so LIMIT applies to
        rows that actually match. Car type and luggage describe a driver's
        vehicle, so they only constrain trips; a trip with no car type set
        isn't excluded by a car-type filter."""
        conditions: list[str] = []
        params: list[Any] = []
        if query.get("target_date"):
            conditions.append(f"AND {alias}.target_date = %s")
            params.append(query["target_date"])
        if query.get("tag"):
            conditions.append(f"AND {alias}.tags @> ARRAY[%s]::text[]")
            params.append(query["tag"])
        if is_trip and query.get("car_type"):
            conditions.append(f"AND ({alias}.car_type IS NULL OR {alias}.car_type = %s)")
            params.append(query["car_type"])
        if is_trip and query.get("luggage_size"):
            conditions.append(
                f"AND array_position({_LUGGAGE_ORDER_SQL}, {alias}.luggage_capacity) "
                f">= array_position({_LUGGAGE_ORDER_SQL}, %s)")
            params.append(query["luggage_size"])
        return " ".join(conditions), params

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

        # The apps create a fresh listing for whoever taps "Request" / "Offer",
        # so a passenger asking this driver and the driver offering this
        # passenger are usually two different (request, trip) pairs. If the
        # other person is already waiting on this user for the same day, both
        # want the ride: confirm theirs instead of adding a second one that
        # waits the other way round.
        mutual = self._pending_from_other_party(user_id, rr, trip)
        if mutual is not None:
            try:
                return self.transition_connection(user_id, mutual.id, "accept")
            except DomainError:
                pass  # e.g. not enough seats on that trip: send this one normally

        # A passenger's request and a driver's offer for the same pair would
        # otherwise sit as two pending connections, each waiting on the other.
        conn_obj = Connection(
            id=new_id("con"), ride_request_id=rr.id,
            driver_trip_id=trip.id, initiator_user_id=user_id,
            status="pending", created_at=now_utc(), updated_at=now_utc(),
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            # The unique index on live (request, trip) pairs makes this the
            # arbiter when two taps race; the loser inserts nothing.
            cur.execute(
                """INSERT INTO connections (id, ride_request_id, driver_trip_id,
                       initiator_user_id, status, created_at, updated_at,
                       completed_confirmed_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT DO NOTHING""",
                (conn_obj.id, conn_obj.ride_request_id, conn_obj.driver_trip_id,
                 conn_obj.initiator_user_id, conn_obj.status,
                 conn_obj.created_at, conn_obj.updated_at, []),
            )
            inserted = cur.rowcount == 1
            if inserted and user_id == rr.rider_id:
                cur.execute(
                    "SELECT COUNT(*) AS n FROM connections "
                    "WHERE ride_request_id = %s AND initiator_user_id = %s AND status = 'pending'",
                    (rr.id, user_id),
                )
                if cur.fetchone()["n"] > MAX_PENDING_REQUESTS_PER_RIDE:  # raising rolls the insert back
                    raise DomainError(
                        f"You can have up to {MAX_PENDING_REQUESTS_PER_RIDE} requests waiting at once", 409)
            existing = None
            if not inserted:
                cur.execute(
                    """SELECT * FROM connections
                       WHERE ride_request_id = %s AND driver_trip_id = %s AND status = 'pending'
                       ORDER BY created_at LIMIT 1""",
                    (rr.id, trip.id),
                )
                existing = cur.fetchone()
        if not inserted:
            if not existing:
                raise DomainError("These listings are already connected", 409)
            existing_conn = _row_to_connection(existing)
            if existing_conn.initiator_user_id == user_id:
                return existing_conn  # repeat tap: nothing new to send
            # The other party already asked: both want this ride, so confirm it.
            return self.transition_connection(user_id, existing_conn.id, "accept")
        recipient = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        # Driver opted in to auto-accepting ID-verified passengers: skip the wait.
        if (user_id == rr.rider_id and trip.auto_accept_verified
                and self.user_for_id(rr.rider_id).id_verified):
            return self.transition_connection(trip.driver_id, conn_obj.id, "accept")
        sender = self.get_profile(user_id)
        name = sender.display_name if sender else "Someone"
        self.notify(recipient, "connection_received",
                    f"{name} wants a ride" if user_id == rr.rider_id else f"{name} offered you a ride",
                    "Open it to accept or decline.", related_id=conn_obj.id)
        return conn_obj

    def _pending_from_other_party(self, user_id: str, rr: RideRequest, trip: DriverTrip) -> Connection | None:
        """The oldest pending connection where the other person (same passenger,
        same driver, same day) already asked this user, on a different pair of
        listings. The same pair is settled by the insert in create_connection."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT c.* FROM connections c
                   JOIN ride_requests r2 ON r2.id = c.ride_request_id
                   JOIN driver_trips t2 ON t2.id = c.driver_trip_id
                   WHERE c.status = 'pending' AND c.initiator_user_id <> %s
                     AND r2.rider_id = %s AND t2.driver_id = %s AND t2.target_date = %s
                     AND NOT (c.ride_request_id = %s AND c.driver_trip_id = %s)
                   ORDER BY c.created_at LIMIT 1""",
                (user_id, rr.rider_id, trip.driver_id, trip.target_date, rr.id, trip.id),
            )
            row = cur.fetchone()
        return _row_to_connection(row) if row else None

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
                """SELECT * FROM (
                       SELECT c.* FROM connections c
                       JOIN ride_requests rr ON rr.id = c.ride_request_id WHERE rr.rider_id = %s
                       UNION ALL
                       SELECT c.* FROM connections c
                       JOIN driver_trips dt ON dt.id = c.driver_trip_id WHERE dt.driver_id = %s
                   ) mine ORDER BY updated_at DESC""",
                (user_id, user_id),
            )
            return [_row_to_connection(r) for r in cur.fetchall()]

    def connection_statuses(self, user_id: str) -> list[dict[str, Any]]:
        """Just id / status / updated_at for every ride the user is part of: one
        query, for clients polling for changes. They fetch the full (expensive)
        connection list only when something here changes."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT c.id, c.status, c.updated_at FROM connections c
                   JOIN ride_requests rr ON rr.id = c.ride_request_id
                   JOIN driver_trips dt ON dt.id = c.driver_trip_id
                   WHERE rr.rider_id = %s OR dt.driver_id = %s
                   ORDER BY c.updated_at DESC""",
                (user_id, user_id),
            )
            return [dict(r) for r in cur.fetchall()]

    def transition_connection(self, user_id: str, connection_id: str, action: str) -> Connection:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        participants = {rr.rider_id, trip.driver_id}
        if user_id not in participants:
            raise DomainError("Only participants can update this connection", 403)

        # One transaction per transition: the state change, seat bookkeeping and
        # notifications commit together or not at all. Each write is conditional
        # on the state it expects, so two simultaneous requests can't both win.
        with get_conn() as conn:
            cur = self._cur(conn)
            now = now_utc()
            if action == "accept":
                # The PIN the rider reads out to the driver before getting in.
                pin = f"{secrets.randbelow(10_000):04d}"
                cur.execute(
                    "UPDATE connections SET status = 'accepted', updated_at = %s, responded_at = %s, ride_pin = %s "
                    "WHERE id = %s AND status = 'pending' RETURNING id",
                    (now, now, pin, connection_id),
                )
                if not cur.fetchone():
                    raise DomainError("Only pending connections can be accepted")
                cur.execute(
                    """UPDATE driver_trips
                       SET seats_reserved = seats_reserved + %(n)s,
                           status = CASE WHEN seats_reserved + %(n)s >= seats_available THEN 'matched' ELSE status END
                       WHERE id = %(trip)s AND seats_reserved + %(n)s <= seats_available
                       RETURNING id""",
                    {"n": rr.passenger_count, "trip": trip.id},
                )
                if not cur.fetchone():
                    raise DomainError("Driver trip does not have enough available seats", 409)  # rolls back the accept
                cur.execute("UPDATE ride_requests SET status = 'matched' WHERE id = %s AND status = 'open' RETURNING id",
                            (rr.id,))
                if not cur.fetchone():
                    raise DomainError("This ride request is already matched", 409)
                connection.status = "accepted"
                connection.responded_at, connection.ride_pin = now, pin
                # The passenger has a ride: other requests they had out are moot.
                cur.execute(
                    """UPDATE connections c SET status = 'cancelled', updated_at = %s
                       FROM driver_trips dt
                       WHERE c.ride_request_id = %s AND c.id <> %s AND c.status = 'pending'
                         AND dt.id = c.driver_trip_id
                       RETURNING c.id, dt.driver_id, c.initiator_user_id""",
                    (now, rr.id, connection_id),
                )
                for other in cur.fetchall():
                    # Whether the passenger asked or the driver offered, the driver is
                    # the one left hanging.
                    self.notify(other["driver_id"], "connection_cancelled", "Passenger found another ride",
                                "The passenger accepted a different ride, so this one was closed.",
                                related_id=other["id"])
                self.notify(connection.initiator_user_id, "connection_accepted",
                            "Connection accepted", "Your carpool connection was accepted.", related_id=connection.id)
                self.notify(rr.rider_id, "chat_unlocked", "Chat unlocked",
                            "Full chat is available for your accepted connection.", related_id=connection.id)
                self.notify(trip.driver_id, "chat_unlocked", "Chat unlocked",
                            "Full chat is available for your accepted connection.", related_id=connection.id)

            elif action == "decline":
                cur.execute(
                    "UPDATE connections SET status = 'declined', updated_at = %s, responded_at = %s "
                    "WHERE id = %s AND status = 'pending' RETURNING id",
                    (now, now, connection_id),
                )
                if not cur.fetchone():
                    raise DomainError("Only pending connections can be declined")
                connection.status = "declined"
                self.notify(connection.initiator_user_id, "connection_declined", "Request declined",
                            "Your carpool request was declined.", related_id=connection.id)

            elif action == "cancel":
                cur.execute(
                    "UPDATE connections SET status = 'cancelled', updated_at = %s "
                    "WHERE id = %s AND status = 'accepted' RETURNING id",
                    (now, connection_id),
                )
                if cur.fetchone():  # only the call that flips accepted -> cancelled gives the seats back
                    cur.execute(
                        """UPDATE driver_trips
                           SET seats_reserved = GREATEST(0, seats_reserved - %s),
                               status = CASE WHEN status = 'matched' THEN 'open' ELSE status END
                           WHERE id = %s""",
                        (rr.passenger_count, trip.id),
                    )
                else:
                    cur.execute("UPDATE connections SET status = 'cancelled', updated_at = %s WHERE id = %s",
                                (now, connection_id))
                connection.status = "cancelled"

            elif action == "complete":
                confirmed = list(connection.completed_confirmed_by)
                if user_id not in confirmed:
                    confirmed.append(user_id)
                cur.execute(
                    "UPDATE connections SET status = 'completed', completed_confirmed_by = %s, updated_at = %s, "
                    "completed_at = %s WHERE id = %s AND status = 'accepted' RETURNING id",
                    (confirmed, now, now, connection_id),
                )
                if not cur.fetchone():
                    raise DomainError("Only accepted connections can be completed")
                cur.execute("UPDATE ride_requests SET status = 'completed' WHERE id = %s", (rr.id,))
                cur.execute("UPDATE driver_trips SET status = 'completed' WHERE id = %s", (trip.id,))
                connection.status = "completed"
                connection.completed_confirmed_by = confirmed
                connection.completed_at = now
                self._settle_fare(connection, rr, trip)
                self._write_receipt(connection, rr, trip)
            else:
                raise DomainError(f"Unsupported connection action: {action}")

        connection.updated_at = now_utc()
        self._invalidate_stats(rr.rider_id, trip.driver_id)
        if action == "decline":
            self._suggest_next_match(connection)
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
        self.sweep_unanswered_connections()

    def sweep_unanswered_connections(self) -> None:
        """Keep pending connections moving: lapse the ones nobody answered within
        the TTL (and point the sender at the next-best match), and nudge
        recipients once while there is still time to answer."""
        now = now_utc()
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """UPDATE connections SET status = 'expired', updated_at = %s
                   WHERE status = 'pending' AND created_at < %s
                   RETURNING *""",
                (now, now - PENDING_TTL),
            )
            lapsed = [_row_to_connection(r) for r in cur.fetchall()]
            cur.execute(
                """UPDATE connections c SET reminded_at = %s
                   FROM ride_requests rr, driver_trips dt
                   WHERE c.status = 'pending' AND c.reminded_at IS NULL AND c.created_at < %s
                     AND rr.id = c.ride_request_id AND dt.id = c.driver_trip_id
                   RETURNING c.id,
                             CASE WHEN c.initiator_user_id = rr.rider_id THEN dt.driver_id ELSE rr.rider_id END AS recipient_id""",
                (now, now - PENDING_REMINDER_AFTER),
            )
            reminders = cur.fetchall()
            for r in reminders:
                self.notify(r["recipient_id"], "connection_reminder", "Someone is waiting for your reply",
                            "You have a carpool request that hasn't been answered yet.", related_id=r["id"])
            for c in lapsed:
                self.notify(c.initiator_user_id, "connection_expired", "No reply to your request",
                            "Nobody answered in time, so the request was closed.", related_id=c.id)
        for c in lapsed:
            self._suggest_next_match(c)

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
        return self._fare_suggestion(self.get_ride_request(connection.ride_request_id))

    def _fare_suggestion(self, rr: RideRequest) -> dict[str, Any]:
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
        suggestion = self._fare_suggestion(self.get_ride_request(connection.ride_request_id))
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

    def changes_version(self, user_id: str) -> str:
        """A token that changes whenever this user's connections or notifications
        do, from three index-backed MAX() lookups. Clients poll this instead of
        downloading every connection with its full serialization."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT
                     (SELECT MAX(c.updated_at) FROM connections c
                       JOIN ride_requests rr ON rr.id = c.ride_request_id WHERE rr.rider_id = %(u)s) AS as_rider,
                     (SELECT MAX(c.updated_at) FROM connections c
                       JOIN driver_trips dt ON dt.id = c.driver_trip_id WHERE dt.driver_id = %(u)s) AS as_driver,
                     (SELECT MAX(created_at) FROM notifications WHERE user_id = %(u)s) AS notified""",
                {"u": user_id},
            )
            r = cur.fetchone()
        return "|".join(v.isoformat() if v else "" for v in (r["as_rider"], r["as_driver"], r["notified"]))

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

    def rate_connection(self, user_id: str, connection_id: str, stars: int, comment: str | None,
                        tags: list[str] | None = None) -> dict[str, Any]:
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only participants can rate this ride", 403)
        if connection.status != "completed":
            raise DomainError("You can rate a ride once it's completed")
        if not 1 <= stars <= 5:
            raise DomainError("Rating must be 1 to 5 stars")
        tags = sorted(set(tags or []))
        if any(t not in ALLOWED_RATING_TAGS for t in tags):
            raise DomainError(f"Rating tags must be among: {', '.join(sorted(ALLOWED_RATING_TAGS))}")
        ratee = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        rating = {
            "id": new_id("rtg"), "connection_id": connection_id, "rater_id": user_id,
            "ratee_id": ratee, "stars": stars, "comment": (comment or "").strip() or None,
            "tags": tags, "created_at": now_utc(),
        }
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO ratings (id, connection_id, rater_id, ratee_id, stars, comment, tags, created_at)
                   VALUES (%(id)s, %(connection_id)s, %(rater_id)s, %(ratee_id)s, %(stars)s, %(comment)s,
                           %(tags)s, %(created_at)s)
                   ON CONFLICT (connection_id, rater_id) DO UPDATE
                   SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, tags = EXCLUDED.tags,
                       created_at = EXCLUDED.created_at""",
                rating,
            )
        self._invalidate_stats(ratee)
        return rating

    def my_rating_for(self, user_id: str, connection_id: str) -> int | None:
        hit = self._memo_get("rating", f"{connection_id}:{user_id}")
        if hit is not None:
            return hit or None
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT stars FROM ratings WHERE connection_id = %s AND rater_id = %s",
                        (connection_id, user_id))
            row = cur.fetchone()
            return row["stars"] if row else None

    STATS_TTL_SECONDS = 60

    def user_stats(self, user_id: str) -> dict[str, Any]:
        """Public trust signals: average stars, number of ratings, completed rides
        (as driver or passenger) and the admin-set ID check."""
        hit = self._memo_get("stats", user_id)
        if hit is not None:
            return hit
        cached = self._stats_cache.get(user_id)
        if cached and cached[0] > monotonic():
            return self._memo_put("stats", user_id, dict(cached[1]))
        with get_conn() as conn:
            stats = self._load_user_stats(self._cur(conn), [user_id])[user_id]
        self._stats_cache[user_id] = (monotonic() + self.STATS_TTL_SECONDS, stats)
        return self._memo_put("stats", user_id, dict(stats))

    def _invalidate_stats(self, *user_ids: str) -> None:
        for u in user_ids:
            self._stats_cache.pop(u, None)

    @staticmethod
    def _load_user_stats(cur, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        # A connection never has the same person on both sides, so the rider-side
        # and driver-side completed counts add up without double counting, and
        # each half can use its own index instead of an OR across a join.
        # Replies are connections this person was asked to answer (they didn't
        # start it), measured from creation to accept/decline.
        cur.execute(
            """SELECT u.id,
                 (SELECT AVG(stars) FROM ratings WHERE ratee_id = u.id) AS rating_avg,
                 (SELECT COUNT(*) FROM ratings WHERE ratee_id = u.id) AS rating_count,
                 (SELECT COUNT(*) FROM connections c JOIN ride_requests rr ON rr.id = c.ride_request_id
                   WHERE c.status = 'completed' AND rr.rider_id = u.id)
                 + (SELECT COUNT(*) FROM connections c JOIN driver_trips dt ON dt.id = c.driver_trip_id
                   WHERE c.status = 'completed' AND dt.driver_id = u.id) AS completed_trips,
                 u.id_verified,
                 replies.n AS replies_count, replies.median_minutes
               FROM users u
               LEFT JOIN LATERAL (
                   SELECT COUNT(*) AS n,
                          percentile_cont(0.5) WITHIN GROUP (ORDER BY mins) AS median_minutes
                   FROM (
                       SELECT EXTRACT(EPOCH FROM c.responded_at - c.created_at) / 60 AS mins
                       FROM connections c JOIN ride_requests rr ON rr.id = c.ride_request_id
                       WHERE rr.rider_id = u.id AND c.initiator_user_id <> u.id AND c.responded_at IS NOT NULL
                       UNION ALL
                       SELECT EXTRACT(EPOCH FROM c.responded_at - c.created_at) / 60
                       FROM connections c JOIN driver_trips dt ON dt.id = c.driver_trip_id
                       WHERE dt.driver_id = u.id AND c.initiator_user_id <> u.id AND c.responded_at IS NOT NULL
                   ) m
               ) replies ON TRUE
               WHERE u.id = ANY(%s)""",
            (user_ids,),
        )
        stats: dict[str, dict[str, Any]] = {}
        for r in cur.fetchall():
            avg = r["rating_avg"]
            median = r["median_minutes"]
            stats[r["id"]] = {
                "rating_avg": round(float(avg), 1) if avg is not None else None,
                "rating_count": int(r["rating_count"]),
                "completed_trips": int(r["completed_trips"]),
                "id_verified": bool(r["id_verified"]),
                # Only quoted once there are enough replies for it to mean something.
                "reply_median_minutes": max(1, round(float(median))) if median is not None and r["replies_count"] >= MIN_REPLIES_FOR_STAT else None,
                # The redesign's field: quoted from the first reply.
                "median_response_minutes": max(1, round(float(median))) if median is not None else None,
            }
        for uid in user_ids:  # unknown ids keep the old all-empty answer
            stats.setdefault(uid, {"rating_avg": None, "rating_count": 0, "completed_trips": 0,
                                   "id_verified": False, "reply_median_minutes": None,
                                   "median_response_minutes": None})
        # The reply time is also served under the redesign's name, plus each
        # person's most-given feedback chips ("On time", "Clean car", ...).
        cur.execute(
            """SELECT ratee_id, tag, COUNT(*) AS n FROM ratings, unnest(tags) AS tag
               WHERE ratee_id = ANY(%s) GROUP BY ratee_id, tag""",
            (user_ids,),
        )
        tags: dict[str, list[tuple[int, str]]] = {}
        for r in cur.fetchall():
            tags.setdefault(r["ratee_id"], []).append((-int(r["n"]), r["tag"]))
        for uid, st in stats.items():
            st["top_rating_tags"] = [{"tag": t, "count": -n} for n, t in sorted(tags.get(uid, []))[:3]]
        return stats

    def set_id_verified(self, target_user_id: str, verified: bool) -> User:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE users SET id_verified = %s WHERE id = %s RETURNING *", (verified, target_user_id))
            row = cur.fetchone()
            if not row:
                raise DomainError("User not found", 404)
        self._invalidate_stats(target_user_id)
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

    def start_trip(self, user_id: str, connection_id: str, now: datetime | None = None) -> Connection:
        """Driver sets off for the pickup: allowed from START_TRIP_EARLY before
        the departure time (any time on the day if the trip has none), and the
        passenger is told. Tapping again is harmless and does not re-notify."""
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id != trip.driver_id:
            raise DomainError("Only the driver can start the trip", 403)
        if connection.status != "accepted":
            raise DomainError("Only accepted rides can be started")
        if connection.driver_started_at is not None:
            return connection
        local_now = now or datetime.now()
        opens = datetime.combine(trip.target_date, trip.departure_time or time.min)
        opens -= START_TRIP_EARLY if trip.departure_time else timedelta(0)
        if local_now < opens:
            when = opens.strftime("%b %d, %H:%M") if trip.departure_time else trip.target_date.isoformat()
            raise DomainError(f"Too early to start this trip. You can start it from {when}.", 409)
        at = now_utc()
        with get_conn() as conn:
            self._cur(conn).execute(
                "UPDATE connections SET driver_started_at = %s WHERE id = %s AND driver_started_at IS NULL",
                (at, connection_id))
        connection.driver_started_at = at
        driver = self.get_profile(trip.driver_id)
        self.notify(rr.rider_id, "driver_on_the_way", "Your driver is on the way",
                    f"{driver.display_name if driver else 'Your driver'} has started the trip to your pickup.",
                    related_id=connection_id)
        return connection

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

    def verify_ride_pin(self, user_id: str, connection_id: str, pin: str) -> Connection:
        """The driver enters the PIN the rider reads out, so both know they've
        got the right car / the right person before the ride starts."""
        connection = self.get_connection(connection_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id != trip.driver_id:
            raise DomainError("Only the driver can confirm the ride PIN", 403)
        if connection.status != "accepted" or not connection.ride_pin:
            raise DomainError("Only accepted rides have a PIN")
        if not secrets.compare_digest(pin.strip(), connection.ride_pin):
            raise DomainError("That PIN doesn't match — ask your rider to check it", 409)
        at = now_utc()
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("UPDATE connections SET pin_verified_at = %s WHERE id = %s", (at, connection_id))
        connection.pin_verified_at = at
        return connection

    # ─── Onboarding ───────────────────────────────────────────────────────────

    def complete_onboarding(self, user_id: str) -> User:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE users SET onboarded_at = COALESCE(onboarded_at, %s) WHERE id = %s RETURNING *",
                (now_utc(), user_id),
            )
            return _row_to_user(cur.fetchone())

    # ─── Ride preferences ─────────────────────────────────────────────────────

    _DEFAULT_PREFERENCES: dict[str, Any] = {
        "max_walk_minutes": None, "vibes": [], "verified_only": False,
        "women_only": False, "coworkers_first": False, "route_checkins": True,
    }

    def get_ride_preferences(self, user_id: str) -> dict[str, Any]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM ride_preferences WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
        if not row:
            return {**self._DEFAULT_PREFERENCES, "vibes": []}
        return {k: (list(row[k] or []) if k == "vibes" else row[k]) for k in self._DEFAULT_PREFERENCES}

    def update_ride_preferences(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        """Partial update: keys not sent keep their stored (or default) value."""
        prefs = {**self.get_ride_preferences(user_id),
                 **{k: v for k, v in data.items() if k in self._DEFAULT_PREFERENCES}}
        prefs["vibes"] = sorted(set(prefs["vibes"] or []))
        if any(v not in ALLOWED_VIBES for v in prefs["vibes"]):
            raise DomainError(f"Ride vibes must be among: {', '.join(sorted(ALLOWED_VIBES))}")
        walk = prefs["max_walk_minutes"]
        if walk is not None and not 1 <= int(walk) <= 60:
            raise DomainError("Max walk must be between 1 and 60 minutes")
        if prefs["women_only"]:
            profile = self.get_profile(user_id)
            if not profile or profile.gender != "woman":
                raise DomainError("Women-only rides are available to women. Add your gender in your profile to turn this on.", 403)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO ride_preferences (user_id, max_walk_minutes, vibes, verified_only,
                       women_only, coworkers_first, route_checkins, updated_at)
                   VALUES (%(user_id)s, %(max_walk_minutes)s, %(vibes)s, %(verified_only)s,
                           %(women_only)s, %(coworkers_first)s, %(route_checkins)s, %(updated_at)s)
                   ON CONFLICT (user_id) DO UPDATE SET
                       max_walk_minutes = EXCLUDED.max_walk_minutes, vibes = EXCLUDED.vibes,
                       verified_only = EXCLUDED.verified_only, women_only = EXCLUDED.women_only,
                       coworkers_first = EXCLUDED.coworkers_first, route_checkins = EXCLUDED.route_checkins,
                       updated_at = EXCLUDED.updated_at""",
                {**prefs, "user_id": user_id, "updated_at": now_utc()},
            )
        return prefs

    # ─── Saved places (Home, Work, …) ─────────────────────────────────────────

    def list_saved_places(self, user_id: str) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT * FROM saved_places WHERE user_id = %s
                   ORDER BY CASE kind WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, created_at""",
                (user_id,),
            )
            return [dict(r) for r in cur.fetchall()]

    def save_place(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        """Home and Work are one each: saving again moves them."""
        kind = data.get("kind") or "other"
        if kind not in {"home", "work", "other"}:
            raise DomainError("Place kind must be home, work or other")
        self.get_location(data["location_id"])
        label = (data.get("label") or "").strip() or kind.capitalize()
        place = {"id": new_id("plc"), "user_id": user_id, "kind": kind, "label": label[:40],
                 "location_id": data["location_id"], "created_at": now_utc()}
        with get_conn() as conn:
            cur = self._cur(conn)
            if kind in {"home", "work"}:
                cur.execute("DELETE FROM saved_places WHERE user_id = %s AND kind = %s", (user_id, kind))
            else:
                cur.execute("SELECT COUNT(*) AS n FROM saved_places WHERE user_id = %s", (user_id,))
                if cur.fetchone()["n"] >= MAX_SAVED_PLACES:
                    raise DomainError(f"You can save up to {MAX_SAVED_PLACES} places")
            cur.execute(
                """INSERT INTO saved_places (id, user_id, kind, label, location_id, created_at)
                   VALUES (%(id)s, %(user_id)s, %(kind)s, %(label)s, %(location_id)s, %(created_at)s)""",
                place,
            )
        return place

    def delete_saved_place(self, user_id: str, place_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("DELETE FROM saved_places WHERE id = %s AND user_id = %s", (place_id, user_id))
            if cur.rowcount == 0:
                raise DomainError("Place not found", 404)

    # ─── Settling up (outside the app) ────────────────────────────────────────

    def get_settlement_preference(self, user_id: str) -> dict[str, Any] | None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT method, handle, updated_at FROM settlement_preferences WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            return dict(row) if row else None

    def set_settlement_preference(self, user_id: str, method: str, handle: str | None) -> dict[str, Any]:
        if method not in ALLOWED_SETTLEMENT_METHODS:
            raise DomainError(f"Settle-up method must be one of: {', '.join(sorted(ALLOWED_SETTLEMENT_METHODS))}")
        handle = (handle or "").strip() or None
        if handle and len(handle) > 60:
            raise DomainError("Keep the handle under 60 characters")
        if method == "cash":
            handle = None
        pref = {"method": method, "handle": handle, "updated_at": now_utc()}
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO settlement_preferences (user_id, method, handle, updated_at)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (user_id) DO UPDATE SET method = EXCLUDED.method,
                       handle = EXCLUDED.handle, updated_at = EXCLUDED.updated_at""",
                (user_id, method, handle, pref["updated_at"]),
            )
        return pref

    # ─── Receipts ─────────────────────────────────────────────────────────────

    def _write_receipt(self, connection: Connection, rr: RideRequest, trip: DriverTrip) -> None:
        """Snapshot of what was settled on completion (see _settle_fare): the
        passenger's own leg, the gas it took, and the fare actually paid."""
        fare = self.connection_fare(connection)
        driver = self.get_profile(trip.driver_id)
        vehicle = self.get_vehicle(trip.driver_id)
        settle = self.get_settlement_preference(trip.driver_id)
        seats = max(1, rr.passenger_count)
        amount_cents = fare["amount_cents"]
        # The fare is the gas for this leg, shared by nobody else in the party.
        gas_cost_cents = calculate_fare_cents(fare["distance_km"], 1)
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO trip_receipts (id, connection_id, rider_id, driver_id, driver_name, vehicle_label,
                       pickup_label, dropoff_label, trip_date, departure_time, completed_at, distance_km,
                       gas_cost_cents, split_between, seats, price_per_seat_cents, amount_cents,
                       settlement_method, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (connection_id) DO NOTHING""",
                (new_id("rcp"), connection.id, rr.rider_id, trip.driver_id,
                 driver.display_name if driver else None,
                 " ".join(filter(None, [vehicle.color, vehicle.make, vehicle.model])) or None if vehicle else None,
                 self.get_location(rr.pickup_location_id).label,
                 self.get_location(rr.destination_location_id).label,
                 trip.target_date, trip.departure_time, connection.completed_at,
                 fare["distance_km"], gas_cost_cents, 1, seats,
                 round(amount_cents / seats), amount_cents,
                 settle["method"] if settle else None, now_utc()),
            )

    def get_receipt(self, user_id: str, connection_id: str) -> dict[str, Any]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM trip_receipts WHERE connection_id = %s", (connection_id,))
            row = cur.fetchone()
        if not row or user_id not in {row["rider_id"], row["driver_id"]}:
            raise DomainError("Receipt not found", 404)
        return _receipt_view(row)

    def list_receipts(self, user_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT * FROM trip_receipts WHERE rider_id = %s OR driver_id = %s
                   ORDER BY completed_at DESC LIMIT %s""",
                (user_id, user_id, limit),
            )
            return [_receipt_view(r) for r in cur.fetchall()]

    # ─── Impact (Profile header, "This month" on arrival) ─────────────────────

    def user_impact(self, user_id: str, since: date | None = None) -> dict[str, Any]:
        """What sharing rides has done for this user, from their receipts:
        riders save the solo gas cost minus their share; drivers recoup the
        shares they collected. Regular buddies: people shared 3+ rides with."""
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT COUNT(*) AS trips,
                          COALESCE(SUM(CASE WHEN rider_id = %(u)s
                                            THEN GREATEST(0, gas_cost_cents - amount_cents)
                                            ELSE amount_cents END), 0) AS saved_cents,
                          COALESCE(SUM(distance_km), 0) AS shared_km
                   FROM trip_receipts
                   WHERE (rider_id = %(u)s OR driver_id = %(u)s)
                     AND (%(since)s::date IS NULL OR completed_at >= %(since)s::date)""",
                {"u": user_id, "since": since},
            )
            r = cur.fetchone()
            cur.execute(
                """SELECT COUNT(*) AS n FROM (
                       SELECT CASE WHEN rider_id = %(u)s THEN driver_id ELSE rider_id END AS partner
                       FROM trip_receipts WHERE rider_id = %(u)s OR driver_id = %(u)s
                       GROUP BY 1 HAVING COUNT(*) >= 3) p""",
                {"u": user_id},
            )
            regulars = cur.fetchone()["n"]
        return {
            "shared_trips": int(r["trips"]),
            "saved_cents": int(r["saved_cents"]),
            "shared_km": round(float(r["shared_km"]), 1),
            "regular_buddies": int(regulars),
            "since": since,
        }

    # ─── Ride buddies ("Ride with them again") ────────────────────────────────

    def add_buddy(self, user_id: str, buddy_id: str) -> None:
        if user_id == buddy_id:
            raise DomainError("You can't add yourself")
        self.user_for_id(buddy_id)
        with get_conn() as conn:
            cur = self._cur(conn)
            # Only people you've actually shared a completed ride with.
            cur.execute(
                """SELECT 1 FROM trip_receipts
                   WHERE (rider_id = %(a)s AND driver_id = %(b)s) OR (rider_id = %(b)s AND driver_id = %(a)s)
                   LIMIT 1""",
                {"a": user_id, "b": buddy_id},
            )
            if not cur.fetchone():
                raise DomainError("You can add someone after sharing a ride with them", 403)
            cur.execute(
                "INSERT INTO ride_buddies (user_id, buddy_id, created_at) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (user_id, buddy_id, now_utc()),
            )

    def remove_buddy(self, user_id: str, buddy_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("DELETE FROM ride_buddies WHERE user_id = %s AND buddy_id = %s", (user_id, buddy_id))

    def list_buddies(self, user_id: str) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """SELECT b.buddy_id AS user_id, p.display_name, p.photo_url, b.created_at
                   FROM ride_buddies b LEFT JOIN profiles p ON p.user_id = b.buddy_id
                   WHERE b.user_id = %s ORDER BY b.created_at DESC""",
                (user_id,),
            )
            return [dict(r) for r in cur.fetchall()]

    # ─── Emergency contacts ───────────────────────────────────────────────────

    def list_emergency_contacts(self, user_id: str) -> list[dict[str, Any]]:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT * FROM emergency_contacts WHERE user_id = %s ORDER BY created_at", (user_id,))
            return [dict(r) for r in cur.fetchall()]

    def add_emergency_contact(self, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
        name = (data.get("name") or "").strip()
        phone = (data.get("phone") or "").strip()
        share_mode = data.get("share_mode") or "every_trip"
        if not name:
            raise DomainError("Add the contact's name")
        if not _PHONE_RE.match(phone):
            raise DomainError("Enter a valid phone number")
        if share_mode not in ALLOWED_SHARE_MODES:
            raise DomainError("Share mode must be every_trip, night_only or off")
        contact = {"id": new_id("emc"), "user_id": user_id, "name": name[:60],
                   "relationship": ((data.get("relationship") or "").strip() or None),
                   "phone": phone, "share_mode": share_mode, "created_at": now_utc()}
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("SELECT COUNT(*) AS n FROM emergency_contacts WHERE user_id = %s", (user_id,))
            if cur.fetchone()["n"] >= MAX_EMERGENCY_CONTACTS:
                raise DomainError(f"You can add up to {MAX_EMERGENCY_CONTACTS} contacts")
            cur.execute(
                """INSERT INTO emergency_contacts (id, user_id, name, relationship, phone, share_mode, created_at)
                   VALUES (%(id)s, %(user_id)s, %(name)s, %(relationship)s, %(phone)s, %(share_mode)s, %(created_at)s)""",
                contact,
            )
        return contact

    def update_emergency_contact_share_mode(self, user_id: str, contact_id: str, share_mode: str) -> dict[str, Any]:
        if share_mode not in ALLOWED_SHARE_MODES:
            raise DomainError("Share mode must be every_trip, night_only or off")
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                "UPDATE emergency_contacts SET share_mode = %s WHERE id = %s AND user_id = %s RETURNING *",
                (share_mode, contact_id, user_id),
            )
            row = cur.fetchone()
            if not row:
                raise DomainError("Contact not found", 404)
            return dict(row)

    def delete_emergency_contact(self, user_id: str, contact_id: str) -> None:
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute("DELETE FROM emergency_contacts WHERE id = %s AND user_id = %s", (contact_id, user_id))
            if cur.rowcount == 0:
                raise DomainError("Contact not found", 404)

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

    def report_user(self, reporter_id: str, reported_user_id: str, reason: str,
                    category: str = "other", connection_id: str | None = None) -> Report:
        if reporter_id == reported_user_id:
            raise DomainError("Users cannot report themselves")
        if category not in ALLOWED_REPORT_CATEGORIES:
            raise DomainError(f"Report category must be one of: {', '.join(sorted(ALLOWED_REPORT_CATEGORIES))}")
        report = Report(
            id=new_id("rpt"), reporter_id=reporter_id,
            reported_user_id=reported_user_id, reason=reason, created_at=now_utc(),
            connection_id=connection_id, category=category,
        )
        with get_conn() as conn:
            cur = self._cur(conn)
            cur.execute(
                """INSERT INTO reports (id, reporter_id, reported_user_id, reason, created_at, connection_id, category)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (report.id, report.reporter_id, report.reported_user_id,
                 report.reason, report.created_at, report.connection_id, report.category),
            )
        return report

    def report_trip(self, user_id: str, connection_id: str, reason: str, category: str) -> Report:
        """"Report an issue with this trip": files against the other participant."""
        connection = self.get_connection(connection_id)
        rr = self.get_ride_request(connection.ride_request_id)
        trip = self.get_driver_trip(connection.driver_trip_id)
        if user_id not in {rr.rider_id, trip.driver_id}:
            raise DomainError("Only participants can report this trip", 403)
        other = trip.driver_id if user_id == rr.rider_id else rr.rider_id
        return self.report_user(user_id, other, reason, category=category, connection_id=connection_id)

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
            cur.execute(f"SELECT {_trip_columns()} FROM driver_trips WHERE id = %s", (trip_id,))
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
        return self.location_view_of(self.get_location(location_id), exact)

    @staticmethod
    def location_view_of(loc: Location, exact: bool) -> dict[str, Any]:
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
