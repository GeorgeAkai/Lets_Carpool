from __future__ import annotations

import base64
import json
import os
import threading
from datetime import UTC, date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
import psycopg2
from fastapi.testclient import TestClient

from backend.app.db import run_migrations
from backend.app.domain import Store
from backend.app.main import Settings, create_app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://carpool:carpool@localhost:5434/carpool"
)

# ─── Fake Supabase Auth ─────────────────────────────────────────────────────────
# /auth/login cryptographically verifies the Supabase access token against the
# project's JWKS endpoint instead of trusting a client-supplied email. To test
# that for real without a Supabase project, this spins up a tiny local server
# publishing the JWKS at Supabase's path and signs test tokens with a real
# ES256 keypair — the same verification code path production traffic takes.

_SUPABASE_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_SUPABASE_KID = "test-key-1"
TEST_SUPABASE_JWT_SECRET = "legacy-hs256-secret-for-tests-only-0123456789"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


_pub = _SUPABASE_PRIVATE_KEY.public_key().public_numbers()
_SUPABASE_JWKS_BODY = json.dumps({
    "keys": [{
        "kty": "EC", "crv": "P-256", "kid": _SUPABASE_KID, "use": "sig", "alg": "ES256",
        "x": _b64url(_pub.x.to_bytes(32, "big")), "y": _b64url(_pub.y.to_bytes(32, "big")),
    }],
}).encode()


class _JWKSHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/auth/v1/.well-known/jwks.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(_SUPABASE_JWKS_BODY)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass


_jwks_server = ThreadingHTTPServer(("127.0.0.1", 0), _JWKSHandler)
threading.Thread(target=_jwks_server.serve_forever, daemon=True).start()
TEST_SUPABASE_URL = f"http://127.0.0.1:{_jwks_server.server_port}"
TEST_SUPABASE_ISSUER = f"{TEST_SUPABASE_URL}/auth/v1"


def _private_pem() -> bytes:
    return _SUPABASE_PRIVATE_KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )


def supabase_claims(*, email: str | None, name: str, sub: str | None = None, expired: bool = False,
                    iss: str = TEST_SUPABASE_ISSUER, aud: str = "authenticated") -> dict:
    now = datetime.now(UTC)
    claims = {
        "sub": sub or f"sb_{email}",
        "user_metadata": {"full_name": name},
        "role": "authenticated",
        "iss": iss,
        "aud": aud,
        "iat": now,
        "exp": now + (timedelta(minutes=-5) if expired else timedelta(hours=1)),
    }
    if email is not None:
        claims["email"] = email
    return claims


def sign_supabase_token(*, email: str | None, name: str, **kwargs) -> str:
    return pyjwt.encode(
        supabase_claims(email=email, name=name, **kwargs), _private_pem(),
        algorithm="ES256", headers={"kid": _SUPABASE_KID},
    )


TEST_CRON_SECRET = "test-cron-secret"
CRON_HEADERS = {"Authorization": f"Bearer {TEST_CRON_SECRET}"}


def client() -> TestClient:
    settings = Settings(
        database_url=TEST_DATABASE_URL, supabase_url=TEST_SUPABASE_URL,
        supabase_jwt_secret=TEST_SUPABASE_JWT_SECRET, cron_secret=TEST_CRON_SECRET,
    )
    return TestClient(create_app(store=Store(TEST_DATABASE_URL), settings=settings))


def auth(client: TestClient, email: str, name: str) -> tuple[dict, dict[str, str]]:
    token = sign_supabase_token(email=email, name=name)
    response = client.post("/auth/login", json={"supabase_token": token})
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
    rider, rider_headers = auth(client, "rider@example.edu", "Riley Rider")
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
    return rider, rider_headers, driver, driver_headers, ride_request, driver_trip


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
    forged_key = ec.generate_private_key(ec.SECP256R1())
    forged_pem = forged_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    forged_token = pyjwt.encode(
        supabase_claims(email="victim@berkeley.edu", name="Attacker", sub="sb_attacker"),
        forged_pem, algorithm="ES256", headers={"kid": _SUPABASE_KID},
    )

    response = api.post("/auth/login", json={"supabase_token": forged_token})

    assert response.status_code == 401


def test_login_rejects_an_expired_supabase_token() -> None:
    api = client()
    expired_token = sign_supabase_token(email="ada@berkeley.edu", name="Ada Lovelace", expired=True)

    response = api.post("/auth/login", json={"supabase_token": expired_token})

    assert response.status_code == 401


def test_login_rejects_a_token_from_another_supabase_project() -> None:
    api = client()
    wrong_issuer = sign_supabase_token(
        email="ada@berkeley.edu", name="Ada", iss="https://someone-else.supabase.co/auth/v1",
    )

    response = api.post("/auth/login", json={"supabase_token": wrong_issuer})

    assert response.status_code == 401


