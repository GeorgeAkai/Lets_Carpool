import asyncio
import json

from backend.app.realtime import ConnectionManager


class FakeBus:
    """In-process stand-in for Redis pub/sub shared by several managers."""
    def __init__(self) -> None:
        self.queues: list[asyncio.Queue[str]] = []

    def view(self) -> "FakeBusView":
        q: asyncio.Queue[str] = asyncio.Queue()
        self.queues.append(q)
        return FakeBusView(self, q)


class FakeBusView:
    def __init__(self, bus: FakeBus, q: "asyncio.Queue[str]") -> None:
        self._bus, self._q = bus, q

    async def publish(self, payload: str) -> None:
        for q in self._bus.queues:
            q.put_nowait(payload)

    async def subscribe(self):
        while True:
            yield await self._q.get()

    async def close(self) -> None:
        pass


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def accept(self) -> None:
        pass

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


def test_message_reaches_a_user_connected_to_another_instance():
    async def run():
        bus = FakeBus()
        a, b = ConnectionManager(bus.view()), ConnectionManager(bus.view())
        await a.start(); await b.start()
        sock = FakeSocket()
        await b.connect("usr_2", sock)            # user lives on instance B
        await a.send("usr_2", {"type": "connection_update", "status": "accepted"})  # sent from A
        await asyncio.sleep(0.05)
        await a.stop(); await b.stop()
        return sock.sent

    assert asyncio.run(run()) == [{"type": "connection_update", "status": "accepted"}]


def test_without_a_bus_delivery_is_local():
    async def run():
        m = ConnectionManager()
        sock = FakeSocket()
        await m.connect("usr_1", sock)
        await m.broadcast(["usr_1", "usr_other"], {"type": "ping"})
        return sock.sent

    assert asyncio.run(run()) == [{"type": "ping"}]


def test_publish_failure_falls_back_to_local_delivery():
    class Broken(FakeBusView):
        async def publish(self, payload: str) -> None:
            raise ConnectionError("redis down")

    async def run():
        m = ConnectionManager(Broken(FakeBus(), asyncio.Queue()))
        await m.start()
        sock = FakeSocket()
        await m.connect("usr_1", sock)
        await m.send("usr_1", {"type": "x"})
        await m.stop()
        return sock.sent

    assert asyncio.run(run()) == [{"type": "x"}]
