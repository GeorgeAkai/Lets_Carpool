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

# ─── Fake Neon Auth server ──────────────────────────────────────────────────────
# /auth/login now cryptographically verifies the Neon Auth session JWT against a
# JWKS endpoint (issue 24) instead of trusting a client-supplied email. To test
# that for real without hitting the actual Neon Auth service, this spins up a
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


def sign_neon_token(*, email: str, name: str, sub: str | None = None, expired: bool = False) -> str:
    now = datetime.now(UTC)
    private_pem = _NEON_AUTH_PRIVATE_KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    payload = {
        "sub": sub or f"neon_{email}",
        "email": email,
        "name": name,
        "iss": TEST_NEON_AUTH_URL,
        "iat": now,
        "exp": now + (timedelta(minutes=-5) if expired else timedelta(hours=24)),
    }
    return pyjwt.encode(payload, private_pem, algorithm="EdDSA", headers={"kid": _NEON_AUTH_KID})


TEST_CRON_SECRET = "test-cron-secret"
CRON_HEADERS = {"Authorization": f"Bearer {TEST_CRON_SECRET}"}


def client() -> TestClient:
    settings = Settings(
        database_url=TEST_DATABASE_URL, neon_auth_url=TEST_NEON_AUTH_URL, cron_secret=TEST_CRON_SECRET,
    )
    return TestClient(create_app(store=Store(TEST_DATABASE_URL), settings=settings))


def auth(client: TestClient, email: str, name: str) -> tuple[dict, dict[str, str]]:
    token = sign_neon_token(email=email, name=name)
    response = client.post("/auth/login", json={"neon_token": token})
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


def test_healthcheck_reports_neon_backed_database() -> None:
    response = client().get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["database"] == "neon"


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


def test_login_rejects_a_token_not_signed_by_the_neon_auth_key() -> None:
    api = client()
    forged_key = Ed25519PrivateKey.generate()
    now = datetime.now(UTC)
    forged_pem = forged_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    forged_token = pyjwt.encode(
        {"sub": "neon_attacker", "email": "victim@berkeley.edu", "name": "Attacker",
         "iss": TEST_NEON_AUTH_URL, "iat": now, "exp": now + timedelta(hours=24)},
        forged_pem, algorithm="EdDSA", headers={"kid": _NEON_AUTH_KID},
    )

    response = api.post("/auth/login", json={"neon_token": forged_token})

    assert response.status_code == 401


def test_login_rejects_an_expired_neon_auth_token() -> None:
    api = client()
    expired_token = sign_neon_token(email="ada@berkeley.edu", name="Ada Lovelace", expired=True)

    response = api.post("/auth/login", json={"neon_token": expired_token})

    assert response.status_code == 401


def test_login_rejects_a_token_with_no_email_claim() -> None:
    api = client()
    now = datetime.now(UTC)
    private_pem = _NEON_AUTH_PRIVATE_KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    )
    no_email_token = pyjwt.encode(
        {"sub": "neon_no_email", "iss": TEST_NEON_AUTH_URL, "iat": now, "exp": now + timedelta(hours=24)},
        private_pem, algorithm="EdDSA", headers={"kid": _NEON_AUTH_KID},
    )

    response = api.post("/auth/login", json={"neon_token": no_email_token})

    assert response.status_code == 401


def test_login_rejects_garbage_input() -> None:
    api = client()

    response = api.post("/auth/login", json={"neon_token": "not.a.jwt"})

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
            "target_date": (date.today() - timedelta(days=1)).isoformat(),
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