def test_login_rejects_a_non_user_token_audience() -> None:
    api = client()
    service_token = sign_supabase_token(email="ada@berkeley.edu", name="Ada", aud="service_role")

    response = api.post("/auth/login", json={"supabase_token": service_token})

    assert response.status_code == 401


def test_login_rejects_a_token_with_no_email_claim() -> None:
    api = client()
    no_email_token = sign_supabase_token(email=None, name="No Email", sub="sb_no_email")

    response = api.post("/auth/login", json={"supabase_token": no_email_token})

    assert response.status_code == 401


def test_login_accepts_legacy_hs256_tokens_signed_with_the_project_secret() -> None:
    api = client()
    legacy = pyjwt.encode(
        supabase_claims(email="grace@example.com", name="Grace Hopper"), TEST_SUPABASE_JWT_SECRET, algorithm="HS256",
    )
    forged = pyjwt.encode(
        supabase_claims(email="grace@example.com", name="Grace Hopper"), "not-the-project-secret-0123456789", algorithm="HS256",
    )

    ok = api.post("/auth/login", json={"supabase_token": legacy})
    bad = api.post("/auth/login", json={"supabase_token": forged})

    assert ok.status_code == 200
    assert ok.json()["user"]["profile"]["display_name"] == "Grace Hopper"
    assert bad.status_code == 401


def test_login_rejects_hs256_tokens_when_no_legacy_secret_is_configured() -> None:
    settings = Settings(database_url=TEST_DATABASE_URL, supabase_url=TEST_SUPABASE_URL, cron_secret=TEST_CRON_SECRET)
    api = TestClient(create_app(store=Store(TEST_DATABASE_URL), settings=settings))
    token = pyjwt.encode(
        supabase_claims(email="grace@example.com", name="Grace"), "any-secret-at-all-0123456789abcdef", algorithm="HS256",
    )

    response = api.post("/auth/login", json={"supabase_token": token})

    assert response.status_code == 401


def test_login_rejects_garbage_input() -> None:
    api = client()

    response = api.post("/auth/login", json={"supabase_token": "not.a.jwt"})

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


def test_public_profile_gives_riders_and_drivers_enough_to_judge_trust() -> None:
    # Riders check out a driver before requesting; drivers check out a rider
    # before accepting. Trust signals yes — contact details never.
    api = client()
    rider, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)
    api.patch("/me/profile", headers=driver_headers, json={"display_name": "Dee Driver", "bio": "Campus commuter"})
    api.put("/me/driver-readiness", headers=driver_headers, json={
        "make": "Toyota", "model": "Prius", "color": "Blue", "seats": 3, "car_type": "sedan",
        "has_license": True, "has_insurance": True, "has_good_driving_record": False,
    })
    connection = api.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"],
    }).json()
    api.post(f"/connections/{connection['id']}/transition", headers=rider_headers, json={"action": "accept"})
    api.post(f"/connections/{connection['id']}/gas-split/confirm", headers=driver_headers,
             json={"amount_cents": 1200, "currency": "USD", "assumptions": {"manual": True}})
    api.post(f"/connections/{connection['id']}/transition", headers=rider_headers, json={"action": "complete"})

    seen_by_rider = api.get(f"/users/{driver['id']}/profile", headers=rider_headers)
    seen_by_driver = api.get(f"/users/{rider['id']}/profile", headers=driver_headers)

    assert seen_by_rider.status_code == 200
    body = seen_by_rider.json()
    assert body["display_name"] == "Dee Driver"
    assert body["bio"] == "Campus commuter"
    assert body["email_domain"] == "example.com"
    assert body["member_since"]
    assert body["completed_rides"] == {"as_driver": 1, "as_rider": 0}
    assert body["vehicle"]["make"] == "Toyota" and body["vehicle"]["has_license"] is True
    assert "email" not in body
    assert seen_by_driver.json()["completed_rides"] == {"as_driver": 0, "as_rider": 1}

    # Blocking hides the profile both ways.
    api.post(f"/users/{driver['id']}/block", headers=rider_headers)
    assert api.get(f"/users/{rider['id']}/profile", headers=driver_headers).status_code == 404


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
    assert approximate == {"id": created["id"], "label": "Berkeley, CA", "exact": False}
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
    assert requests[0]["rider_name"] == "Riley Rider"


def test_driver_trips_and_ride_requests_carry_an_optional_free_text_note() -> None:
    # Lets a driver write "Heading to SFO, anyone going the same way?" or a
    # rider write "Need a ride Friday morning, one small bag" on their own
    # listing — free text alongside the structured fields, not a replacement
    # for them.
    api = client()
    _, rider_headers = auth(api, "notes-rider@example.edu", "Nora Rider")
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


