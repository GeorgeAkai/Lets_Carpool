"""Server-side OSRM client for route-corridor matching.

Mirrors what the frontend's fetchOSRMRoute does in the browser, but needed on
the backend now that routes decide who gets matched (stored at trip creation,
re-queried for insertion detours at search time). Every call fails soft: any
network/HTTP/shape problem returns None so a routing outage degrades matching
instead of breaking trip creation or search.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

LatLng = tuple[float, float]


@dataclass
class RouteResult:
    distance_m: float
    duration_s: float
    # GeoJSON-order (lng, lat) coordinates of the full route geometry.
    coordinates: list[tuple[float, float]]

    def to_wkt(self) -> str | None:
        # A LINESTRING needs two distinct points; a degenerate route (same
        # pickup and destination) can't be stored in route_geog.
        if len(self.coordinates) < 2:
            return None
        return "LINESTRING(" + ", ".join(f"{lng} {lat}" for lng, lat in self.coordinates) + ")"


class OSRMClient:
    """Thin OSRM client that is gentle on rate-limited servers (e.g. the public
    demo): at most `max_concurrent` requests in flight, and successful routes
    are cached in memory for `cache_ttl_s` (failures are never cached). Both
    are harmless against a self-hosted OSRM."""

    def __init__(
        self, base_url: str, timeout: float = 5.0,
        max_concurrent: int = 3, cache_ttl_s: float = 300.0, cache_max_entries: int = 1024,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._slots = threading.BoundedSemaphore(max_concurrent)
        self._cache_ttl_s = cache_ttl_s
        self._cache_max_entries = cache_max_entries
        self._cache: dict[tuple[LatLng, ...], tuple[float, RouteResult]] = {}
        self._cache_lock = threading.Lock()

    def route(self, points: list[LatLng]) -> RouteResult | None:
        """Drive through `points` (lat, lng) in order; None if OSRM can't route it."""
        if len(points) < 2:
            return None
        # ~1 m precision: identical searches/proposals hit the same entry.
        key = tuple((round(lat, 5), round(lng, 5)) for lat, lng in points)
        cached = self._cache_get(key)
        if cached is not None:
            return cached
        result = self._fetch(points)
        if result is not None:
            self._cache_put(key, result)
        return result

    def _cache_get(self, key: tuple[LatLng, ...]) -> RouteResult | None:
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is None:
                return None
            expires_at, result = entry
            if expires_at < time.monotonic():
                del self._cache[key]
                return None
            return result

    def _cache_put(self, key: tuple[LatLng, ...], result: RouteResult) -> None:
        with self._cache_lock:
            if len(self._cache) >= self._cache_max_entries:
                now = time.monotonic()
                self._cache = {k: v for k, v in self._cache.items() if v[0] >= now}
                if len(self._cache) >= self._cache_max_entries:
                    self._cache.pop(next(iter(self._cache)))  # oldest insertion
            self._cache[key] = (time.monotonic() + self._cache_ttl_s, result)

    def _fetch(self, points: list[LatLng]) -> RouteResult | None:
        coords = ";".join(f"{lng},{lat}" for lat, lng in points)
        try:
            with self._slots:
                resp = httpx.get(
                    f"{self.base_url}/route/v1/driving/{coords}",
                    params={"overview": "full", "geometries": "geojson"},
                    timeout=self.timeout,
                )
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != "Ok" or not data.get("routes"):
                return None
            best = data["routes"][0]
            return RouteResult(
                distance_m=float(best["distance"]),
                duration_s=float(best["duration"]),
                coordinates=[(float(x), float(y)) for x, y in best["geometry"]["coordinates"]],
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            logger.warning("OSRM route request failed: %s", exc)
            return None
