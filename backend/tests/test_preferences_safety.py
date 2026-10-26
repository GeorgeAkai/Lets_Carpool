from __future__ import annotations

from datetime import date

from backend.tests.test_mvp_api import auth, client, location, make_request_and_trip
from backend.tests.test_trip_features import ADMIN_EMAIL, _connect_and_accept


def _search(api, headers, **params):
    query = {"destination_latitude": 37.6213, "destination_longitude": -122.3790,
             "destination_radius_meters": 5000, "target_date": date.today().isoformat(), **params}
    resp = api.get("/driver-trips/search", headers=headers, params=query)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _post_trip(api, headers, label="Downtown Berkeley, CA"):
    pickup = location(api, headers, label, 37.8700, -122.2700)
    dest = location(api, headers, "SFO Terminal 2, San Francisco, CA", 37.6213, -122.3790)
    resp = api.post("/driver-trips", headers=headers, json={
        "pickup_location_id": pickup["id"], "destination_location_id": dest["id"],
        "target_date": date.today().isoformat(), "flexibility": "morning", "seats_available": 3,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


def _complete(api, rider_headers, driver_headers, conn_id):
    resp = api.post(f"/connections/{conn_id}/transition", headers=driver_headers, json={"action": "complete"})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_onboarding_is_recorded_once() -> None:
    api = client()
    user, headers = auth(api, "new@example.com", "New Person")
    assert user["onboarded_at"] is None

    first = api.post("/me/onboarding/complete", headers=headers).json()["onboarded_at"]
    again = api.post("/me/onboarding/complete", headers=headers).json()["onboarded_at"]

    assert first is not None and again == first


def test_preferences_default_then_partial_update() -> None:
    api = client()
    _, headers = auth(api, "rider@example.com", "Riley Rider")

    assert api.get("/me/preferences", headers=headers).json() == {
        "max_walk_minutes": None, "vibes": [], "verified_only": False,
        "women_only": False, "coworkers_first": False, "route_checkins": True,
    }
    resp = api.patch("/me/preferences", headers=headers, json={"max_walk_minutes": 10, "vibes": ["quiet", "room_for_bags"]})
    assert resp.status_code == 200
    resp = api.patch("/me/preferences", headers=headers, json={"verified_only": True})
    prefs = resp.json()
    assert prefs["max_walk_minutes"] == 10 and prefs["verified_only"] is True
    assert prefs["vibes"] == ["quiet", "room_for_bags"]

    bad = api.patch("/me/preferences", headers=headers, json={"vibes": ["karaoke"]})
    assert bad.status_code == 400


def test_women_only_requires_a_self_declared_woman_and_filters_drivers() -> None:
    api = client()
    _, rider_headers = auth(api, "rider@example.com", "Riley Rider")
    _, man_headers = auth(api, "dan@example.com", "Dan Driver")
    _, woman_headers = auth(api, "wendy@example.com", "Wendy Driver")
    _post_trip(api, man_headers)
    _post_trip(api, woman_headers)
    api.patch("/me/profile", headers=woman_headers, json={"display_name": "Wendy Driver", "gender": "woman"})

    assert api.patch("/me/preferences", headers=rider_headers, json={"women_only": True}).status_code == 403
    api.patch("/me/profile", headers=rider_headers, json={"display_name": "Riley Rider", "gender": "woman"})
    assert api.patch("/me/preferences", headers=rider_headers, json={"women_only": True}).status_code == 200

    names = [t["driver_name"] for t in _search(api, rider_headers)]
    assert names == ["Wendy Driver"]
    # Gender is never shown to other users.
    trip = _search(api, rider_headers)[0]
    assert "gender" not in (api.get(f"/users/{trip['driver_id']}/profile", headers=rider_headers).json())
    # Opting out of preferences shows everyone again.
    assert len(_search(api, rider_headers, apply_preferences=False)) == 2


def test_verified_only_and_coworkers_first_shape_search() -> None:
    api = client()
    _, rider_headers = auth(api, "riley@acme.io", "Riley Rider")
    _, coworker_headers = auth(api, "casey@acme.io", "Casey Coworker")
    stranger, stranger_headers = auth(api, "sam@gmail.com", "Sam Stranger")
    _, admin_headers = auth(api, ADMIN_EMAIL, "Admin")
    api.patch("/me/preferences", headers=coworker_headers, json={"vibes": ["quiet", "music_ok"]})
    _post_trip(api, coworker_headers)
    _post_trip(api, stranger_headers)  # newer, so first by default

    api.patch("/me/preferences", headers=rider_headers, json={"coworkers_first": True, "vibes": ["quiet"]})
    trips = _search(api, rider_headers)
    assert [t["driver_name"] for t in trips] == ["Casey Coworker", "Sam Stranger"]
    assert trips[0]["is_coworker"] is True and trips[0]["shared_vibes"] == ["quiet"]
    assert trips[0]["vibes"] == ["music_ok", "quiet"]
    assert trips[1]["is_coworker"] is False

    api.post(f"/admin/users/{stranger['id']}/verify-id", headers=admin_headers)
    api.patch("/me/preferences", headers=rider_headers, json={"verified_only": True})
    assert [t["driver_name"] for t in _search(api, rider_headers)] == ["Sam Stranger"]


def test_max_walk_narrows_the_pickup_radius() -> None:
    api = client()
    _, rider_headers = auth(api, "rider@example.com", "Riley Rider")
    _, driver_headers = auth(api, "driver@example.com", "Dee Driver")
    _post_trip(api, driver_headers)  # starts at 37.8700, -122.2700
    # ~1.1 km from the trip's start: inside the 5 km default, outside a 5-minute walk.
    params = {"pickup_latitude": 37.8800, "pickup_longitude": -122.2700}

    assert len(_search(api, rider_headers, **params)) == 1
    api.patch("/me/preferences", headers=rider_headers, json={"max_walk_minutes": 5})
    assert _search(api, rider_headers, **params) == []


def test_ride_pin_is_only_shown_to_the_rider_and_checked_by_the_driver() -> None:
    api = client()
    _, rider_headers, _, driver_headers, conn = _connect_and_accept(api)

    rider_view = next(c for c in api.get("/me/connections", headers=rider_headers).json() if c["id"] == conn["id"])
    driver_view = next(c for c in api.get("/me/connections", headers=driver_headers).json() if c["id"] == conn["id"])
    pin = rider_view["ride_pin"]
    assert pin and len(pin) == 4 and pin.isdigit()
    assert driver_view["ride_pin"] is None
    assert rider_view["responded_at"] is not None

    wrong = "0000" if pin != "0000" else "1111"
    assert api.post(f"/connections/{conn['id']}/verify-pin", headers=driver_headers, json={"pin": wrong}).status_code == 409
    assert api.post(f"/connections/{conn['id']}/verify-pin", headers=rider_headers, json={"pin": pin}).status_code == 403
    ok = api.post(f"/connections/{conn['id']}/verify-pin", headers=driver_headers, json={"pin": pin})
    assert ok.status_code == 200 and ok.json()["pin_verified_at"] is not None
    assert ok.json()["ride_pin"] is None


def test_completing_a_ride_writes_a_receipt_with_the_settle_up_method() -> None:
    api = client()
    rider, rider_headers, driver, driver_headers, conn = _connect_and_accept(api)
    api.put("/me/settlement", headers=driver_headers, json={"method": "venmo", "handle": "@dee-drives"})

    accepted = next(c for c in api.get("/me/connections", headers=rider_headers).json() if c["id"] == conn["id"])
    assert accepted["settlement"] == {"method": "venmo", "handle": "@dee-drives", "updated_at": accepted["settlement"]["updated_at"]}

    assert api.get(f"/connections/{conn['id']}/receipt", headers=rider_headers).status_code == 404
    _complete(api, rider_headers, driver_headers, conn["id"])

    receipt = api.get(f"/connections/{conn['id']}/receipt", headers=rider_headers).json()
    assert receipt["receipt_number"].startswith("CP-")
    assert receipt["driver_name"] == "Dee Driver"
    assert receipt["seats"] == 2
    assert receipt["amount_cents"] == receipt["price_per_seat_cents"] * 2
    assert receipt["settlement_method"] == "venmo"
    assert api.get(f"/connections/{conn['id']}/receipt", headers=driver_headers).json()["id"] == receipt["id"]
    _, outsider_headers = auth(api, "outsider@example.com", "Out Sider")
    assert api.get(f"/connections/{conn['id']}/receipt", headers=outsider_headers).status_code == 404
    assert [r["id"] for r in api.get("/me/receipts", headers=rider_headers).json()] == [receipt["id"]]

    rider_impact = api.get("/me/impact", headers=rider_headers).json()
    assert rider_impact["shared_trips"] == 1
    assert rider_impact["saved_cents"] == max(0, receipt["gas_cost_cents"] - receipt["amount_cents"])
    assert api.get("/me/impact", headers=driver_headers).json()["saved_cents"] == receipt["amount_cents"]


def test_rating_tags_and_ride_buddies_after_a_completed_ride() -> None:
    api = client()
    rider, rider_headers, driver, driver_headers, conn = _connect_and_accept(api)

    # Only people you've finished a ride with can become buddies.
    assert api.put(f"/me/buddies/{driver['id']}", headers=rider_headers).status_code == 403
    _complete(api, rider_headers, driver_headers, conn["id"])

    bad = api.post(f"/connections/{conn['id']}/rating", headers=rider_headers, json={"stars": 5, "tags": ["fast"]})
    assert bad.status_code == 400
    rated = api.post(f"/connections/{conn['id']}/rating", headers=rider_headers,
                     json={"stars": 5, "tags": ["on_time", "clean_car"]})
    assert rated.status_code == 200 and rated.json()["tags"] == ["clean_car", "on_time"]
    stats = api.get(f"/users/{driver['id']}/profile", headers=rider_headers).json()
    assert {t["tag"] for t in stats["top_rating_tags"]} == {"on_time", "clean_car"}
    assert stats["median_response_minutes"] == 1

    assert api.put(f"/me/buddies/{driver['id']}", headers=rider_headers).status_code == 200
    buddies = api.get("/me/buddies", headers=rider_headers).json()
    assert [b["display_name"] for b in buddies] == ["Dee Driver"]
    api.delete(f"/me/buddies/{driver['id']}", headers=rider_headers)
    assert api.get("/me/buddies", headers=rider_headers).json() == []


def test_saved_places_keep_one_home_and_one_work() -> None:
    api = client()
    _, headers = auth(api, "rider@example.com", "Riley Rider")
    a = location(api, headers, "12 Elm St", 37.87, -122.27)
    b = location(api, headers, "40 Oak Ave", 37.88, -122.26)
    c = location(api, headers, "1 Market St", 37.79, -122.39)

    api.post("/me/places", headers=headers, json={"kind": "home", "location_id": a["id"]})
    api.post("/me/places", headers=headers, json={"kind": "work", "location_id": c["id"]})
    api.post("/me/places", headers=headers, json={"kind": "home", "location_id": b["id"]})  # moved house
    gym = api.post("/me/places", headers=headers, json={"kind": "other", "label": "Gym", "location_id": a["id"]}).json()

    places = api.get("/me/places", headers=headers).json()
    assert [(p["kind"], p["label"], p["location"]["label"]) for p in places] == [
        ("home", "Home", "40 Oak Ave"), ("work", "Work", "1 Market St"), ("other", "Gym", "12 Elm St"),
    ]
    assert api.delete(f"/me/places/{gym['id']}", headers=headers).status_code == 200
    assert len(api.get("/me/places", headers=headers).json()) == 2


def test_emergency_contacts_crud_and_validation() -> None:
    api = client()
    _, headers = auth(api, "rider@example.com", "Riley Rider")

    assert api.post("/me/emergency-contacts", headers=headers, json={"name": "Alex", "phone": "nope"}).status_code == 400
    alex = api.post("/me/emergency-contacts", headers=headers,
                    json={"name": "Alex", "relationship": "partner", "phone": "+1 555 0100"}).json()
    api.post("/me/emergency-contacts", headers=headers,
             json={"name": "Mom", "phone": "+1 555 0101", "share_mode": "night_only"})
    api.patch(f"/me/emergency-contacts/{alex['id']}", headers=headers, json={"share_mode": "off"})

    contacts = api.get("/me/emergency-contacts", headers=headers).json()
    assert [(c["name"], c["share_mode"]) for c in contacts] == [("Alex", "off"), ("Mom", "night_only")]
    assert "user_id" not in contacts[0]
    _, other_headers = auth(api, "other@example.com", "Other")
    assert api.delete(f"/me/emergency-contacts/{alex['id']}", headers=other_headers).status_code == 404


def test_trip_report_targets_the_other_participant_with_a_category() -> None:
    api = client()
    rider, rider_headers, driver, driver_headers, conn = _connect_and_accept(api)
    _, admin_headers = auth(api, ADMIN_EMAIL, "Admin")

    resp = api.post(f"/connections/{conn['id']}/report", headers=rider_headers,
                    json={"category": "driving", "reason": "Ran two red lights"})
    assert resp.status_code == 200
    report = resp.json()
    assert report["reported_user_id"] == driver["id"]
    assert report["connection_id"] == conn["id"] and report["category"] == "driving"
    _, outsider_headers = auth(api, "outsider@example.com", "Out Sider")
    assert api.post(f"/connections/{conn['id']}/report", headers=outsider_headers,
                    json={"reason": "?"}).status_code == 403
    queued = api.get("/admin/reports", headers=admin_headers).json()
    assert queued[0]["category"] == "driving"


def test_settlement_preference_never_stores_card_details() -> None:
    api = client()
    _, headers = auth(api, "driver@example.com", "Dee Driver")
    assert api.get("/me/settlement", headers=headers).json() is None
    assert api.put("/me/settlement", headers=headers, json={"method": "card", "handle": "4242"}).status_code == 422
    cash = api.put("/me/settlement", headers=headers, json={"method": "cash", "handle": "ignored"}).json()
    assert cash["method"] == "cash" and cash["handle"] is None