def test_the_same_two_people_cannot_open_a_second_live_connection_for_the_same_day() -> None:
    # Regression test: the rider requested the driver's post, then the driver
    # offered on the rider's backing request — two connections (and two
    # chats in the Inbox) for the same ride.
    api = client()
    _, rider_headers, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api)
    first = api.post("/connections", headers=rider_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"],
    })
    assert first.status_code == 200

    # The driver tries the mirror direction with a fresh trip on the same day.
    offer_trip = api.post("/driver-trips", headers=driver_headers, json={
        "pickup_location_id": driver_trip["pickup_location_id"],
        "destination_location_id": driver_trip["destination_location_id"],
        "target_date": driver_trip["target_date"], "flexibility": "morning",
        "seats_available": 1, "tags": [], "for_connection": True,
    }).json()
    second = api.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": offer_trip["id"],
    })
    assert second.status_code == 409
    assert len(api.get("/me/connections", headers=rider_headers).json()) == 1

    # Once the first is cancelled, connecting again is allowed.
    api.post(f"/connections/{first.json()['id']}/transition", headers=rider_headers, json={"action": "cancel"})
    third = api.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": offer_trip["id"],
    })
    assert third.status_code == 200


def test_listings_created_to_back_a_connection_stay_out_of_discover() -> None:
    # Regression test: tapping "Request to join" creates a ride request on the
    # rider's behalf. It used to be an ordinary public listing, so the driver
    # saw it in Discover and tapping "Offer to drive" on it created *another*
    # trip — which then showed up in the rider's Discover as a duplicate of
    # the driver's real post.
    api = client()
    _, driver_headers = auth(api, "deree@example.com", "Deree")
    _, rider_headers = auth(api, "passenger@example.com", "Passenger")
    _, other_driver_headers = auth(api, "other-driver@example.com", "Other Driver")
    chico = location(api, driver_headers, "Chico, California", 39.7285, -121.8375)
    tahoe = location(api, driver_headers, "Lake Tahoe, California", 39.0968, -120.0324)
    today = date.today().isoformat()
    real_trip = api.post("/driver-trips", headers=driver_headers, json={
        "pickup_location_id": chico["id"], "destination_location_id": tahoe["id"],
        "target_date": today, "flexibility": "afternoon", "seats_available": 3, "tags": [],
        "car_type": "suv", "notes": "Heading to Lake Tahoe. Anyone?",
    }).json()

    # What onConnect does for "Request to join".
    backing_request = api.post("/ride-requests", headers=rider_headers, json={
        "pickup_location_id": chico["id"], "destination_location_id": tahoe["id"],
        "target_date": today, "flexibility": "afternoon", "passenger_count": 1, "tags": [],
        "for_connection": True,
    }).json()
    conn = api.post("/connections", headers=rider_headers, json={
        "ride_request_id": backing_request["id"], "driver_trip_id": real_trip["id"],
    })
    assert conn.status_code == 200

    for headers in (driver_headers, other_driver_headers):
        requests = api.get("/ride-requests/search", headers=headers).json()
        assert backing_request["id"] not in {r["id"] for r in requests}

    # And the mirror case — a trip created for "Offer to drive".
    backing_trip = api.post("/driver-trips", headers=other_driver_headers, json={
        "pickup_location_id": chico["id"], "destination_location_id": tahoe["id"],
        "target_date": today, "flexibility": "afternoon", "seats_available": 1, "tags": [],
        "for_connection": True,
    }).json()
    trips = api.get("/driver-trips/search", headers=rider_headers).json()
    assert {t["id"] for t in trips} == {real_trip["id"]}
    assert backing_trip["id"] not in {t["id"] for t in trips}

    # Still the owner's, and still reachable through the connection.
    mine = api.get("/me/ride-requests", headers=rider_headers).json()
    assert next(r for r in mine if r["id"] == backing_request["id"])["for_connection"] is True
    conns = api.get("/me/connections", headers=rider_headers).json()
    assert conns[0]["ride_request"]["id"] == backing_request["id"]


