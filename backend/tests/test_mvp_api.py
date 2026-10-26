from __future__ import annotations

import base64
import json
import os
import threading
from datetime import UTC, date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from backend.app.domain import Store
from backend.app.main import Settings, create_app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://carpool:carpool@localhost:5434/carpool"
)

# ─── Fake Supabase Auth server ──────────────────────────────────────────────────────
# /auth/login now cryptographically verifies the Supabase Auth session JWT against a
# JWKS endpoint (issue 24) instead of trusting a client-supplied email. To test
# that for real without hitting the actual Supabase Auth service, this spins up a
# tiny local JWKS server and signs test tokens with a real Ed25519 keypair —
# exercising the exact same verification code path production traffic will.

_NEON_AUTH_PRIVATE_KEY = Ed25519PrivateKey.generate()
_NEON_AUTH_KID = "test-key-1"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


_NEON_AUTH_JWKS_BODY = json.dumps({
    "keys": [{
        "kty": "OKP", "crv": "Ed25519", "kid": _NEON_AUTH_KID, "use": "sig", "alg": "EdDSA",
        "x": _b64url(_NEON_AUTH_PRIVATE_KEY.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw,
        )),
    }],
}).encode()


class _JWKSHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/.well-known/jwks.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(_NEON_AUTH_JWKS_BODY)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass


_jwks_server = ThreadingHTTPServer(("127.0.0.1", 0), _JWKSHandler)
threading.Thread(target=_jwks_server.serve_forever, daemon=True).start()
TEST_NEON_AUTH_URL = f"http://127.0.0.1:{_jwks_server.server_port}"


def sign_supabase_token(*, email: str, name: str, sub: str | None = None, expired: bool = False) -> str:
    now = datetime.now(UTC)
    private_pem = _NEON_AUTH_PRIVATE_KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    payload = {
        "sub": sub or f"neon_{email}",
        "email": email,
        "name": name,
        "iss": TEST_NEON_AUTH_URL, "aud": "authenticated",
        "iat": now,
        "exp": now + (timedelta(minutes=-5) if expired else timedelta(hours=24)),
    }
    return pyjwt.encode(payload, private_pem, algorithm="EdDSA", headers={"kid": _NEON_AUTH_KID})


TEST_CRON_SECRET = "test-cron-secret"
CRON_HEADERS = {"Authorization": f"Bearer {TEST_CRON_SECRET}"}


def client() -> TestClient:
    settings = Settings(
        database_url=TEST_DATABASE_URL, supabase_url=TEST_NEON_AUTH_URL, supabase_jwks_path="/.well-known/jwks.json", cron_secret=TEST_CRON_SECRET,
    )
    return TestClient(create_app(store=Store(TEST_DATABASE_URL), settings=settings))


def auth(client: TestClient, email: str, name: str) -> tuple[dict, dict[str, str]]:
    token = sign_supabase_token(email=email, name=name)
    response = client.post("/auth/login", json={"token": token})
    assert response.status_code == 200
    body = response.json()
    token = body["access_token"]
    assert token.count(".") == 2
    return body["user"], {"Authorization": f"Bearer {token}"}


def location(client: TestClient, headers: dict[str, str], label: str, lat: float, lng: float) -> dict:
    response = client.post(
        "/locations",
        headers=headers,
        json={"label": label, "latitude": lat, "longitude": lng, "provider": "mock", "provider_place_id": label},
    )
    assert response.status_code == 200
    return response.json()


def make_request_and_trip(
    client: TestClient, passenger_count: int = 2, seats_available: int = 2
) -> tuple[dict, dict[str, str], dict, dict[str, str], dict, dict]:
    passenger, rider_headers = auth(client, "passenger@example.edu", "Riley Passenger")
    driver, driver_headers = auth(client, "driver@example.com", "Dee Driver")
    pickup = location(client, rider_headers, "1 Main St, Berkeley, CA", 37.8715, -122.2730)
    destination = location(client, rider_headers, "SFO Terminal 2, San Francisco, CA", 37.6213, -122.3790)
    ride_request = client.post(
        "/ride-requests",
        headers=rider_headers,
        json={
            "pickup_location_id": pickup["id"],
            "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(),
            "flexibility": "Friday morning",
            "passenger_count": passenger_count,
            "tags": ["airport"],
        },
    ).json()
    driver_pickup = location(client, driver_headers, "Downtown Berkeley, CA", 37.8700, -122.2700)
    driver_trip = client.post(
        "/driver-trips",
        headers=driver_headers,
        json={
            "pickup_location_id": driver_pickup["id"],
            "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(),
            "flexibility": "Friday flexible",
            "seats_available": seats_available,
            "tags": ["airport"],
        },
    ).json()
    return passenger, rider_headers, driver, driver_headers, ride_request, driver_trip


def test_healthcheck_reports_postgres_backed_database() -> None:
    response = client().get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["database"] == "postgres"


def test_email_sign_in_issues_jwt_and_stores_email_domain() -> None:
    api = client()

    user, headers = auth(api, "ada@berkeley.edu", "Ada Lovelace")
    returning_user, _ = auth(api, "ada@berkeley.edu", "Ignored Name")
    me = api.get("/me", headers=headers).json()
    invalid = api.get("/me", headers={"Authorization": "Bearer not.a.jwt"})

    assert user["id"] == returning_user["id"]
    assert me["email"] == "ada@berkeley.edu"
    assert me["email_domain"] == "berkeley.edu"
    assert me["profile"]["display_name"] == "Ada Lovelace"
    assert invalid.status_code == 401


def test_login_rejects_a_token_not_signed_by_the_supabase_key() -> None:
    api = client()
    forged_key = Ed25519PrivateKey.generate()
    now = datetime.now(UTC)
    forged_pem = forged_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    forged_token = pyjwt.encode(
        {"sub": "neon_attacker", "email": "victim@berkeley.edu", "name": "Attacker",
         "iss": TEST_NEON_AUTH_URL, "aud": "authenticated", "iat": now, "exp": now + timedelta(hours=24)},
        forged_pem, algorithm="EdDSA", headers={"kid": _NEON_AUTH_KID},
    )

    response = api.post("/auth/login", json={"token": forged_token})

    assert response.status_code == 401


def test_login_rejects_an_expired_supabase_token() -> None:
    api = client()
    expired_token = sign_supabase_token(email="ada@berkeley.edu", name="Ada Lovelace", expired=True)

    response = api.post("/auth/login", json={"token": expired_token})

    assert response.status_code == 401


