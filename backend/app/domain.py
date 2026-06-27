from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from math import asin, cos, radians, sin, sqrt
from typing import Any, Literal
from uuid import uuid4


ListingStatus = Literal["open", "expired", "matched", "cancelled", "completed"]
ConnectionStatus = Literal["pending", "expired", "accepted", "declined", "cancelled", "completed"]
LuggageSize = Literal["none", "small", "medium", "large", "oversized"]
CarType = Literal["sedan", "suv", "van", "minivan", "truck", "other"]
PoolStatus = Literal["open", "full", "cancelled", "completed"]

ALLOWED_TAGS = {"airport", "student", "church", "college", "work", "event"}
ALLOWED_LUGGAGE: set[str] = {"none", "small", "medium", "large", "oversized"}
ALLOWED_CAR_TYPES: set[str] = {"sedan", "suv", "van", "minivan", "truck", "other"}

# Gas price defaults used for fare calculation
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
    """Fair charge per passenger based on distance, gas price, and fuel efficiency."""
    km_per_gallon = mpg * _KM_PER_MILE
    gas_cost_usd = (distance_km / km_per_gallon) * gas_price_per_gallon
    per_passenger = gas_cost_usd / max(1, passenger_count)
    return max(100, round(per_passenger * 100))


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
    car_type: str | None = None  # sedan, suv, van, minivan, truck, other
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
    luggage_size: str = "none"           # none, small, medium, large, oversized
    preferred_car_type: str | None = None  # preferred vehicle type


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
    luggage_capacity: str = "medium"     # max luggage size accepted
    car_type: str | None = None          # actual vehicle type


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


# ─── Community Pools ──────────────────────────────────────────────────────────

@dataclass
class Pool:
    id: str
    name: str
    organizer_id: str
    community_tag: str          # church, college, work, event, etc.
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
    role: str                   # organizer, driver, passenger
    joined_at: datetime


# ─── Live Driver Location ─────────────────────────────────────────────────────

@dataclass
class DriverLocation:
    user_id: str
    latitude: float
    longitude: float
    heading: float | None = None
    speed_kmh: float | None = None
    updated_at: datetime = field(default_factory=now_utc)


# ─── Store ────────────────────────────────────────────────────────────────────

