from __future__ import annotations

from datetime import date, timedelta

from fastapi.testclient import TestClient

from backend.app.domain import Store
from backend.app.main import create_app


def client() -> TestClient:
    return TestClient(create_app(store=Store()))


def auth(client: TestClient, email: str, name: str) -> tuple[dict, dict[str, str]]:
    response = client.post("/auth/login", json={"email": email, "name": name})
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


def test_healthcheck_exposes_database_and_postgis_contract() -> None:
    response = client().get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["database"] == {
        "configured": True,
        "engine": "postgresql",
        "postgis_extension": "required",
    }


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

    api.post("/ride-requests/expire", headers=rider_headers, json={"today": date.today().isoformat()})
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


def test_driver_can_offer_ride_and_pending_connections_expire() -> None:
    api = client()
    _, _, _, driver_headers, ride_request, driver_trip = make_request_and_trip(api)

    connection = api.post(
        "/connections",
        headers=driver_headers,
        json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
    ).json()
    api.post("/connections/expire", headers=driver_headers, json={"today": (date.today() + timedelta(days=1)).isoformat()})
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
