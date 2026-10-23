from __future__ import annotations

from datetime import date, timedelta

from backend.tests.test_mvp_api import auth, client, location, make_request_and_trip

ADMIN_EMAIL = "ageorge@akihlee.com"


def _post_trip(api, headers, **extra):
    pickup = location(api, headers, "Downtown Berkeley, CA", 37.8700, -122.2700)
    dest = location(api, headers, "SFO Terminal 2, San Francisco, CA", 37.6213, -122.3790)
    body = {
        "pickup_location_id": pickup["id"], "destination_location_id": dest["id"],
        "target_date": date.today().isoformat(), "flexibility": "morning", "seats_available": 3,
        **extra,
    }
    resp = api.post("/driver-trips", headers=headers, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _connect_and_accept(api):
    passenger, rider_headers, driver, driver_headers, rr, trip = make_request_and_trip(api)
    conn = api.post("/connections", headers=rider_headers,
                    json={"ride_request_id": rr["id"], "driver_trip_id": trip["id"]}).json()
    accepted = api.post(f"/connections/{conn['id']}/transition", headers=driver_headers, json={"action": "accept"})
    assert accepted.status_code == 200
    return passenger, rider_headers, driver, driver_headers, conn


def test_trip_carries_departure_time_arrival_and_price() -> None:
    api = client()
    _, headers = auth(api, "driver@example.com", "Dee Driver")

    trip = _post_trip(api, headers, departure_time="08:10")

    assert trip["departure_time"] == "08:10:00"
    assert trip["estimated_arrival_time"] > "08:10:00"
    pricing = trip["pricing"]
    assert pricing["split_between"] == 4
    assert pricing["price_per_seat_cents"] == pricing["suggested_price_cents"] >= 100

    priced = _post_trip(api, headers, price_per_seat_cents=450)
    assert priced["pricing"]["price_per_seat_cents"] == 450


def test_price_preview_splits_gas_between_driver_and_seats() -> None:
    api = client()
    _, headers = auth(api, "driver@example.com", "Dee Driver")
    a = location(api, headers, "A", 37.87, -122.27)
    b = location(api, headers, "B", 37.62, -122.38)

    one = api.post("/driver-trips/price-preview", headers=headers,
                   json={"pickup_location_id": a["id"], "destination_location_id": b["id"], "seats_available": 1}).json()
    three = api.post("/driver-trips/price-preview", headers=headers,
                     json={"pickup_location_id": a["id"], "destination_location_id": b["id"], "seats_available": 3}).json()

    assert one["gas_cost_cents"] == three["gas_cost_cents"]
    assert one["suggested_price_cents"] > three["suggested_price_cents"]


def test_repeat_on_weekdays_posts_one_trip_per_day() -> None:
    api = client()
    _, headers = auth(api, "driver@example.com", "Dee Driver")
    start = date.today() + timedelta(days=(7 - date.today().weekday()) % 7)  # next Monday (or today)

    trip = _post_trip(api, headers, target_date=start.isoformat(), repeat_weekdays=[0, 1, 2, 3, 4])

    assert len(trip["series_trip_ids"]) == 5
    mine = api.get("/me/driver-trips", headers=headers).json()
    assert {t["series_id"] for t in mine} == {trip["series_id"]}
    assert sorted(t["target_date"] for t in mine) == [(start + timedelta(days=i)).isoformat() for i in range(5)]


def test_plate_and_phone_unlock_only_after_acceptance() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, rr, trip = make_request_and_trip(api)
    api.put("/me/driver-readiness", headers=driver_headers, json={"make": "Honda", "model": "Civic", "plate": "8kxr 214"})
    api.patch("/me/profile", headers=driver_headers, json={"display_name": "Dee Driver", "phone": "+1 555 123 4567"})

    search = api.get("/driver-trips/search", headers=rider_headers).json()
    assert search[0]["vehicle"]["model"] == "Civic"
    assert "plate" not in search[0]["vehicle"]

    conn = api.post("/connections", headers=rider_headers,
                    json={"ride_request_id": rr["id"], "driver_trip_id": trip["id"]}).json()
    assert "plate" not in conn["driver_trip"]["vehicle"]
    assert "phone" not in conn["driver_profile"]

    api.post(f"/connections/{conn['id']}/transition", headers=driver_headers, json={"action": "accept"})
    accepted = api.get("/me/connections", headers=rider_headers).json()[0]
    assert accepted["driver_trip"]["vehicle"]["plate"] == "8KXR 214"
    assert accepted["driver_profile"]["phone"] == "+1 555 123 4567"

    # Omitting phone on a later profile save keeps it.
    api.patch("/me/profile", headers=driver_headers, json={"display_name": "Dee D"})
    assert api.get("/me", headers=driver_headers).json()["profile"]["phone"] == "+1 555 123 4567"


def test_ratings_feed_public_trust_stats() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, conn = _connect_and_accept(api)

    early = api.post(f"/connections/{conn['id']}/rating", headers=rider_headers, json={"stars": 5})
    assert early.status_code == 400  # not completed yet

    api.post(f"/connections/{conn['id']}/transition", headers=driver_headers, json={"action": "complete"})
    assert api.post(f"/connections/{conn['id']}/rating", headers=rider_headers, json={"stars": 4}).status_code == 200
    api.post(f"/connections/{conn['id']}/rating", headers=rider_headers, json={"stars": 5})  # re-rating replaces

    profile = api.get(f"/users/{driver['id']}/profile", headers=rider_headers).json()
    assert profile["rating_avg"] == 5.0
    assert profile["rating_count"] == 1
    assert profile["completed_trips"] == 1
    assert profile["id_verified"] is False
    assert api.get("/me/connections", headers=rider_headers).json()[0]["my_rating"] == 5


def test_admin_id_verification_enables_auto_accept() -> None:
    api = client()
    _, admin_headers = auth(api, ADMIN_EMAIL, "Admin")
    passenger, rider_headers = auth(api, "passenger@example.edu", "Riley Passenger")
    _, driver_headers = auth(api, "driver@example.com", "Dee Driver")
    trip = _post_trip(api, driver_headers, auto_accept_verified=True)
    pickup = location(api, rider_headers, "Pickup", 37.87, -122.27)
    dest = location(api, rider_headers, "Dest", 37.62, -122.38)

    def request():
        return api.post("/ride-requests", headers=rider_headers, json={
            "pickup_location_id": pickup["id"], "destination_location_id": dest["id"],
            "target_date": date.today().isoformat(), "flexibility": "morning", "passenger_count": 1}).json()

    unverified = api.post("/connections", headers=rider_headers,
                          json={"ride_request_id": request()["id"], "driver_trip_id": trip["id"]}).json()
    assert unverified["status"] == "pending"

    assert api.post(f"/admin/users/{passenger['id']}/verify-id", headers=admin_headers).json()["id_verified"] is True
    verified = api.post("/connections", headers=rider_headers,
                        json={"ride_request_id": request()["id"], "driver_trip_id": trip["id"]}).json()
    assert verified["status"] == "accepted"

    assert api.post(f"/admin/users/{passenger['id']}/verify-id", headers=rider_headers).status_code == 403


def test_saved_routes_crud() -> None:
    api = client()
    _, headers = auth(api, "passenger@example.edu", "Riley Passenger")
    home = location(api, headers, "Home", 37.87, -122.27)
    work = location(api, headers, "Work", 37.79, -122.40)

    created = api.post("/me/routes", headers=headers, json={
        "label": "Home → Work", "pickup_location_id": home["id"], "destination_location_id": work["id"],
        "departure_time": "08:10", "weekdays": [4, 0, 1, 1]}).json()
    assert created["weekdays"] == [0, 1, 4]
    assert created["destination"]["label"] == "Work"

    assert [r["label"] for r in api.get("/me/routes", headers=headers).json()] == ["Home → Work"]
    assert api.delete(f"/me/routes/{created['id']}", headers=headers).status_code == 200
    assert api.get("/me/routes", headers=headers).json() == []


def test_ride_alert_notifies_once_when_a_matching_trip_is_posted() -> None:
    api = client()
    _, rider_headers = auth(api, "passenger@example.edu", "Riley Passenger")
    _, driver_headers = auth(api, "driver@example.com", "Dee Driver")
    near_sfo = location(api, rider_headers, "Near SFO", 37.6250, -122.3800)
    api.post("/ride-alerts", headers=rider_headers,
             json={"destination_location_id": near_sfo["id"], "target_date": date.today().isoformat()})

    _post_trip(api, driver_headers)
    _post_trip(api, driver_headers)

    alerts = [n for n in api.get("/notifications", headers=rider_headers).json() if n["type"] == "ride_alert"]
    assert len(alerts) == 1


def test_trip_day_live_status_and_pickup_check_in() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, conn = _connect_and_accept(api)

    before = api.get(f"/connections/{conn['id']}/live", headers=rider_headers).json()
    assert before["driver"] is None

    api.put("/me/location", headers=driver_headers, json={"latitude": 37.8650, "longitude": -122.2700})
    live = api.get(f"/connections/{conn['id']}/live", headers=rider_headers).json()
    assert live["driver"]["distance_to_pickup_m"] > 0
    assert live["driver"]["eta_minutes"] >= 0

    assert api.post(f"/connections/{conn['id']}/at-pickup", headers=driver_headers).status_code == 403
    checked_in = api.post(f"/connections/{conn['id']}/at-pickup", headers=rider_headers).json()
    assert checked_in["rider_at_pickup_at"]
    assert any(n["type"] == "rider_at_pickup" for n in api.get("/notifications", headers=driver_headers).json())

    _, stranger_headers = auth(api, "stranger@example.com", "Stranger")
    assert api.get(f"/connections/{conn['id']}/live", headers=stranger_headers).status_code == 403


def test_driver_can_pause_resume_and_edit_a_trip() -> None:
    api = client()
    _, headers = auth(api, "driver@example.com", "Dee Driver")
    _, rider_headers = auth(api, "passenger@example.com", "Rae Passenger")
    trip = _post_trip(api, headers)

    paused = api.post(f"/driver-trips/{trip['id']}/pause", headers=headers)
    assert paused.json()["status"] == "paused"
    assert api.post(f"/driver-trips/{trip['id']}/pause", headers=headers).status_code == 400
    assert api.post(f"/driver-trips/{trip['id']}/pause", headers=rider_headers).status_code == 403
    found = api.get("/driver-trips/search", headers=rider_headers).json()
    assert trip["id"] not in {t["id"] for t in found}

    resumed = api.post(f"/driver-trips/{trip['id']}/resume", headers=headers).json()
    assert resumed["status"] == "open"
    found = api.get("/driver-trips/search", headers=rider_headers).json()
    assert trip["id"] in {t["id"] for t in found}

    edited = api.patch(f"/driver-trips/{trip['id']}", headers=headers,
                       json={"seats_available": 2, "notes": "Leaving a bit early", "departure_time": "07:30"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["seats_available"] == 2
    assert edited.json()["notes"] == "Leaving a bit early"
    assert api.patch(f"/driver-trips/{trip['id']}", headers=rider_headers, json={"seats_available": 1}).status_code == 403


def test_pickup_then_completion_settles_the_automatic_fare() -> None:
    api = client()
    passenger, rider_headers, driver, driver_headers, conn = _connect_and_accept(api)

    assert api.post(f"/connections/{conn['id']}/picked-up", headers=rider_headers).status_code == 403
    live = api.get(f"/connections/{conn['id']}/live", headers=rider_headers).json()
    assert live["picked_up_at"] is None and live["destination"]["label"]

    picked = api.post(f"/connections/{conn['id']}/picked-up", headers=driver_headers).json()
    assert picked["picked_up_at"] is not None
    assert picked["fare"]["status"] == "estimated" and picked["fare"]["amount_cents"] >= 100

    done = api.post(f"/connections/{conn['id']}/transition", headers=driver_headers, json={"action": "complete"}).json()
    assert done["fare"]["status"] == "paid"
    assert done["fare"]["amount_cents"] == picked["fare"]["amount_cents"]
    rider_types = {n["type"] for n in api.get("/notifications", headers=rider_headers).json()}
    driver_types = {n["type"] for n in api.get("/notifications", headers=driver_headers).json()}
    assert "payment_processed" in rider_types and "payment_processed" in driver_types

    # Both sides can rate each other.
    assert api.post(f"/connections/{conn['id']}/rating", headers=rider_headers, json={"stars": 5}).status_code == 200
    assert api.post(f"/connections/{conn['id']}/rating", headers=driver_headers, json={"stars": 4}).status_code == 200