def test_login_rejects_a_token_with_no_email_claim() -> None:
    api = client()
    now = datetime.now(UTC)
    private_pem = _NEON_AUTH_PRIVATE_KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    no_email_token = pyjwt.encode(
        {"sub": "neon_no_email", "iss": TEST_NEON_AUTH_URL, "aud": "authenticated", "iat": now, "exp": now + timedelta(hours=24)},
        private_pem, algorithm="EdDSA", headers={"kid": _NEON_AUTH_KID},
    )

    response = api.post("/auth/login", json={"token": no_email_token})

    assert response.status_code == 401


def test_login_rejects_garbage_input() -> None:
    api = client()

    response = api.post("/auth/login", json={"token": "not.a.jwt"})

    assert response.status_code == 401


def test_profile_and_driver_readiness_are_editable_without_document_uploads() -> None:
    api = client()
    _, headers = auth(api, "driver@example.com", "Driver")

    profile = api.patch(
        "/me/profile",
        headers=headers,
        json={"display_name": "Updated Driver", "photo_url": "https://example.com/p.png", "bio": "Campus commuter"},
    ).json()
    vehicle = api.put(
        "/me/driver-readiness",
        headers=headers,
        json={
            "make": "Toyota",
            "model": "Prius",
            "color": "Blue",
            "seats": 3,
            "has_license": True,
            "has_insurance": True,
            "has_good_driving_record": True,
        },
    ).json()

    assert profile["display_name"] == "Updated Driver"
    assert vehicle["has_license"] is True
    assert "document" not in vehicle


def test_profile_stores_optional_interests_and_nationality() -> None:
    api = client()
    _, headers = auth(api, "traveler@example.com", "Traveler")

    profile = api.patch(
        "/me/profile",
        headers=headers,
        json={
            "display_name": "Traveler",
            "interests": ["Bongo music", "hiking"],
            "nationality": "Kenyan",
        },
    ).json()
    me = api.get("/me", headers=headers).json()

    assert profile["interests"] == ["Bongo music", "hiking"]
    assert profile["nationality"] == "Kenyan"
    assert me["profile"]["interests"] == ["Bongo music", "hiking"]
    assert me["profile"]["nationality"] == "Kenyan"


def test_profile_interests_and_nationality_are_optional() -> None:
    api = client()
    _, headers = auth(api, "minimal@example.com", "Minimal")

    profile = api.patch("/me/profile", headers=headers, json={"display_name": "Minimal"}).json()

    assert profile["interests"] == []
    assert profile["nationality"] is None


def test_locations_are_normalized_and_can_be_shown_approximately() -> None:
    api = client()
    _, headers = auth(api, "user@example.com", "User")

    created = location(api, headers, "123 Exact St, Berkeley, CA", 37.87, -122.27)
    approximate = api.get(f"/locations/{created['id']}").json()
    exact = api.get(f"/locations/{created['id']}?exact=true", headers=headers).json()

    assert created["latitude"] == 37.87
    assert approximate == {"id": created["id"], "label": "Berkeley, CA", "exact": False, "general": False}
    assert exact["label"] == "123 Exact St, Berkeley, CA"
    assert exact["exact"] is True


def test_riders_and_drivers_publish_searchable_one_off_listings() -> None:
    api = client()
    _, rider_headers, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    trips = api.get(
        "/driver-trips/search",
        headers=rider_headers,
        params={
            "destination_latitude": 37.6213,
            "destination_longitude": -122.3790,
            "destination_radius_meters": 1000,
            "pickup_latitude": 37.8715,
            "pickup_longitude": -122.2730,
            "pickup_radius_meters": 5000,
            "target_date": date.today().isoformat(),
            "tag": "airport",
        },
    ).json()
    requests = api.get(
        "/ride-requests/search",
        headers=driver_headers,
        params={"destination_latitude": 37.6213, "destination_longitude": -122.3790, "tag": "airport"},
    ).json()

    assert trips[0]["id"] == driver_trip["id"]
    assert trips[0]["destination"]["exact"] is False
    assert requests[0]["id"] == ride_request["id"]

    # Search/listing cards must show the actual poster's name, not a generic
    # "Driver"/"Rider" placeholder.
    assert trips[0]["driver_name"] == "Dee Driver"
    assert requests[0]["rider_name"] == "Riley Passenger"


def test_driver_trips_and_ride_requests_carry_an_optional_free_text_note() -> None:
    # Lets a driver write "Heading to SFO, anyone going the same way?" or a
    # passenger write "Need a ride Friday morning, one small bag" on their own
    # listing — free text alongside the structured fields, not a replacement
    # for them.
    api = client()
    _, rider_headers = auth(api, "notes-passenger@example.edu", "Nora Passenger")
    _, driver_headers = auth(api, "notes-driver@example.com", "Dana Driver")
    pickup = location(api, rider_headers, "Cambridge", 42.3736, -71.1097)
    destination = location(api, rider_headers, "Providence, RI", 41.8240, -71.4128)

    trip = api.post(
        "/driver-trips", headers=driver_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(), "flexibility": "morning", "seats_available": 2,
            "tags": [], "notes": "Heading to Providence, anyone going the same way?",
        },
    ).json()
    request = api.post(
        "/ride-requests", headers=rider_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(), "flexibility": "morning", "passenger_count": 1,
            "tags": [], "notes": "  Need a ride Friday morning, one small bag.  ",
        },
    ).json()
    no_note_trip = api.post(
        "/driver-trips", headers=driver_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(), "flexibility": "morning", "seats_available": 1, "tags": [],
        },
    ).json()

    assert trip["notes"] == "Heading to Providence, anyone going the same way?"
    # Leading/trailing whitespace is trimmed server-side, same as any other
    # free-text field would be.
    assert request["notes"] == "Need a ride Friday morning, one small bag."
    assert no_note_trip["notes"] is None

    my_trips = api.get("/me/driver-trips", headers=driver_headers).json()
    assert next(t for t in my_trips if t["id"] == trip["id"])["notes"] == trip["notes"]

    searched_trips = api.get("/driver-trips/search", headers=rider_headers).json()
    assert next(t for t in searched_trips if t["id"] == trip["id"])["notes"] == trip["notes"]

    too_long = api.post(
        "/driver-trips", headers=driver_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(), "flexibility": "morning", "seats_available": 1,
            "tags": [], "notes": "x" * 501,
        },
    )
    assert too_long.status_code == 422


