from __future__ import annotations

from backend.app.domain import format_place
from backend.tests.test_mvp_api import auth, client, make_request_and_trip

SUPERADMIN = "ageorge@akihlee.com"


def test_format_place_collapses_repeated_geocoder_parts() -> None:
    assert format_place("Chico, Chico, California") == "Chico, CA"
    assert format_place("Chico State, Chico, California, 95929, United States") == "Chico State, Chico, CA"
    assert format_place(
        "Sacramento International Airport, Sacramento, Sacramento County, California, United States"
    ) == "Sacramento International Airport, Sacramento, CA"


def test_admin_routes_are_restricted_to_the_superadmin() -> None:
    api = client()
    user, headers = auth(api, "someone@example.com", "Some One")

    assert user["is_admin"] is False
    for path in ["/admin/stats", "/admin/users", "/admin/reports", "/admin/destinations", "/admin/audit-logs"]:
        assert api.get(path, headers=headers).status_code == 403
    assert api.get("/admin/stats").status_code == 401


def test_superadmin_sees_kpis_destinations_and_audit_logs() -> None:
    api = client()
    make_request_and_trip(api)
    admin, admin_headers = auth(api, SUPERADMIN.upper(), "Admin")

    assert admin["is_admin"] is True
    stats = api.get("/admin/stats", headers=admin_headers).json()
    assert stats["total_users"] == 3
    assert stats["drivers"] == 1
    assert stats["passengers"] == 1
    assert stats["active_drivers"] == 1
    assert stats["active_riders"] == 1

    destinations = api.get("/admin/destinations", headers=admin_headers).json()
    assert destinations[0] == {"label": "SFO Terminal 2, San Francisco, CA", "trips": 1, "requests": 1, "total": 2}

    logs = api.get("/admin/audit-logs", headers=admin_headers, params={"event_type": "listing."}).json()
    assert {log["event_type"] for log in logs} == {"listing.ride_request_created", "listing.driver_trip_created"}
    assert all(log["ip_address"] for log in logs)


def test_superadmin_can_block_and_unblock_users() -> None:
    api = client()
    target, target_headers = auth(api, "target@example.com", "Tar Get")
    admin, admin_headers = auth(api, SUPERADMIN, "Admin")

    users = api.get("/admin/users", headers=admin_headers, params={"q": "tar"}).json()
    assert [u["email"] for u in users] == ["target@example.com"]

    assert api.post(f"/admin/users/{target['id']}/block", headers=admin_headers).json()["suspended"] is True
    assert api.get("/me", headers=target_headers).status_code == 403
    assert api.get("/admin/stats", headers=admin_headers).json()["blocked_users"] == 1

    assert api.post(f"/admin/users/{target['id']}/unblock", headers=admin_headers).json()["suspended"] is False
    assert api.get("/me", headers=target_headers).status_code == 200

    assert api.post(f"/admin/users/{admin['id']}/block", headers=admin_headers).status_code == 400


def test_superadmin_reviews_the_reported_users_queue() -> None:
    api = client()
    reporter, reporter_headers = auth(api, "reporter@example.com", "Rep Orter")
    reported, reported_headers = auth(api, "reported@example.com", "Rep Orted")
    _, admin_headers = auth(api, SUPERADMIN, "Admin")
    first = api.post(f"/users/{reported['id']}/report", headers=reporter_headers, json={"reason": "No-show"}).json()
    second = api.post(f"/users/{reported['id']}/report", headers=reporter_headers, json={"reason": "Rude"}).json()

    queue = api.get("/admin/reports", headers=admin_headers).json()
    assert {r["id"] for r in queue} == {first["id"], second["id"]}
    assert queue[0]["reported_email"] == "reported@example.com"

    assert api.post(f"/admin/reports/{first['id']}/dismiss", headers=admin_headers).json()["status"] == "dismissed"
    assert api.post(f"/admin/reports/{second['id']}/suspend", headers=admin_headers).json()["status"] == "actioned"

    assert api.get("/admin/reports", headers=admin_headers).json() == []
    assert api.get("/me", headers=reported_headers).status_code == 403
    assert len(api.get("/admin/reports", headers=admin_headers, params={"status": "all"}).json()) == 2