class Store:
    def __init__(self) -> None:
        self.users: dict[str, User] = {}
        self.email_index: dict[str, str] = {}
        self.profiles: dict[str, Profile] = {}
        self.vehicles: dict[str, Vehicle] = {}
        self.locations: dict[str, Location] = {}
        self.ride_requests: dict[str, RideRequest] = {}
        self.driver_trips: dict[str, DriverTrip] = {}
        self.connections: dict[str, Connection] = {}
        self.messages: dict[str, list[Message]] = {}
        self.gas_splits: dict[str, list[GasSplitConfirmation]] = {}
        self.notifications: dict[str, list[Notification]] = {}
        self.blocks: set[tuple[str, str]] = set()
        self.reports: dict[str, Report] = {}
        # New collections
        self.pools: dict[str, Pool] = {}
        self.pool_memberships: dict[str, list[PoolMembership]] = {}  # keyed by pool_id
        self.driver_locations: dict[str, DriverLocation] = {}

    # ─── Auth ─────────────────────────────────────────────────────────────────

    def authenticate_email(self, email: str, display_name: str) -> User:
        normalized_email = email.strip().lower()
        normalized_name = display_name.strip()
        if not normalized_name:
            raise DomainError("Display name is required")
        if "@" not in normalized_email:
            raise DomainError("Enter a valid email address")
        user_id = self.email_index.get(normalized_email)
        if user_id is None:
            user_id = new_id("usr")
            user = User(
                id=user_id,
                email=normalized_email,
                email_domain=email_domain(normalized_email),
                provider="email",
                provider_subject=normalized_email,
                created_at=now_utc(),
            )
            self.users[user_id] = user
            self.email_index[normalized_email] = user_id
            self.profiles[user_id] = Profile(user_id=user_id, display_name=normalized_name)
        return self.users[user_id]

    def user_for_id(self, user_id: str) -> User:
        user = self.users.get(user_id)
        if user is None:
            raise DomainError("Invalid or expired token", 401)
        return user

    # ─── Profile ──────────────────────────────────────────────────────────────

    def update_profile(self, user_id: str, display_name: str, photo_url: str | None, bio: str | None) -> Profile:
        profile = self.profiles[user_id]
        profile.display_name = display_name
        profile.photo_url = photo_url
        profile.bio = bio
        return profile

    def upload_photo(self, user_id: str, photo_data_url: str) -> Profile:
        """Store a base64 data URL as the profile photo."""
        if not photo_data_url.startswith("data:image/"):
            raise DomainError("Photo must be a valid image data URL")
        profile = self.profiles[user_id]
        profile.photo_url = photo_data_url
        profile.photo_verified = True
        return profile

    # ─── Vehicle ──────────────────────────────────────────────────────────────

    def update_vehicle(self, user_id: str, data: dict[str, Any]) -> Vehicle:
        vehicle = self.vehicles.get(user_id, Vehicle(user_id=user_id))
        for field_name in (
            "make", "model", "color", "seats", "car_type",
            "has_license", "has_insurance", "has_good_driving_record",
        ):
            if field_name in data and data[field_name] is not None:
                setattr(vehicle, field_name, data[field_name])
        if data.get("car_type") and data["car_type"] not in ALLOWED_CAR_TYPES:
            raise DomainError(f"Invalid car type: {data['car_type']}")
        self.vehicles[user_id] = vehicle
        return vehicle

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
        self.locations[loc.id] = loc
        return loc

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
        request = RideRequest(
            id=new_id("rrq"),
            rider_id=rider_id,
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            target_date=data["target_date"],
            flexibility=data["flexibility"],
            passenger_count=passenger_count,
            tags=tags,
            status="open",
            created_at=now_utc(),
            luggage_size=luggage_size,
            preferred_car_type=preferred_car_type,
        )
        self.ride_requests[request.id] = request
        return request

    def cancel_ride_request(self, user_id: str, request_id: str) -> RideRequest:
        request = self.ride_requests[request_id]
        if request.rider_id != user_id:
            raise DomainError("Only the rider can cancel this request", 403)
        request.status = "cancelled"
        return request

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
            id=new_id("trp"),
            driver_id=driver_id,
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            target_date=data["target_date"],
            flexibility=data["flexibility"],
            seats_available=seats_available,
            seats_reserved=0,
            tags=tags,
            status="open",
            created_at=now_utc(),
            luggage_capacity=luggage_capacity,
            car_type=car_type,
        )
        self.driver_trips[trip.id] = trip
        return trip

    def cancel_driver_trip(self, user_id: str, trip_id: str) -> DriverTrip:
        trip = self.driver_trips[trip_id]
        if trip.driver_id != user_id:
            raise DomainError("Only the driver can cancel this trip", 403)
        trip.status = "cancelled"
        return trip

    def expire_listings(self, today: date) -> None:
        for listing in [*self.ride_requests.values(), *self.driver_trips.values()]:
            if listing.status == "open" and listing.target_date < today:
                listing.status = "expired"

    # ─── Search ───────────────────────────────────────────────────────────────

    def search_driver_trips(self, user_id: str, query: dict[str, Any]) -> list[DriverTrip]:
        return [
            trip
            for trip in self.driver_trips.values()
            if trip.driver_id != user_id
            and not self.is_blocked(user_id, trip.driver_id)
            and self._listing_matches(trip, query)
        ]

    def search_ride_requests(self, user_id: str, query: dict[str, Any]) -> list[RideRequest]:
        return [
            request
            for request in self.ride_requests.values()
            if request.rider_id != user_id
            and not self.is_blocked(user_id, request.rider_id)
            and self._listing_matches(request, query)
        ]

    # ─── Connections ──────────────────────────────────────────────────────────

    def create_connection(self, user_id: str, data: dict[str, Any]) -> Connection:
        request = self.ride_requests[data["ride_request_id"]]
        trip = self.driver_trips[data["driver_trip_id"]]
        if request.status != "open" or trip.status != "open":
            raise DomainError("Connections require open listings")
        if user_id not in {request.rider_id, trip.driver_id}:
            raise DomainError("Only the rider or driver can initiate this connection", 403)
        if self.is_blocked(request.rider_id, trip.driver_id):
            raise DomainError("Blocked users cannot connect", 403)
        connection = Connection(
            id=new_id("con"),
            ride_request_id=request.id,
            driver_trip_id=trip.id,
            initiator_user_id=user_id,
            status="pending",
            created_at=now_utc(),
            updated_at=now_utc(),
        )
        self.connections[connection.id] = connection
        self.messages[connection.id] = []
        recipient = trip.driver_id if user_id == request.rider_id else request.rider_id
        self.notify(recipient, "connection_received", "New carpool interest", "You have a new pending connection.")
        return connection

    def transition_connection(self, user_id: str, connection_id: str, action: str) -> Connection:
        connection = self.connections[connection_id]
        request = self.ride_requests[connection.ride_request_id]
        trip = self.driver_trips[connection.driver_trip_id]
        participants = {request.rider_id, trip.driver_id}
        if user_id not in participants:
            raise DomainError("Only participants can update this connection", 403)
        if action == "accept":
            if connection.status != "pending":
                raise DomainError("Only pending connections can be accepted")
            self._reserve_seats(trip, request.passenger_count)
            connection.status = "accepted"
            request.status = "matched"
            trip.status = "matched" if trip.seats_reserved >= trip.seats_available else "open"
            self.notify(connection.initiator_user_id, "connection_accepted", "Connection accepted", "Your carpool connection was accepted.")
            self.notify(request.rider_id, "chat_unlocked", "Chat unlocked", "Full chat is available for your accepted connection.")
            self.notify(trip.driver_id, "chat_unlocked", "Chat unlocked", "Full chat is available for your accepted connection.")
        elif action == "decline":
            if connection.status != "pending":
                raise DomainError("Only pending connections can be declined")
            connection.status = "declined"
        elif action == "cancel":
            if connection.status == "accepted":
                self._release_seats(trip, request.passenger_count)
                if trip.status == "matched":
                    trip.status = "open"
            connection.status = "cancelled"
        elif action == "complete":
            if connection.status != "accepted":
                raise DomainError("Only accepted connections can be completed")
            if user_id not in connection.completed_confirmed_by:
                connection.completed_confirmed_by.append(user_id)
            connection.status = "completed"
            request.status = "completed"
            trip.status = "completed"
        else:
            raise DomainError(f"Unsupported connection action: {action}")
        connection.updated_at = now_utc()
        return connection

    def expire_connections(self, today: date) -> None:
        for connection in self.connections.values():
            if connection.status != "pending":
                continue
            request = self.ride_requests[connection.ride_request_id]
            trip = self.driver_trips[connection.driver_trip_id]
            if request.target_date < today or trip.target_date < today:
                connection.status = "expired"
                connection.updated_at = now_utc()

    # ─── Messages ─────────────────────────────────────────────────────────────

    def add_message(self, user_id: str, connection_id: str, data: dict[str, Any]) -> Message:
        connection = self.connections[connection_id]
        request = self.ride_requests[connection.ride_request_id]
        trip = self.driver_trips[connection.driver_trip_id]
        if user_id not in {request.rider_id, trip.driver_id}:
            raise DomainError("Only participants can message", 403)
        if self.is_blocked(request.rider_id, trip.driver_id):
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
        message = Message(
            id=new_id("msg"),
            connection_id=connection_id,
            sender_id=user_id,
            content=content,
            kind=kind,
            created_at=now_utc(),
        )
        self.messages[connection_id].append(message)
        other_id = trip.driver_id if user_id == request.rider_id else request.rider_id
        self.notify(other_id, "chat_message", "New chat message", content)
        return message

    # ─── Gas Split / Fare ─────────────────────────────────────────────────────

    def suggest_gas_split(self, connection_id: str) -> dict[str, Any]:
        connection = self.connections[connection_id]
        request = self.ride_requests[connection.ride_request_id]
        trip = self.driver_trips[connection.driver_trip_id]
        pickup = self.locations[request.pickup_location_id]
        destination = self.locations[request.destination_location_id]
        distance_km = haversine_meters(pickup.latitude, pickup.longitude, destination.latitude, destination.longitude) / 1000
        passenger_count = max(1, request.passenger_count)
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
        connection = self.connections[connection_id]
        request = self.ride_requests[connection.ride_request_id]
        trip = self.driver_trips[connection.driver_trip_id]
        if user_id not in {request.rider_id, trip.driver_id}:
            raise DomainError("Only participants can confirm a split", 403)
        if connection.status not in {"accepted", "completed"}:
            raise DomainError("Gas split can only be confirmed for accepted or completed connections")
        confirmation = GasSplitConfirmation(
            id=new_id("gsc"),
            connection_id=connection_id,
            confirmer_id=user_id,
            amount_cents=int(data["amount_cents"]),
            currency=data.get("currency") or "USD",
            assumptions=data.get("assumptions") or {},
            created_at=now_utc(),
        )
        self.gas_splits.setdefault(connection_id, []).append(confirmation)
        other_id = trip.driver_id if user_id == request.rider_id else request.rider_id
        self.notify(other_id, "gas_split_confirmed", "Gas split confirmed", "A participant confirmed the gas split.")
        return confirmation

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
            id=new_id("pol"),
            name=name,
            organizer_id=organizer_id,
            community_tag=community_tag,
            trip_date=data["trip_date"],
            pickup_location_id=data["pickup_location_id"],
            destination_location_id=data["destination_location_id"],
            max_participants=max_participants,
            status="open",
            created_at=now_utc(),
            description=data.get("description"),
            seats_per_vehicle=int(data.get("seats_per_vehicle") or 4),
        )
        self.pools[pool.id] = pool
        self.pool_memberships[pool.id] = [
            PoolMembership(pool_id=pool.id, user_id=organizer_id, role="organizer", joined_at=now_utc())
        ]
        return pool

    def join_pool(self, user_id: str, pool_id: str, role: str = "passenger") -> PoolMembership:
        pool = self.pools.get(pool_id)
        if not pool:
            raise DomainError("Pool not found", 404)
        if pool.status != "open":
            raise DomainError("Pool is not open for new members")
        members = self.pool_memberships.get(pool_id, [])
        if any(m.user_id == user_id for m in members):
            raise DomainError("Already a member of this pool")
        if len(members) >= pool.max_participants:
            pool.status = "full"
            raise DomainError("Pool is full")
        membership = PoolMembership(pool_id=pool_id, user_id=user_id, role=role, joined_at=now_utc())
        self.pool_memberships.setdefault(pool_id, []).append(membership)
        if len(self.pool_memberships[pool_id]) >= pool.max_participants:
            pool.status = "full"
        self.notify(pool.organizer_id, "pool_joined", "New pool member", f"Someone joined your pool: {pool.name}")
        return membership

    def leave_pool(self, user_id: str, pool_id: str) -> None:
        pool = self.pools.get(pool_id)
        if not pool:
            raise DomainError("Pool not found", 404)
        members = self.pool_memberships.get(pool_id, [])
        original_len = len(members)
        self.pool_memberships[pool_id] = [m for m in members if m.user_id != user_id]
        if len(self.pool_memberships[pool_id]) == original_len:
            raise DomainError("User is not a member of this pool")
        if pool.status == "full":
            pool.status = "open"

    def list_pools(self, community_tag: str | None = None, trip_date: date | None = None) -> list[Pool]:
        return [
            p for p in self.pools.values()
            if p.status in {"open", "full"}
            and (community_tag is None or p.community_tag == community_tag)
            and (trip_date is None or p.trip_date == trip_date)
        ]

    # ─── Driver Location Tracking ─────────────────────────────────────────────

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
        """Return drivers with live locations within radius_meters of (lat, lng)."""
        results = []
        stale_cutoff = now_utc().replace(tzinfo=None)  # locations older than 5 min are stale
        for user_id, loc in self.driver_locations.items():
            dist = haversine_meters(lat, lng, loc.latitude, loc.longitude)
            if dist <= radius_meters:
                profile = self.profiles.get(user_id)
                vehicle = self.vehicles.get(user_id)
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
        """Return a route estimate using straight-line distance (no 3rd-party API)."""
        distance_km = haversine_meters(pickup_lat, pickup_lng, dest_lat, dest_lng) / 1000
        # Road distance is typically 1.3× the straight-line distance
        road_distance_km = round(distance_km * 1.3, 2)
        # Urban average including traffic: ~35 km/h
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
            id=new_id("ntf"),
            user_id=user_id,
            type=type_,
            title=title,
            body=body,
            created_at=now_utc(),
        )
        self.notifications.setdefault(user_id, []).append(notification)
        return notification

    # ─── Blocks / Reports ─────────────────────────────────────────────────────

    def block_user(self, blocker_id: str, blocked_id: str) -> None:
        if blocker_id == blocked_id:
            raise DomainError("Users cannot block themselves")
        self.blocks.add((blocker_id, blocked_id))

    def report_user(self, reporter_id: str, reported_user_id: str, reason: str) -> Report:
        if reporter_id == reported_user_id:
            raise DomainError("Users cannot report themselves")
        report = Report(
            id=new_id("rpt"),
            reporter_id=reporter_id,
            reported_user_id=reported_user_id,
            reason=reason,
            created_at=now_utc(),
        )
        self.reports[report.id] = report
        return report

    def is_blocked(self, user_a: str, user_b: str) -> bool:
        return (user_a, user_b) in self.blocks or (user_b, user_a) in self.blocks

    # ─── Views ────────────────────────────────────────────────────────────────

    def location_view(self, location_id: str, exact: bool) -> dict[str, Any]:
        loc = self.locations[location_id]
        base: dict[str, Any] = {"id": loc.id, "label": loc.label if exact else loc.approximate_label, "exact": exact}
        if exact:
            base.update({"latitude": loc.latitude, "longitude": loc.longitude})
        return base

    # ─── Private helpers ──────────────────────────────────────────────────────

    def _validate_location_ids(self, pickup_id: str, destination_id: str) -> None:
        if pickup_id not in self.locations or destination_id not in self.locations:
            raise DomainError("Pickup and destination locations are required")

    def _validate_tags(self, tags: list[str]) -> list[str]:
        invalid = set(tags) - ALLOWED_TAGS
        if invalid:
            raise DomainError(f"Unsupported tags: {', '.join(sorted(invalid))}")
        return sorted(set(tags))

    def _listing_matches(self, listing: RideRequest | DriverTrip, query: dict[str, Any]) -> bool:
        if listing.status != "open":
            return False
        if query.get("target_date") and listing.target_date != query["target_date"]:
            return False
        if query.get("tag") and query["tag"] not in listing.tags:
            return False
        # Car type filter: rider specifies preferred_car_type, driver has car_type
        if query.get("car_type"):
            if isinstance(listing, DriverTrip) and listing.car_type and listing.car_type != query["car_type"]:
                return False
        # Luggage filter: riders need capacity >= their luggage size
        if query.get("luggage_size"):
            luggage_order = ["none", "small", "medium", "large", "oversized"]
            if isinstance(listing, DriverTrip):
                needed = luggage_order.index(query["luggage_size"])
                capacity = luggage_order.index(listing.luggage_capacity)
                if capacity < needed:
                    return False
        destination = self.locations[listing.destination_location_id]
        pickup = self.locations[listing.pickup_location_id]
        if query.get("destination_latitude") is not None:
            destination_distance = haversine_meters(
                destination.latitude, destination.longitude,
                query["destination_latitude"], query["destination_longitude"],
            )
            if destination_distance > query.get("destination_radius_meters", 1000):
                return False
        if query.get("pickup_latitude") is not None:
            pickup_distance = haversine_meters(pickup.latitude, pickup.longitude, query["pickup_latitude"], query["pickup_longitude"])
            if pickup_distance > query.get("pickup_radius_meters", 5000):
                return False
        return True

    def _reserve_seats(self, trip: DriverTrip, passenger_count: int) -> None:
        if trip.seats_reserved + passenger_count > trip.seats_available:
            raise DomainError("Driver trip does not have enough available seats", 409)
        trip.seats_reserved += passenger_count

    def _release_seats(self, trip: DriverTrip, passenger_count: int) -> None:
        trip.seats_reserved = max(0, trip.seats_reserved - passenger_count)
