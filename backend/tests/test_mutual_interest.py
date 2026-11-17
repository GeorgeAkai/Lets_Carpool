"""Nobody should be left waiting on each other.

The app's "Request" / "Offer" buttons create a fresh listing on the tapper's
side and connect it to the listing they tapped. So a passenger requesting a
driver's trip, and that driver offering on the passenger's request, are two
different (ride_request, driver_trip) pairs. They used to sit as two pending
connections, each waiting on the other person.
"""
from __future__ import annotations

from datetime import date, timedelta

from backend.tests.test_mvp_api import auth, client, location, make_request_and_trip


def _fresh_request(c, rider_headers, day: date | None = None) -> dict:
    pickup = location(c, rider_headers, "9 Oak St, Berkeley, CA", 37.8720, -122.2740)
    destination = location(c, rider_headers, "SFO, San Francisco, CA", 37.6213, -122.3790)
    return c.post("/ride-requests", headers=rider_headers, json={
        "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
        "target_date": (day or date.today()).isoformat(), "flexibility": "flexible",
        "passenger_count": 1, "tags": [],
    }).json()


def _fresh_trip(c, driver_headers, day: date | None = None) -> dict:
    pickup = location(c, driver_headers, "Shattuck Ave, Berkeley, CA", 37.8690, -122.2680)
    destination = location(c, driver_headers, "SFO, San Francisco, CA", 37.6213, -122.3790)
    return c.post("/driver-trips", headers=driver_headers, json={
        "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
        "target_date": (day or date.today()).isoformat(), "flexibility": "flexible",
        "seats_available": 1, "tags": [],
    }).json()


def _live(c, headers) -> list[dict]:
    return [x for x in c.get("/me/connections", headers=headers).json() if x["status"] in ("pending", "accepted")]


def test_request_and_offer_across_different_listings_confirm_one_ride() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=1)

    # Passenger taps "Request" on the driver's trip: a fresh request of their own.
    asked = c.post("/connections", headers=rider_headers, json={
        "ride_request_id": _fresh_request(c, rider_headers)["id"], "driver_trip_id": driver_trip["id"],
    }).json()
    assert asked["status"] == "pending"

    # Driver taps "Offer" on the passenger's original request: a fresh trip of their own.
    offered = c.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": _fresh_trip(c, driver_headers)["id"],
    })
    assert offered.status_code == 200, offered.text

    # Both asked each other for the same day: one confirmed ride, nobody waiting.
    assert offered.json()["id"] == asked["id"]
    assert offered.json()["status"] == "accepted"
    for headers in (rider_headers, driver_headers):
        live = _live(c, headers)
        assert [(x["id"], x["status"]) for x in live] == [(asked["id"], "accepted")]

    # The passenger (who asked first) is told it was accepted.
    types = [n["type"] for n in c.get("/notifications", headers=rider_headers).json()]
    assert "connection_accepted" in types


def test_offer_then_request_across_different_listings_confirm_one_ride() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=1)

    offered = c.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": _fresh_trip(c, driver_headers)["id"],
    }).json()
    assert offered["status"] == "pending"

    asked = c.post("/connections", headers=rider_headers, json={
        "ride_request_id": _fresh_request(c, rider_headers)["id"], "driver_trip_id": driver_trip["id"],
    }).json()
    assert (asked["id"], asked["status"]) == (offered["id"], "accepted")
    assert len(_live(c, rider_headers)) == 1 and len(_live(c, driver_headers)) == 1


def test_a_different_day_is_a_different_ride_and_still_waits() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, _driver_trip = make_request_and_trip(
        c, passenger_count=1)
    tomorrow = date.today() + timedelta(days=1)
    later_trip = _fresh_trip(c, driver_headers, tomorrow)

    asked = c.post("/connections", headers=rider_headers, json={
        "ride_request_id": _fresh_request(c, rider_headers, tomorrow)["id"], "driver_trip_id": later_trip["id"],
    }).json()
    offered = c.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": _fresh_trip(c, driver_headers)["id"],
    }).json()

    assert offered["id"] != asked["id"]
    assert (asked["status"], offered["status"]) == ("pending", "pending")


def test_mutual_interest_that_cannot_be_seated_falls_back_to_a_normal_offer() -> None:
    c = client()
    # The passenger needs 2 seats; the driver's original trip has 1.
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=2, seats_available=1)
    first = c.post("/connections", headers=rider_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"],
    }).json()
    assert first["status"] == "pending"

    roomy = c.post("/driver-trips", headers=driver_headers, json={
        "pickup_location_id": driver_trip["pickup"]["id"], "destination_location_id": driver_trip["destination"]["id"],
        "target_date": date.today().isoformat(), "flexibility": "flexible", "seats_available": 3, "tags": [],
    }).json()
    offered = c.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": roomy["id"],
    })
    assert offered.status_code == 200, offered.text
    # Accepting the first would overbook, so the offer stands on its own for the passenger to accept.
    assert offered.json()["id"] != first["id"] and offered.json()["status"] == "pending"


