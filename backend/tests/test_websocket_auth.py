import pytest
from starlette.websockets import WebSocketDisconnect

from backend.tests.test_mvp_api import auth, client


def _token(headers: dict[str, str]) -> str:
    return headers["Authorization"].removeprefix("Bearer ")


def test_websocket_requires_a_token_for_that_user():
    c = client()
    me, my_headers = auth(c, "ws-me@example.com", "Wes Me")
    other, other_headers = auth(c, "ws-other@example.com", "Olive Other")

    # No token: refused at the handshake, not left open as "anonymous".
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect(f"/ws/{me['id']}"):
            pass
    assert exc.value.code == 4001

    # Garbage token, and a valid token for a different user: refused.
    for bad in ("not-a-jwt", _token(other_headers)):
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect(f"/ws/{me['id']}?token={bad}"):
                pass

    # The right token connects and gets a pong.
    with c.websocket_connect(f"/ws/{me['id']}?token={_token(my_headers)}") as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_driver_offer_is_pushed_to_the_passenger_socket():
    from backend.tests.test_mvp_api import make_request_and_trip

    c = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(c)

    with c.websocket_connect(f"/ws/{passenger['id']}?token={_token(rider_headers)}") as ws:
        connection = c.post(
            "/connections",
            headers=driver_headers,
            json={"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]},
        ).json()
        assert ws.receive_json() == {"type": "pickup_updated", "connection_id": connection["id"]}


def test_mutual_requests_confirm_instead_of_both_waiting():
    from backend.tests.test_mvp_api import make_request_and_trip

    c = client()
    passenger, rider_headers, driver, driver_headers, ride_request, driver_trip = make_request_and_trip(c)
    body = {"ride_request_id": ride_request["id"], "driver_trip_id": driver_trip["id"]}

    first = c.post("/connections", headers=rider_headers, json=body).json()
    again = c.post("/connections", headers=rider_headers, json=body).json()
    assert again["id"] == first["id"] and again["status"] == "pending"

    # The driver offers the same pair: the passenger's pending request is accepted.
    mutual = c.post("/connections", headers=driver_headers, json=body).json()
    assert mutual["id"] == first["id"] and mutual["status"] == "accepted"
    assert len(c.get("/me/connections", headers=driver_headers).json()) == 1