def test_search_excludes_the_searching_users_own_listings() -> None:
    # Discover is meant to surface *other* people's rides. Without an
    # explicit self-exclusion clause, a driver's own trip (or a passenger's own
    # request) would show up in their own feed alongside everyone else's —
    # "My Listings" is the dedicated place to manage your own posts.
    api = client()
    _, rider_headers, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    trips = api.get("/driver-trips/search", headers=driver_headers).json()
    requests = api.get("/ride-requests/search", headers=rider_headers).json()

    assert driver_trip["id"] not in {t["id"] for t in trips}
    assert ride_request["id"] not in {r["id"] for r in requests}


def test_search_excludes_listings_with_a_past_target_date() -> None:
    # Search must never show a stale listing on its own, regardless of
    # whether the hourly expire sweep has run yet — a driver/passenger shouldn't
    # see (or be offered) a ride for a date that's already passed. Use a date
    # unambiguously outside the 1-day timezone-safety grace period (see the
    # next test for why exactly "yesterday" is deliberately still visible).
    api = client()
    _, rider_headers = auth(api, "past-passenger@example.edu", "Past Passenger")
    _, driver_headers = auth(api, "past-driver@example.com", "Past Driver")
    pickup = location(api, rider_headers, "Cambridge", 42.3736, -71.1097)
    destination = location(api, rider_headers, "Providence, RI", 41.8240, -71.4128)
    clearly_past = (date.today() - timedelta(days=3)).isoformat()

    past_request = api.post(
        "/ride-requests", headers=rider_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": clearly_past, "flexibility": "morning", "passenger_count": 1, "tags": [],
        },
    ).json()
    past_trip = api.post(
        "/driver-trips", headers=driver_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": clearly_past, "flexibility": "morning", "seats_available": 2, "tags": [],
        },
    ).json()

    trips = api.get("/driver-trips/search", headers=rider_headers).json()
    requests = api.get("/ride-requests/search", headers=driver_headers).json()

    assert past_trip["id"] not in {t["id"] for t in trips}
    assert past_request["id"] not in {r["id"] for r in requests}

    # Search should also actually archive them (flip status), not just hide
    # them from this result set — so it doesn't depend on the hourly cron
    # sweep having run to keep "My Listings" and other views honest too.
    my_trips = api.get("/me/driver-trips", headers=driver_headers).json()
    my_requests = api.get("/me/ride-requests", headers=rider_headers).json()
    assert next(t for t in my_trips if t["id"] == past_trip["id"])["status"] == "expired"
    assert next(r for r in my_requests if r["id"] == past_request["id"])["status"] == "expired"


def test_search_keeps_yesterdays_listings_visible_as_a_timezone_safety_buffer() -> None:
    # Regression test: a listing dated "yesterday" by the DB server's (UTC)
    # clock can still be "today" for a passenger/driver west of UTC — which is
    # every US timezone. Without this buffer, refreshing the page in the
    # evening could make a same-day listing vanish (and get archived) purely
    # from a UTC-vs-local date mismatch, not because it actually expired.
    api = client()
    _, rider_headers = auth(api, "tz-passenger@example.edu", "TZ Passenger")
    _, driver_headers = auth(api, "tz-driver@example.com", "TZ Driver")
    pickup = location(api, rider_headers, "Cambridge", 42.3736, -71.1097)
    destination = location(api, rider_headers, "Providence, RI", 41.8240, -71.4128)
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    trip = api.post(
        "/driver-trips", headers=driver_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": yesterday, "flexibility": "morning", "seats_available": 2, "tags": [],
        },
    ).json()

    trips = api.get("/driver-trips/search", headers=rider_headers).json()
    my_trips = api.get("/me/driver-trips", headers=driver_headers).json()

    assert trip["id"] in {t["id"] for t in trips}
    assert next(t for t in my_trips if t["id"] == trip["id"])["status"] == "open"


def test_search_excludes_driver_trips_outside_the_destination_radius() -> None:
    api = client()
    _, rider_headers, _, _, _, driver_trip = make_request_and_trip(api)

    # Real destination is SFO (37.6213, -122.3790) per make_request_and_trip.
    # Search near a destination ~5500km away — PostGIS should exclude it even
    # with a generous radius, proving ST_DWithin is actually filtering, not
    # just matching everything.
    far_away = api.get(
        "/driver-trips/search",
        headers=rider_headers,
        params={
            "destination_latitude": 51.5074, "destination_longitude": -0.1278,  # London
            "destination_radius_meters": 50000,
        },
    ).json()
    nearby = api.get(
        "/driver-trips/search",
        headers=rider_headers,
        params={
            "destination_latitude": 37.6213, "destination_longitude": -122.3790,
            "destination_radius_meters": 1000,
        },
    ).json()

    assert driver_trip["id"] not in {t["id"] for t in far_away}
    assert driver_trip["id"] in {t["id"] for t in nearby}


def test_driver_location_persists_across_separate_store_instances() -> None:
    # Simulates the exact bug this replaces: a serverless cold start creating a
    # fresh Store() must still see a location written by an earlier instance —
    # an in-memory dict would lose it; the Postgres-backed version must not.
    api = client()
    driver, driver_headers = auth(api, "geo-driver@example.com", "Geo Driver")

    update = api.put(
        "/me/location", headers=driver_headers,
        json={"latitude": 37.7749, "longitude": -122.4194, "heading": 90, "speed_kmh": 40},
    )
    assert update.status_code == 200

    # A brand-new Store/app instance — nothing shared in-process with the one above.
    api2 = client()
    nearby = api2.get(
        "/drivers/nearby", headers=driver_headers,
        params={"lat": 37.7750, "lng": -122.4195, "radius_meters": 5000},
    ).json()

    assert driver["id"] in {d["user_id"] for d in nearby}


def test_nearby_drivers_excludes_locations_outside_the_radius() -> None:
    api = client()
    _, headers = auth(api, "geo-driver2@example.com", "Geo Driver Two")
    api.put("/me/location", headers=headers, json={"latitude": 51.5074, "longitude": -0.1278})  # London

    nearby_sf = api.get(
        "/drivers/nearby", headers=headers,
        params={"lat": 37.7749, "lng": -122.4194, "radius_meters": 10000},
    ).json()

    assert nearby_sf == []


def test_expire_endpoints_reject_a_regular_signed_in_user() -> None:
    api = client()
    _, rider_headers = auth(api, "rider3@example.edu", "Riley Passenger")

    for path in ("/ride-requests/expire", "/driver-trips/expire", "/connections/expire"):
        response = api.post(path, headers=rider_headers, json={"today": date.today().isoformat()})
        assert response.status_code == 401, path

    cron_response = api.get("/cron/expire", headers=rider_headers)
    assert cron_response.status_code == 401


