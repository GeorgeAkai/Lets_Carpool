from __future__ import annotations

from backend.tests.test_mvp_api import auth, client, location

ADMIN_EMAIL = "ageorge@akihlee.com"


def test_non_admin_cannot_reach_admin_routes() -> None:
    c = client()
    _, headers = auth(c, "rando@example.com", "Rando")
    assert c.get("/admin/stats", headers=headers).status_code == 403
    assert c.get("/admin/users", headers=headers).status_code == 403


def test_admin_stats_and_user_list() -> None:
    c = client()
    _, admin_headers = auth(c, ADMIN_EMAIL, "Admin")
    _, rider_headers = auth(c, "rider@example.com", "Rider")

    stats = c.get("/admin/stats", headers=admin_headers).json()
    assert stats["total_users"] == 2

    users = c.get("/admin/users", headers=admin_headers).json()
    assert users["total"] == 2
    emails = {u["email"] for u in users["users"]}
    assert {"rider@example.com", ADMIN_EMAIL} == emails


def test_suspend_locks_out_user_and_hides_listings() -> None:
    c = client()
    _, admin_headers = auth(c, ADMIN_EMAIL, "Admin")
    rider, rider_headers = auth(c, "rider2@example.com", "Rider Two")

    pickup = location(c, rider_headers, "Pickup", 37.0, -122.0)
    dest = location(c, rider_headers, "Dest", 37.5, -122.5)
    resp = c.post(
        "/ride-requests", headers=rider_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": dest["id"],
            "target_date": "2099-01-01", "flexibility": "exact", "passenger_count": 1,
        },
    )
    assert resp.status_code == 200

    other_user_headers = auth(c, "searcher@example.com", "Searcher")[1]
    visible = c.get(
        "/ride-requests/search",
        headers=other_user_headers,
        params={"destination_latitude": 37.5, "destination_longitude": -122.5, "destination_radius_meters": 5000},
    ).json()
    assert any(r["rider_id"] == rider["id"] for r in visible)

    suspend_resp = c.post(f"/admin/users/{rider['id']}/suspend", headers=admin_headers, json={"reason": "test"})
    assert suspend_resp.status_code == 200
    assert suspend_resp.json()["status"] == "suspended"

    # Locked out entirely, even with a still-valid JWT.
    assert c.get("/me", headers=rider_headers).status_code == 403

    visible_after = c.get(
        "/ride-requests/search",
        headers=other_user_headers,
        params={"destination_latitude": 37.5, "destination_longitude": -122.5, "destination_radius_meters": 5000},
    ).json()
    assert not any(r["rider_id"] == rider["id"] for r in visible_after)

    unsuspend_resp = c.post(f"/admin/users/{rider['id']}/unsuspend", headers=admin_headers)
    assert unsuspend_resp.status_code == 200
    assert unsuspend_resp.json()["status"] == "active"
    assert c.get("/me", headers=rider_headers).status_code == 200


def test_admin_cannot_suspend_self() -> None:
    c = client()
    admin, admin_headers = auth(c, ADMIN_EMAIL, "Admin")
    resp = c.post(f"/admin/users/{admin['id']}/suspend", headers=admin_headers, json={})
    assert resp.status_code == 400


def test_reports_queue_dismiss_and_block() -> None:
    c = client()
    _, admin_headers = auth(c, ADMIN_EMAIL, "Admin")
    reporter, reporter_headers = auth(c, "reporter@example.com", "Reporter")
    target, _ = auth(c, "target@example.com", "Target")

    report_resp = c.post(f"/users/{target['id']}/report", headers=reporter_headers, json={"reason": "spam"})
    assert report_resp.status_code == 200
    report = report_resp.json()

    reports = c.get("/admin/reports", headers=admin_headers).json()
    assert any(r["id"] == report["id"] and r["reported_email"] == "target@example.com" for r in reports)

    dismiss_resp = c.post(f"/admin/reports/{report['id']}/dismiss", headers=admin_headers)
    assert dismiss_resp.status_code == 200
    assert dismiss_resp.json()["status"] == "dismissed"

    report2_resp = c.post(f"/users/{target['id']}/report", headers=reporter_headers, json={"reason": "harassment"})
    report2 = report2_resp.json()
    block_resp = c.post(f"/admin/reports/{report2['id']}/block", headers=admin_headers)
    assert block_resp.status_code == 200
    assert block_resp.json()["status"] == "suspended"


def test_popular_destinations_and_active_routes() -> None:
    c = client()
    _, admin_headers = auth(c, ADMIN_EMAIL, "Admin")
    _, rider_headers = auth(c, "rider3@example.com", "Rider Three")

    pickup = location(c, rider_headers, "Pickup", 37.0, -122.0)
    dest = location(c, rider_headers, "SMF Airport", 38.6, -121.5)
    c.post(
        "/ride-requests", headers=rider_headers,
        json={
            "pickup_location_id": pickup["id"], "destination_location_id": dest["id"],
            "target_date": "2099-01-01", "flexibility": "exact", "passenger_count": 1,
        },
    )

    popular = c.get("/admin/destinations/popular", headers=admin_headers).json()
    assert any(d["label"] == "SMF Airport" and d["trip_count"] >= 1 for d in popular)

    active = c.get("/admin/routes/active", headers=admin_headers).json()
    assert any(r["destination_label"] == "SMF Airport" for r in active["ride_requests"])

    request_id = c.get("/me/ride-requests", headers=rider_headers).json()[0]["id"]
    remove_resp = c.post(f"/admin/routes/ride-requests/{request_id}/remove", headers=admin_headers)
    assert remove_resp.status_code == 200
    assert remove_resp.json()["status"] == "cancelled"


def test_audit_log_records_key_events() -> None:
    c = client()
    _, admin_headers = auth(c, ADMIN_EMAIL, "Admin")
    auth(c, "newuser@example.com", "New User")
    c.post("/auth/login", json={"neon_token": "not-a-real-token"})

    logs = c.get("/admin/audit-logs", headers=admin_headers).json()
    event_types = {l["event_type"] for l in logs}
    assert "USER_REGISTERED" in event_types
    assert "LOGIN_FAILED" in event_types

    filtered = c.get("/admin/audit-logs", headers=admin_headers, params={"event_type": "USER_REGISTERED"}).json()
    assert all(l["event_type"] == "USER_REGISTERED" for l in filtered)
