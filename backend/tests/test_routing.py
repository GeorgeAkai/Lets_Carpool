from __future__ import annotations

import threading
import time

import httpx

from backend.app import routing
from backend.app.routing import GoogleRoutesClient, OSRMClient

OK_BODY = {
    "code": "Ok",
    "routes": [{"distance": 1000.0, "duration": 60.0, "geometry": {"coordinates": [[0.0, 0.0], [0.01, 0.0]]}}],
}


class FakeResponse:
    def __init__(self, body: dict) -> None:
        self._body = body

    def raise_for_status(self) -> None: ...

    def json(self) -> dict:
        return self._body


def test_identical_routes_are_served_from_cache(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(routing.httpx, "get", lambda *a, **k: (calls.append(1), FakeResponse(OK_BODY))[1])
    client = OSRMClient("http://osrm")
    first = client.route([(1.0, 2.0), (3.0, 4.0)])
    second = client.route([(1.0, 2.0), (3.0, 4.0)])
    assert first is not None and second is first
    assert len(calls) == 1


def test_failures_are_not_cached(monkeypatch) -> None:
    calls = []

    def flaky(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("down")
        return FakeResponse(OK_BODY)

    monkeypatch.setattr(routing.httpx, "get", flaky)
    client = OSRMClient("http://osrm")
    assert client.route([(1.0, 2.0), (3.0, 4.0)]) is None
    assert client.route([(1.0, 2.0), (3.0, 4.0)]) is not None
    assert len(calls) == 2


def test_cache_entries_expire(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(routing.httpx, "get", lambda *a, **k: (calls.append(1), FakeResponse(OK_BODY))[1])
    client = OSRMClient("http://osrm", cache_ttl_s=0.0)
    client.route([(1.0, 2.0), (3.0, 4.0)])
    time.sleep(0.01)
    client.route([(1.0, 2.0), (3.0, 4.0)])
    assert len(calls) == 2


def test_concurrent_requests_are_capped(monkeypatch) -> None:
    in_flight = 0
    peak = 0
    lock = threading.Lock()

    def slow(*a, **k):
        nonlocal in_flight, peak
        with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        time.sleep(0.05)
        with lock:
            in_flight -= 1
        return FakeResponse(OK_BODY)

    monkeypatch.setattr(routing.httpx, "get", slow)
    client = OSRMClient("http://osrm", max_concurrent=2)
    threads = [
        threading.Thread(target=client.route, args=([(float(i), 0.0), (float(i), 1.0)],)) for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak == 2


GOOGLE_BODY = {
    "routes": [{
        "distanceMeters": 2500, "duration": "300s",
        "polyline": {"geoJsonLinestring": {"coordinates": [[0.0, 0.0], [0.02, 0.0]]}},
    }],
}


def test_google_routes_parses_response_and_sends_key(monkeypatch) -> None:
    seen = {}

    def fake_post(url, json, headers, timeout):
        seen.update(url=url, json=json, headers=headers)
        return FakeResponse(GOOGLE_BODY)

    monkeypatch.setattr(routing.httpx, "post", fake_post)
    result = GoogleRoutesClient("k").route([(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)])
    assert result is not None
    assert (result.distance_m, result.duration_s) == (2500.0, 300.0)
    assert result.coordinates == [(0.0, 0.0), (0.02, 0.0)]
    assert seen["headers"]["X-Goog-Api-Key"] == "k"
    assert len(seen["json"]["intermediates"]) == 1


def test_google_routes_falls_back_to_osrm(monkeypatch) -> None:
    def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(routing.httpx, "post", boom)
    monkeypatch.setattr(routing.httpx, "get", lambda *a, **k: FakeResponse(OK_BODY))
    result = GoogleRoutesClient("k", fallback=OSRMClient("http://osrm")).route([(1.0, 2.0), (3.0, 4.0)])
    assert result is not None and result.distance_m == 1000.0


def test_google_routes_without_fallback_returns_none(monkeypatch) -> None:
    def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(routing.httpx, "post", boom)
    assert GoogleRoutesClient("k").route([(1.0, 2.0), (3.0, 4.0)]) is None