def test_expire_endpoints_reject_missing_or_wrong_cron_secret() -> None:
    api = client()

    no_auth = api.post("/ride-requests/expire", json={"today": date.today().isoformat()})
    wrong_secret = api.post(
        "/ride-requests/expire",
        headers={"Authorization": "Bearer wrong-secret"},
        json={"today": date.today().isoformat()},
    )

    assert no_auth.status_code == 401
    assert wrong_secret.status_code == 401


def test_cron_expire_sweeps_both_listings_and_connections_with_the_shared_secret() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)
    api.post(
        "/connections",
        headers=rider_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    )

    response = api.get("/cron/expire", headers=CRON_HEADERS)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_listings_can_be_cancelled_and_expired_out_of_discovery() -> None:
    api = client()
    _, rider_headers = auth(api, "passenger@example.com", "Rider")
    pickup = location(api, rider_headers, "A, Berkeley, CA", 37.87, -122.27)
    destination = location(api, rider_headers, "B, Oakland, CA", 37.80, -122.27)
    request = api.post(
        "/ride-requests",
        headers=rider_headers,
        json={
            "pickup_location_id": pickup["id"],
            "destination_location_id": destination["id"],
            # A day-old listing sits inside the timezone-safety grace period
            # (expire_listings only archives things more than 1 day past) —
            # use a date unambiguously outside that window instead.
            "target_date": (date.today() - timedelta(days=3)).isoformat(),
            "flexibility": "yesterday",
            "passenger_count": 1,
            "tags": ["student"],
        },
    ).json()

    api.post("/ride-requests/expire", headers=CRON_HEADERS, json={"today": date.today().isoformat()})
    search = api.get("/ride-requests/search", headers=rider_headers, params={"tag": "student"}).json()

    assert request["status"] == "open"
    assert search == []


def test_connection_chat_gas_split_notifications_completion_and_seat_reservation() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    connection = api.post(
        "/connections",
        headers=rider_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    ).json()
    pending_message = api.post(
        f"/connections/{connection['id']}/messages",
        headers=driver_headers,
        json={"canned_key": "timing"},
    )
    rejected_free_text = api.post(
        f"/connections/{connection['id']}/messages",
        headers=driver_headers,
        json={"content": "Free text too early"},
    )
    accepted = api.post(
        f"/connections/{connection['id']}/transition",
        headers=driver_headers,
        json={"action": "accept"},
    ).json()
    full_message = api.post(
        f"/connections/{connection['id']}/messages",
        headers=rider_headers,
        json={"content": "Terminal 2 at 8?"},
    ).json()
    suggestion = api.get(f"/connections/{connection['id']}/gas-split/suggestion", headers=rider_headers).json()
    confirmation = api.post(
        f"/connections/{connection['id']}/gas-split/confirm",
        headers=rider_headers,
        json={"amount_cents": suggestion["amount_cents"], "currency": "USD", "assumptions": suggestion["assumptions"]},
    ).json()
    completed = api.post(
        f"/connections/{connection['id']}/transition",
        headers=driver_headers,
        json={"action": "complete"},
    ).json()
    driver_notifications = api.get("/notifications", headers=driver_headers).json()
    rider_notifications = api.get("/notifications", headers=rider_headers).json()

    assert connection["status"] == "pending"
    assert pending_message.status_code == 200
    assert rejected_free_text.status_code == 400
    assert accepted["status"] == "accepted"
    assert accepted["driver_trip"]["seats_reserved"] == 2
    assert accepted["ride_request"]["pickup"]["exact"] is True
    assert full_message["kind"] == "free_text"
    assert confirmation["amount_cents"] == suggestion["amount_cents"]
    assert completed["status"] == "completed"
    assert {n["type"] for n in driver_notifications} >= {"connection_received", "chat_message", "gas_split_confirmed"}
    assert {n["type"] for n in rider_notifications} >= {"connection_accepted", "chat_unlocked"}
    assert passenger["id"] != driver["id"]

    by_type = {n["type"]: n for n in driver_notifications}
    assert by_type["connection_received"]["related_id"] == connection["id"]
    assert by_type["chat_message"]["related_id"] == connection["id"]
    assert by_type["gas_split_confirmed"]["related_id"] == connection["id"]


def test_rider_can_update_pickup_address_once_connection_is_accepted() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    connection = api.post(
        "/connections",
        headers=rider_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    ).json()
    api.post(f"/connections/{connection['id']}/transition", headers=driver_headers, json={"action": "accept"})

    new_pickup = location(api, rider_headers, "123 Telegraph Ave, Berkeley, CA", 37.8691, -122.2585)
    updated = api.patch(
        f"/ride-requests/{ride_request['id']}/pickup",
        headers=rider_headers,
        json={"pickup_location_id": new_pickup["id"]},
    )
    forbidden = api.patch(
        f"/ride-requests/{ride_request['id']}/pickup",
        headers=driver_headers,
        json={"pickup_location_id": new_pickup["id"]},
    )
    missing_location = api.patch(
        f"/ride-requests/{ride_request['id']}/pickup",
        headers=rider_headers,
        json={"pickup_location_id": "loc_does_not_exist"},
    )

    assert updated.status_code == 200
    assert updated.json()["pickup"]["label"] == "123 Telegraph Ave, Berkeley, CA"
    accepted_conn = api.get("/me/connections", headers=driver_headers).json()[0]
    assert accepted_conn["ride_request"]["pickup"]["label"] == "123 Telegraph Ave, Berkeley, CA"
    assert forbidden.status_code == 403
    assert missing_location.status_code == 404
    assert passenger["id"] != driver["id"]


def test_notifications_mark_all_read_and_dismiss() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    api.post(
        "/connections",
        headers=rider_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    )

    unread_before = api.get("/notifications", headers=driver_headers).json()
    assert len(unread_before) >= 1
    assert all(not n["read"] for n in unread_before)

    mark_read = api.post("/notifications/read", headers=driver_headers)
    assert mark_read.status_code == 200

    after_mark_read = api.get("/notifications", headers=driver_headers).json()
    assert all(n["read"] for n in after_mark_read)

    target = after_mark_read[0]
    dismiss = api.delete(f"/notifications/{target['id']}", headers=driver_headers)
    assert dismiss.status_code == 200

    remaining = api.get("/notifications", headers=driver_headers).json()
    assert target["id"] not in {n["id"] for n in remaining}


