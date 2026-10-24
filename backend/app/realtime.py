"""WebSocket fan-out, optionally shared across instances through Redis pub/sub.

Cloud Run runs several instances, and a user's socket lives on exactly one of
them. With a bus configured, `send()` publishes to a Redis channel and every
instance (including the sender) delivers it to whichever sockets it holds. With
no bus, delivery is local to this process — fine for a single instance / dev.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Protocol

from fastapi import WebSocket

log = logging.getLogger("carpool.realtime")

CHANNEL = "carpool:ws"


def normalize_redis_url(raw: str | None) -> str | None:
    """Pull a usable redis:// or rediss:// URL out of a pasted value.

    Providers show connection info as e.g. `redis-cli --tls -u rediss://default:pw@host:6379`,
    so take the URL token and drop quotes/whitespace. Returns None if there is none.
    """
    if not raw:
        return None
    match = re.search(r"(rediss?|unix)://[^\s'\"]+", raw)
    return match.group(0) if match else None


def build_bus(raw_url: str | None) -> "RedisBus | None":
    """A RedisBus for the configured URL, or None (local-only delivery) if it is unset or invalid."""
    if not raw_url or not raw_url.strip():
        return None
    url = normalize_redis_url(raw_url)
    if not url:
        log.error("REDIS_URL is set but is not a redis:// or rediss:// URL; realtime will be local to this instance")
        return None
    try:
        return RedisBus(url)
    except Exception:
        log.exception("Could not configure Redis; realtime will be local to this instance")
        return None


class Bus(Protocol):
    async def publish(self, payload: str) -> None: ...
    def subscribe(self) -> Any:  # async iterator of payload strings
        ...
    async def close(self) -> None: ...


class RedisBus:
    def __init__(self, url: str, channel: str = CHANNEL) -> None:
        import redis.asyncio as aioredis  # imported lazily: only needed when REDIS_URL is set

        self._redis = aioredis.from_url(url, decode_responses=True, health_check_interval=30)
        self._channel = channel

    async def publish(self, payload: str) -> None:
        await self._redis.publish(self._channel, payload)

    async def subscribe(self):
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(self._channel)
        try:
            async for message in pubsub.listen():
                if message.get("type") == "message":
                    yield message["data"]
        finally:
            await pubsub.aclose()

    async def close(self) -> None:
        await self._redis.aclose()


class ConnectionManager:
    def __init__(self, bus: Bus | None = None) -> None:
        self._sockets: dict[str, WebSocket] = {}
        self._bus = bus
        self._task: asyncio.Task[None] | None = None

    # ── lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._bus and not self._task:
            self._task = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._bus:
            try:
                await self._bus.close()
            except Exception:
                pass

    async def _listen(self) -> None:
        delay = 1.0
        while True:
            try:
                async for raw in self._bus.subscribe():  # type: ignore[union-attr]
                    delay = 1.0
                    try:
                        msg = json.loads(raw)
                        await self._deliver(msg["user_id"], msg["data"])
                    except Exception:
                        log.exception("bad realtime message")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("realtime bus disconnected; retrying in %.0fs", delay, exc_info=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    # ── sockets ───────────────────────────────────────────────────────────────

    async def connect(self, user_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._sockets[user_id] = ws

    def disconnect(self, user_id: str) -> None:
        self._sockets.pop(user_id, None)

    async def _deliver(self, user_id: str, data: dict[str, Any]) -> None:
        ws = self._sockets.get(user_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception:
                self.disconnect(user_id)

    async def send(self, user_id: str, data: dict[str, Any]) -> None:
        if self._bus and self._task:
            try:
                await self._bus.publish(json.dumps({"user_id": user_id, "data": data}, default=str))
                return
            except Exception:
                log.warning("realtime publish failed; delivering locally", exc_info=True)
        await self._deliver(user_id, data)

    async def broadcast(self, user_ids: list[str], data: dict[str, Any]) -> None:
        await asyncio.gather(*[self.send(uid, data) for uid in user_ids], return_exceptions=True)