def test_migration_backfills_connection_backing_listings_created_before_the_flag() -> None:
    api = client()
    rider, rider_headers, driver, _, real_request, real_trip = make_request_and_trip(api)
    backing = api.post("/ride-requests", headers=rider_headers, json={
        "pickup_location_id": real_request["pickup_location_id"],
        "destination_location_id": real_request["destination_location_id"],
        "target_date": date.today().isoformat(), "flexibility": "morning", "passenger_count": 1, "tags": [],
    }).json()
    assert api.post("/connections", headers=rider_headers, json={
        "ride_request_id": backing["id"], "driver_trip_id": real_trip["id"],
    }).status_code == 200

    # Simulate a database from before the flag existed, then migrate.
    conn = psycopg2.connect(TEST_DATABASE_URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("ALTER TABLE ride_requests DROP COLUMN for_connection")
        cur.execute("ALTER TABLE driver_trips DROP COLUMN for_connection")
    run_migrations(TEST_DATABASE_URL)
    with conn.cursor() as cur:
        cur.execute("SELECT id, for_connection FROM ride_requests")
        flags = dict(cur.fetchall())
        cur.execute("SELECT for_connection FROM driver_trips WHERE id = %s", (real_trip["id"],))
        trip_flag = cur.fetchone()[0]
    conn.close()

    assert flags[backing["id"]] is True          # the initiator's backing request
    assert flags[real_request["id"]] is False    # a real post, never connected by its owner
    assert trip_flag is False                    # the driver's real post (not the initiator)


def test_search_excludes_the_searching_users_own_listings() -> None:
    # Discover is meant to surface *other* people's rides. Without an
    # explicit self-exclusion clause, a driver's own trip (or a rider's own
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
    # whether the hourly expire sweep has run yet — a driver/rider shouldn't
    # see (or be offered) a ride for a date that's already passed. Use a date
    # unambiguously outside the 1-day timezone-safety grace period (see the
    # next test for why exactly "yesterday" is deliberately still visible).
    api = client()
    _, rider_headers = auth(api, "past-rider@example.edu", "Past Rider")
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


def test_search_archives_stale_listings_at_most_once_per_interval() -> None:
    # Discover polls search continuously; archiving on every request kept the
    # database busy around the clock. Stale rows must still be hidden from
    # results immediately, but the archiving UPDATE is throttled.
    store = Store(TEST_DATABASE_URL)
    settings = Settings(database_url=TEST_DATABASE_URL, supabase_url=TEST_SUPABASE_URL, cron_secret=TEST_CRON_SECRET)
    api = TestClient(create_app(store=store, settings=settings))
    _, rider_headers = auth(api, "throttle-rider@example.edu", "Throttle Rider")
    _, driver_headers = auth(api, "throttle-driver@example.com", "Throttle Driver")
    api.get("/driver-trips/search", headers=rider_headers)  # runs the first sweep

    pickup = location(api, driver_headers, "Cambridge", 42.3736, -71.1097)
    destination = location(api, driver_headers, "Providence, RI", 41.8240, -71.4128)
    stale = api.post(
        "/driver-trips", headers=driver_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
            "target_date": (date.today() - timedelta(days=3)).isoformat(),
            "flexibility": "morning", "seats_available": 2, "tags": [],
        },
    ).json()

    def status() -> str:
        return next(t for t in api.get("/me/driver-trips", headers=driver_headers).json() if t["id"] == stale["id"])["status"]

    results = api.get("/driver-trips/search", headers=rider_headers).json()
    assert stale["id"] not in {t["id"] for t in results}
    assert status() == "open"  # hidden, but not re-swept within the interval

    store._last_search_expiry -= Store.SEARCH_EXPIRY_INTERVAL
    api.get("/driver-trips/search", headers=rider_headers)
    assert status() == "expired"


def test_search_keeps_yesterdays_listings_visible_as_a_timezone_safety_buffer() -> None:
    # Regression test: a listing dated "yesterday" by the DB server's (UTC)
    # clock can still be "today" for a rider/driver west of UTC — which is
    # every US timezone. Without this buffer, refreshing the page in the
    # evening could make a same-day listing vanish (and get archived) purely
    # from a UTC-vs-local date mismatch, not because it actually expired.
    api = client()
    _, rider_headers = auth(api, "tz-rider@example.edu", "TZ Rider")
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
    _, rider_headers = auth(api, "rider3@example.edu", "Riley Rider")

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
    rider, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)
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
    _, rider_headers = auth(api, "rider@example.com", "Rider")
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
    rider, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

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
    assert rider["id"] != driver["id"]

    by_type = {n["type"]: n for n in driver_notifications}
    assert by_type["connection_received"]["related_id"] == connection["id"]
    assert by_type["chat_message"]["related_id"] == connection["id"]
    assert by_type["gas_split_confirmed"]["related_id"] == connection["id"]


def test_notifications_mark_all_read_and_dismiss() -> None:
    api = client()
    rider, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

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
    rider, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

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
    rider, rider_headers = auth(client=api, email="rider2@example.edu", name="Riley Rider")

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
    second_rider, second_headers = auth(api, "rider2@example.com", "Second Rider")
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