def test_cannot_dismiss_another_users_notification() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    api.post(
        "/connections",
        headers=rider_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    )
    driver_notification = api.get("/notifications", headers=driver_headers).json()[0]

    response = api.delete(f"/notifications/{driver_notification['id']}", headers=rider_headers)
    assert response.status_code == 404

    still_present = api.get("/notifications", headers=driver_headers).json()
    assert driver_notification["id"] in {n["id"] for n in still_present}


def test_public_profile_exposes_icebreaker_fields() -> None:
    api = client()
    driver, driver_headers = auth(client=api, email="driver2@example.com", name="Dee Driver")
    api.patch(
        "/me/profile",
        headers=driver_headers,
        json={"display_name": "Dee Driver", "interests": ["Afrobeat", "Coffee"], "nationality": "Kenyan"},
    )
    passenger, rider_headers = auth(client=api, email="rider2@example.edu", name="Riley Passenger")

    response = api.get(f"/users/{driver['id']}/profile", headers=rider_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["display_name"] == "Dee Driver"
    assert body["interests"] == ["Afrobeat", "Coffee"]
    assert body["nationality"] == "Kenyan"
    assert "photo_verified" in body


def test_driver_can_offer_ride_and_pending_connections_expire() -> None:
    api = client()
    _, _, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    connection = api.post(
        "/connections",
        headers=driver_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    ).json()
    api.post("/connections/expire", headers=CRON_HEADERS, json={"today": (date.today() + timedelta(days=1)).isoformat()})
    expired = api.post(
        f"/connections/{connection['id']}/transition",
        headers=driver_headers,
        json={"action": "accept"},
    )

    assert connection["status"] == "pending"
    assert expired.status_code == 400
    assert "pending" in expired.json()["detail"]


def test_driver_offer_happy_path_can_be_accepted_and_completed() -> None:
    api = client()
    _, rider_headers, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    connection = api.post(
        "/connections",
        headers=driver_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    ).json()
    accepted = api.post(
        f"/connections/{connection['id']}/transition",
        headers=rider_headers,
        json={"action": "accept"},
    ).json()
    api.post(
        f"/connections/{connection['id']}/gas-split/confirm",
        headers=driver_headers,
        json={"amount_cents": 1200, "currency": "USD", "assumptions": {"manual": True}},
    )
    completed = api.post(
        f"/connections/{connection['id']}/transition",
        headers=rider_headers,
        json={"action": "complete"},
    ).json()

    assert connection["initiator_user_id"] == driver_trip["driver_id"]
    assert accepted["status"] == "accepted"
    assert completed["status"] == "completed"
    assert completed["completed_confirmed_by"]


def test_driver_trip_cannot_be_overbooked() -> None:
    api = client()
    _, rider_headers, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api, passenger_count=2, seats_available=3)
    second_rider, second_headers = auth(api, "rider2@example.com", "Second Passenger")
    pickup = location(api, second_headers, "2 Main St, Berkeley, CA", 37.8716, -122.2731)
    destination = location(api, second_headers, "SFO Terminal 2, San Francisco, CA", 37.6213, -122.3790)
    second_request = api.post(
        "/ride-requests",
        headers=second_headers,
        json={
            "pickup_location_id": pickup["id"],
            "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(),
            "flexibility": "Friday morning",
            "passenger_count": 2,
            "tags": ["airport"],
        },
    ).json()

    first = api.post("/connections", headers=rider_headers, json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]}).json()
    api.post(f"/connections/{first['id']}/transition", headers=driver_headers, json={"action": "accept"})
    second = api.post(
        "/connections",
        headers=second_headers,
        json={"ride_request_id": second_request["id"], "driver_trip_id": driver_trip["id"]},
    ).json()
    overbook = api.post(f"/connections/{second['id']}/transition", headers=driver_headers, json={"action": "accept"})

    assert second_rider["id"] != ride_request["rider_id"]
    assert overbook.status_code == 409
    assert "enough available seats" in overbook.json()["detail"]


def test_blocked_users_are_removed_from_discovery_and_chat() -> None:
    api = client()
    _, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)
    block = api.post(f"/users/{driver['id']}/block", headers=rider_headers)
    connection = api.post(
        "/connections",
        headers=rider_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    )
    search = api.get("/driver-trips/search", headers=rider_headers, params={"destination_latitude": 37.6213, "destination_longitude": -122.3790}).json()
    report = api.post(f"/users/{driver['id']}/report", headers=rider_headers, json={"reason": "Unsafe communication"})

    assert block.status_code == 200
    assert connection.status_code == 403
    assert search == []
    assert report.status_code == 200