def test_the_person_asked_gets_a_notification_that_says_who_and_what() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=1)
    c.post("/connections", headers=rider_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]})
    received = [n for n in c.get("/notifications", headers=driver_headers).json() if n["type"] == "connection_received"]
    assert len(received) == 1
    assert received[0]["title"] == "Riley Passenger wants a ride"
    assert "accept" in received[0]["body"].lower()


# ─── Listings made on the fly for "Request" / "Offer" stay out of Discover ────

def _search_trips(c, headers) -> list[dict]:
    return c.get("/driver-trips/search", headers=headers, params={
        "destination_latitude": 37.6213, "destination_longitude": -122.3790,
        "target_date": date.today().isoformat(), "apply_preferences": "false"}).json()


def _search_requests(c, headers) -> list[dict]:
    return c.get("/ride-requests/search", headers=headers, params={
        "destination_latitude": 37.6213, "destination_longitude": -122.3790,
        "target_date": date.today().isoformat()}).json()


def test_a_trip_made_for_an_offer_is_not_a_second_public_listing() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=1)
    pickup = location(c, driver_headers, "Shattuck Ave, Berkeley, CA", 37.8690, -122.2680)
    destination = location(c, driver_headers, "SFO, San Francisco, CA", 37.6213, -122.3790)
    made = c.post("/driver-trips", headers=driver_headers, json={
        "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
        "target_date": date.today().isoformat(), "flexibility": "flexible",
        "seats_available": 1, "tags": [], "unlisted": True,
    })
    assert made.status_code == 200, made.text
    offered = c.post("/connections", headers=driver_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": made.json()["id"]}).json()
    assert offered["status"] == "pending"

    # Passengers browsing still see the one trip the driver posted.
    assert [t["id"] for t in _search_trips(c, rider_headers)] == [driver_trip["id"]]
    # The driver's posted trips do not grow a duplicate either.
    assert [t["id"] for t in c.get("/me/driver-trips", headers=driver_headers).json()] == [driver_trip["id"]]
    # It is never proposed to the passenger as a match for their request.
    proposal = c.get(f"/ride-requests/{ride_request['id']}/proposal", headers=rider_headers).json()
    assert (proposal.get("trip") or {}).get("id") != made.json()["id"]
    # The offer itself works: the passenger sees and can accept it.
    accepted = c.post(f"/connections/{offered['id']}/transition", headers=rider_headers, json={"action": "accept"})
    assert accepted.status_code == 200 and accepted.json()["status"] == "accepted"
    assert accepted.json()["driver_trip"]["id"] == made.json()["id"]


def test_a_request_made_for_one_driver_is_not_a_second_public_listing() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=1)
    pickup = location(c, rider_headers, "9 Oak St, Berkeley, CA", 37.8720, -122.2740)
    destination = location(c, rider_headers, "SFO, San Francisco, CA", 37.6213, -122.3790)
    made = c.post("/ride-requests", headers=rider_headers, json={
        "pickup_location_id": pickup["id"], "destination_location_id": destination["id"],
        "target_date": date.today().isoformat(), "flexibility": "flexible",
        "passenger_count": 1, "tags": [], "unlisted": True,
    }).json()
    asked = c.post("/connections", headers=rider_headers, json={
        "ride_request_id": made["id"], "driver_trip_id": driver_trip["id"]}).json()
    assert asked["status"] == "pending"

    assert [r["id"] for r in _search_requests(c, driver_headers)] == [ride_request["id"]]
    assert [r["id"] for r in c.get("/me/ride-requests", headers=rider_headers).json()] == [ride_request["id"]]
    # No "new match" nudge goes out for a request nobody can browse.
    nudges = [n for n in c.get("/notifications", headers=driver_headers).json() if n["type"] == "new_match"]
    assert all(n.get("related_id") != made["id"] for n in nudges)


def test_a_trip_with_no_seats_left_leaves_discover_and_returns_when_a_seat_frees_up() -> None:
    c = client()
    _passenger, rider_headers, _driver, driver_headers, ride_request, driver_trip = make_request_and_trip(
        c, passenger_count=1, seats_available=1)
    browsing = auth(c, "browser@example.com", "Bo Browser")[1]
    assert [t["id"] for t in _search_trips(c, browsing)] == [driver_trip["id"]]

    asked = c.post("/connections", headers=rider_headers, json={
        "ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]}).json()
    c.post(f"/connections/{asked['id']}/transition", headers=driver_headers, json={"action": "accept"})
    # The only seat is taken: nobody else is shown a ride they cannot request.
    assert _search_trips(c, browsing) == []

    c.post(f"/connections/{asked['id']}/transition", headers=rider_headers, json={"action": "cancel"})
    assert [t["id"] for t in _search_trips(c, browsing)] == [driver_trip["id"]]
