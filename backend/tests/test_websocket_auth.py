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