def create_pool(client: TestClient, headers: dict[str, str], **overrides: object) -> dict:
    pickup = location(client, headers, "Grace Church, Berkeley, CA", 37.8715, -122.2730)
    destination = location(client, headers, "Oakland Coliseum, Oakland, CA", 37.7516, -122.2005)
    payload = {
        "name": "Sunday Service Carpool",
        "community_tag": "church",
        "trip_date": date.today().isoformat(),
        "departure_time": "09:30",
        "pickup_location_id": pickup["id"],
        "destination_location_id": destination["id"],
        "max_participants": 6,
        "seats_per_vehicle": 4,
    }
    payload.update(overrides)
    response = client.post("/pools", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_pool_creation_stores_and_returns_departure_time() -> None:
    api = client()
    _, headers = auth(api, "organizer@example.com", "Organizer")

    pool = create_pool(api, headers, departure_time="09:30")
    fetched = api.get(f"/pools/{pool['id']}", headers=headers).json()

    assert pool["departure_time"] == "09:30:00"
    assert fetched["departure_time"] == "09:30:00"


def test_pool_members_include_display_names_and_organizer_role() -> None:
    api = client()
    organizer, organizer_headers = auth(api, "organizer@example.com", "Ora Ganizer")
    _, passenger_headers = auth(api, "passenger@example.com", "Pat Passenger")

    pool = create_pool(api, organizer_headers)
    api.post(f"/pools/{pool['id']}/join", headers=passenger_headers, json={})
    fetched = api.get(f"/pools/{pool['id']}", headers=passenger_headers).json()

    members_by_role = {m["role"]: m["display_name"] for m in fetched["members"]}
    assert members_by_role["organizer"] == "Ora Ganizer"
    assert members_by_role["passenger"] == "Pat Passenger"


def test_pool_members_can_post_and_read_group_chat_messages() -> None:
    api = client()
    _, organizer_headers = auth(api, "organizer@example.com", "Ora Ganizer")
    _, passenger_headers = auth(api, "passenger@example.com", "Pat Passenger")
    pool = create_pool(api, organizer_headers)
    api.post(f"/pools/{pool['id']}/join", headers=passenger_headers, json={})

    posted = api.post(
        f"/pools/{pool['id']}/messages", headers=passenger_headers,
        json={"content": "Meet at the front gate!"},
    )
    messages = api.get(f"/pools/{pool['id']}/messages", headers=organizer_headers).json()

    assert posted.status_code == 200
    assert posted.json()["content"] == "Meet at the front gate!"
    assert posted.json()["sender_id"] == api.get("/me", headers=passenger_headers).json()["id"]
    assert [m["content"] for m in messages] == ["Meet at the front gate!"]


def test_pool_chat_is_off_limits_to_non_members_and_users_who_left() -> None:
    api = client()
    _, organizer_headers = auth(api, "organizer@example.com", "Ora Ganizer")
    _, outsider_headers = auth(api, "outsider@example.com", "Ollie Outsider")
    _, leaver_headers = auth(api, "leaver@example.com", "Leah Leaver")
    pool = create_pool(api, organizer_headers)
    api.post(f"/pools/{pool['id']}/join", headers=leaver_headers, json={})
    api.post(f"/pools/{pool['id']}/leave", headers=leaver_headers)

    outsider_post = api.post(f"/pools/{pool['id']}/messages", headers=outsider_headers, json={"content": "hi"})
    outsider_read = api.get(f"/pools/{pool['id']}/messages", headers=outsider_headers)
    leaver_post = api.post(f"/pools/{pool['id']}/messages", headers=leaver_headers, json={"content": "hi"})

    assert outsider_post.status_code == 403
    assert outsider_read.status_code == 403
    assert leaver_post.status_code == 403


# ─── Route-corridor matching ──────────────────────────────────────────────────

class FakeRouter:
    """Straight-line 'road' through the given points at a fixed 60 km/h, so
    corridor and detour behaviour is testable without a real OSRM."""

    def __init__(self) -> None:
        self.calls: list[list[tuple[float, float]]] = []

    def route(self, points):
        from math import asin, cos, radians, sin, sqrt

        from backend.app.routing import RouteResult

        self.calls.append(list(points))
        total = 0.0
        for (lat1, lng1), (lat2, lng2) in zip(points, points[1:]):
            a = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ** 2
            total += 2 * 6371000 * asin(sqrt(a))
        # Densify the single-leg route so ST_LineLocatePoint has vertices to use.
        (lat1, lng1), (lat2, lng2) = points[0], points[-1]
        coords = [(lng1 + (lng2 - lng1) * i / 20, lat1 + (lat2 - lat1) * i / 20) for i in range(21)]
        return RouteResult(distance_m=total, duration_s=total / (60 / 3.6), coordinates=coords)


def corridor_client(router: FakeRouter) -> TestClient:
    settings = Settings(
        database_url=TEST_DATABASE_URL, supabase_url=TEST_NEON_AUTH_URL, supabase_jwks_path="/.well-known/jwks.json", cron_secret=TEST_CRON_SECRET,
    )
    return TestClient(create_app(store=Store(TEST_DATABASE_URL, router=router), settings=settings))


def post_trip(api: TestClient, headers: dict, pickup: dict, destination: dict) -> dict:
    response = api.post(
        "/driver-trips", headers=headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": date.today().isoformat(), "flexibility": "Friday morning",
            "seats_available": 2, "tags": [],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_corridor_search_matches_riders_along_the_route_in_the_same_direction() -> None:
    # Driver goes Oakland → San Jose (roughly south-east along I-880). A passenger
    # in Fremont heading to Milpitas is on the corridor; the opposite-direction
    # passenger (Milpitas → Fremont) and a passenger far off the route must not match.
    router = FakeRouter()
    api = corridor_client(router)
    _, rider_headers = auth(api, "corr-passenger@example.edu", "Cora Passenger")
    _, driver_headers = auth(api, "corr-driver@example.com", "Cal Driver")
    oakland = location(api, driver_headers, "Oakland, CA", 37.8044, -122.2712)
    san_jose = location(api, driver_headers, "San Jose, CA", 37.3382, -121.8863)
    trip = post_trip(api, driver_headers, oakland, san_jose)

    def search(pickup: tuple[float, float], dest: tuple[float, float]) -> list[dict]:
        return api.get(
            "/driver-trips/search", headers=rider_headers,
            params={
                "pickup_latitude": pickup[0], "pickup_longitude": pickup[1],
                "destination_latitude": dest[0], "destination_longitude": dest[1],
            },
        ).json()

    # Points exactly on the straight driver line: 40% and 70% of the way.
    def along(f: float) -> tuple[float, float]:
        return (37.8044 + (37.3382 - 37.8044) * f, -122.2712 + (-121.8863 + 122.2712) * f)

    forward = search(along(0.4), along(0.7))
    assert [t["id"] for t in forward] == [trip["id"]]
    assert forward[0]["detour_minutes"] is not None and forward[0]["detour_minutes"] < 1
    assert search(along(0.7), along(0.4)) == []  # opposite direction on the same road
    assert search((37.7749, -122.4194), (37.9, -122.5)) == []  # nowhere near the route


def test_corridor_search_reports_detour_minutes_for_off_route_pickups() -> None:
    router = FakeRouter()
    api = corridor_client(router)
    _, rider_headers = auth(api, "det-passenger@example.edu", "Dina Passenger")
    _, driver_headers = auth(api, "det-driver@example.com", "Dev Driver")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    post_trip(api, driver_headers, a, b)

    # Passenger ~890 m north of the line (inside the 1000 m buffer), mid-route: the
    # insertion route is longer than the direct one, so detour is > 0.
    trips = api.get(
        "/driver-trips/search", headers=rider_headers,
        params={
            "pickup_latitude": 37.008, "pickup_longitude": -121.995,
            "destination_latitude": 37.008, "destination_longitude": -121.985,
        },
    ).json()
    assert len(trips) == 1
    assert trips[0]["detour_minutes"] > 0
    # driver pickup → passenger pickup → passenger destination → driver destination
    assert len(router.calls[-1]) == 4


def test_trips_without_a_stored_route_fall_back_to_endpoint_radius_matching() -> None:
    # No router configured (or OSRM down at creation): the trip has no
    # route_geog, and a passenger search with both points still finds it through the
    # old pickup/destination radius rules instead of silently excluding it.
    api = client()
    _, rider_headers, _, _, _, driver_trip = make_request_and_trip(api)
    trips = api.get(
        "/driver-trips/search", headers=rider_headers,
        params={
            "pickup_latitude": 37.8715, "pickup_longitude": -122.2730,
            "destination_latitude": 37.6213, "destination_longitude": -122.3790,
        },
    ).json()
    assert [t["id"] for t in trips] == [driver_trip["id"]]
    assert trips[0]["detour_minutes"] is None


def test_trip_creation_survives_routing_failure() -> None:
    class DownRouter:
        def route(self, points):
            return None

    api = corridor_client(DownRouter())  # type: ignore[arg-type]
    _, driver_headers = auth(api, "down-driver@example.com", "Dan Driver")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.0)
    post_trip(api, driver_headers, a, b)


def test_corridor_search_results_never_expose_coordinates_or_route_data() -> None:
    # Detour/ETA is computed server-side from stored lat/lng; the pre-connection
    # response must carry only the derived number, not exact pins or the route.
    api = corridor_client(FakeRouter())
    _, rider_headers = auth(api, "priv-passenger@example.edu", "Pia Passenger")
    _, driver_headers = auth(api, "priv-driver@example.com", "Pat Driver")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    post_trip(api, driver_headers, a, b)

    trips = api.get(
        "/driver-trips/search", headers=rider_headers,
        params={
            "pickup_latitude": 37.0, "pickup_longitude": -121.995,
            "destination_latitude": 37.0, "destination_longitude": -121.985,
        },
    ).json()

    assert len(trips) == 1 and trips[0]["detour_minutes"] is not None
    for place in (trips[0]["pickup"], trips[0]["destination"]):
        assert place["exact"] is False
        assert "latitude" not in place and "longitude" not in place
    assert not any(k.startswith("route") for k in trips[0])


# ─── Proposed matches (Empower-style) ─────────────────────────────────────────

def make_rider_request(api: TestClient, headers: dict, pickup: tuple[float, float], dest: tuple[float, float]) -> dict:
    p = location(api, headers, "Passenger pickup", *pickup)
    d = location(api, headers, "Passenger dest", *dest)
    response = api.post(
        "/ride-requests", headers=headers,
        json={
            "pickup_location_id": p["id"], "destination_location_id": d["id"],
            "target_date": date.today().isoformat(), "flexibility": "Friday morning",
            "passenger_count": 1, "tags": [],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_proposal_is_the_lowest_detour_trip_and_skipping_advances_to_the_next() -> None:
    api = corridor_client(FakeRouter())
    _, rider_headers = auth(api, "prop-passenger@example.edu", "Pru Passenger")
    _, near_headers = auth(api, "prop-near@example.com", "Near Driver")
    _, far_headers = auth(api, "prop-far@example.com", "Far Driver")

    # Two trips sharing the corridor; the passenger sits on the first one's line and
    # ~890 m off the second's, so the first has the smaller detour.
    a1 = location(api, near_headers, "A1", 37.0, -122.0)
    b1 = location(api, near_headers, "B1", 37.0, -121.98)
    near_trip = post_trip(api, near_headers, a1, b1)
    a2 = location(api, far_headers, "A2", 37.008, -122.0)
    b2 = location(api, far_headers, "B2", 37.008, -121.98)
    far_trip = post_trip(api, far_headers, a2, b2)

    rr = make_rider_request(api, rider_headers, (37.0, -121.995), (37.0, -121.985))

    first = api.get(f"/ride-requests/{rr['id']}/proposal", headers=rider_headers).json()
    assert first["trip"]["id"] == near_trip["id"]
    assert first["remaining"] == 1
    assert first["trip"]["pickup"]["exact"] is False

    skip = api.post(
        f"/ride-requests/{rr['id']}/proposal/skip", headers=rider_headers,
        json={"driver_trip_id": near_trip["id"]},
    )
    assert skip.status_code == 200
    second = api.get(f"/ride-requests/{rr['id']}/proposal", headers=rider_headers).json()
    assert second["trip"]["id"] == far_trip["id"] and second["remaining"] == 0

    api.post(
        f"/ride-requests/{rr['id']}/proposal/skip", headers=rider_headers,
        json={"driver_trip_id": far_trip["id"]},
    )
    done = api.get(f"/ride-requests/{rr['id']}/proposal", headers=rider_headers).json()
    assert done == {"trip": None, "remaining": 0}


def test_accepting_a_proposal_uses_the_normal_connection_flow_and_stops_reproposing_it() -> None:
    api = corridor_client(FakeRouter())
    _, rider_headers = auth(api, "acc-passenger@example.edu", "Ada Passenger")
    _, driver_headers = auth(api, "acc-driver@example.com", "Abe Driver")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    trip = post_trip(api, driver_headers, a, b)
    rr = make_rider_request(api, rider_headers, (37.0, -121.995), (37.0, -121.985))

    proposal = api.get(f"/ride-requests/{rr['id']}/proposal", headers=rider_headers).json()["trip"]
    conn = api.post(
        "/connections", headers=rider_headers,
        json={"ride_request_id": rr["id"], "driver_trip_id": proposal["id"]},
    ).json()
    assert conn["status"] == "pending" and conn["driver_trip_id"] == trip["id"]
    assert api.get(f"/ride-requests/{rr['id']}/proposal", headers=rider_headers).json()["trip"] is None


def test_only_the_rider_can_get_or_skip_proposals_for_their_request() -> None:
    api = corridor_client(FakeRouter())
    _, rider_headers = auth(api, "own-passenger@example.edu", "Olga Passenger")
    _, other_headers = auth(api, "own-other@example.com", "Otto Other")
    rr = make_rider_request(api, rider_headers, (37.0, -121.995), (37.0, -121.985))
    assert api.get(f"/ride-requests/{rr['id']}/proposal", headers=other_headers).status_code == 403
    assert api.post(
        f"/ride-requests/{rr['id']}/proposal/skip", headers=other_headers, json={"driver_trip_id": "x"},
    ).status_code == 403


def test_proposals_skip_trips_without_enough_free_seats() -> None:
    api = corridor_client(FakeRouter())
    _, rider_headers = auth(api, "seat-passenger@example.edu", "Sia Passenger")
    _, driver_headers = auth(api, "seat-driver@example.com", "Sam Driver")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    post_trip(api, driver_headers, a, b)  # 2 seats
    p = location(api, rider_headers, "P", 37.0, -121.995)
    d = location(api, rider_headers, "D", 37.0, -121.985)
    rr = api.post(
        "/ride-requests", headers=rider_headers,
        json={
            "pickup_location_id": p["id"], "destination_location_id": d["id"],
            "target_date": date.today().isoformat(), "flexibility": "Friday morning",
            "passenger_count": 3, "tags": [],
        },
    ).json()
    assert api.get(f"/ride-requests/{rr['id']}/proposal", headers=rider_headers).json()["trip"] is None


# ─── Proposed passengers (driver side) ────────────────────────────────────────────

def test_driver_is_proposed_the_lowest_detour_rider_and_skipping_advances() -> None:
    api = corridor_client(FakeRouter())
    _, driver_headers = auth(api, "dp-driver@example.com", "Dora Driver")
    _, near_headers = auth(api, "dp-near@example.edu", "Near Passenger")
    _, far_headers = auth(api, "dp-far@example.edu", "Far Passenger")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    trip = post_trip(api, driver_headers, a, b)

    near = make_rider_request(api, near_headers, (37.0, -121.995), (37.0, -121.985))      # on the line
    far = make_rider_request(api, far_headers, (37.008, -121.995), (37.008, -121.985))    # ~890 m off
    # Opposite direction on the same road: never proposed.
    _, back_headers = auth(api, "dp-back@example.edu", "Back Passenger")
    make_rider_request(api, back_headers, (37.0, -121.985), (37.0, -121.995))

    first = api.get(f"/driver-trips/{trip['id']}/proposal", headers=driver_headers).json()
    assert first["request"]["id"] == near["id"]
    assert first["remaining"] == 1
    assert first["request"]["detour_minutes"] is not None
    assert first["request"]["pickup"]["exact"] is False
    assert "latitude" not in first["request"]["pickup"]

    api.post(f"/driver-trips/{trip['id']}/proposal/skip", headers=driver_headers, json={"ride_request_id": near["id"]})
    second = api.get(f"/driver-trips/{trip['id']}/proposal", headers=driver_headers).json()
    assert second["request"]["id"] == far["id"] and second["remaining"] == 0

    # A driver's skip must not hide the trip from the passenger's own proposals.
    rider_view = api.get(f"/ride-requests/{near['id']}/proposal", headers=near_headers).json()
    assert rider_view["trip"]["id"] == trip["id"]


def test_driver_matches_list_riders_with_score_and_distance_off_route() -> None:
    api = corridor_client(FakeRouter())
    _, driver_headers = auth(api, "dm-driver@example.com", "Dora Driver")
    _, near_headers = auth(api, "dm-near@example.edu", "Near Passenger")
    _, far_headers = auth(api, "dm-far@example.edu", "Far Passenger")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    trip = post_trip(api, driver_headers, a, b)
    near = make_rider_request(api, near_headers, (37.0, -121.995), (37.0, -121.985))
    far = make_rider_request(api, far_headers, (37.008, -121.995), (37.008, -121.985))

    matches = api.get(f"/driver-trips/{trip['id']}/matches", headers=driver_headers).json()
    assert [m["id"] for m in matches] == [near["id"], far["id"]]
    assert matches[0]["match_score"] >= matches[1]["match_score"]
    assert matches[0]["off_route_m"] < matches[1]["off_route_m"]
    # Skipping a passenger from the single-proposal card doesn't hide them from the list.
    api.post(f"/driver-trips/{trip['id']}/proposal/skip", headers=driver_headers, json={"ride_request_id": near["id"]})
    assert len(api.get(f"/driver-trips/{trip['id']}/matches", headers=driver_headers).json()) == 2
    assert api.get(f"/driver-trips/{trip['id']}/matches", headers=near_headers).status_code == 403


def test_driver_accepting_a_proposed_rider_creates_a_pending_connection() -> None:
    api = corridor_client(FakeRouter())
    _, driver_headers = auth(api, "da-driver@example.com", "Dan Driver")
    _, rider_headers = auth(api, "da-passenger@example.edu", "Rae Passenger")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    trip = post_trip(api, driver_headers, a, b)
    rr = make_rider_request(api, rider_headers, (37.0, -121.995), (37.0, -121.985))

    proposed = api.get(f"/driver-trips/{trip['id']}/proposal", headers=driver_headers).json()["request"]
    conn = api.post(
        "/connections", headers=driver_headers,
        json={"ride_request_id": proposed["id"], "driver_trip_id": trip["id"]},
    ).json()
    assert conn["status"] == "pending" and conn["ride_request_id"] == rr["id"]
    assert api.get(f"/driver-trips/{trip['id']}/proposal", headers=driver_headers).json()["request"] is None


def test_only_the_driver_can_get_or_skip_proposals_for_their_trip() -> None:
    api = corridor_client(FakeRouter())
    _, driver_headers = auth(api, "do-driver@example.com", "Dee Driver")
    _, other_headers = auth(api, "do-other@example.com", "Otis Other")
    a = location(api, driver_headers, "A", 37.0, -122.0)
    b = location(api, driver_headers, "B", 37.0, -121.98)
    trip = post_trip(api, driver_headers, a, b)
    assert api.get(f"/driver-trips/{trip['id']}/proposal", headers=other_headers).status_code == 403
    assert api.post(
        f"/driver-trips/{trip['id']}/proposal/skip", headers=other_headers, json={"ride_request_id": "x"},
    ).status_code == 403


def test_driver_heading_to_a_general_area_is_visible_to_a_passenger_with_a_specific_address() -> None:
    api = corridor_client(FakeRouter())
    _, passenger_headers = auth(api, "gen-passenger@example.edu", "Gen Passenger")
    _, exact_driver = auth(api, "gen-exact@example.com", "Exact Driver")
    _, area_driver = auth(api, "gen-area@example.com", "Area Driver")

    def loc(headers, label, lat, lng, general=False):
        r = api.post("/locations", headers=headers, json={"label": label, "latitude": lat, "longitude": lng, "is_general": general})
        assert r.status_code == 200, r.text
        return r.json()

    start = loc(area_driver, "Chico, CA", 37.0, -122.0, general=True)
    # Same route twice: one ends at an exact address, one at the "city".
    exact_trip = post_trip(api, exact_driver, loc(exact_driver, "1 Main St", 37.0, -122.0), loc(exact_driver, "9 Oak Ave", 37.0, -121.90))
    area_trip = post_trip(api, area_driver, start, loc(area_driver, "Sacramento, CA", 37.0, -121.90, general=True))

    # The passenger's address sits ~5.5 km off the line, far outside the street-level buffer.
    params = {"pickup_latitude": 37.0, "pickup_longitude": -121.98, "destination_latitude": 37.05, "destination_longitude": -121.95}
    found = {t["id"] for t in api.get("/driver-trips/search", headers=passenger_headers, params=params).json()}

    assert area_trip["id"] in found
    assert exact_trip["id"] not in found
