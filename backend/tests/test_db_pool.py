import threading
import time

import pytest
from psycopg2.pool import PoolError

from backend.app import db
from backend.tests.conftest import TEST_DATABASE_URL


@pytest.fixture()
def tiny_pool():
    db.init_pool(TEST_DATABASE_URL, maxconn=2)
    yield
    db.close_pool()


def test_requests_wait_for_a_free_connection_instead_of_failing(tiny_pool):
    results: list[int] = []

    def work(n: int) -> None:
        with db.get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT pg_sleep(0.2)")
            results.append(n)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(6)]  # 6 callers, 2 connections
    for t in threads: t.start()
    for t in threads: t.join()
    assert sorted(results) == list(range(6))


def test_nested_use_shares_the_connection_and_cannot_deadlock(tiny_pool):
    def nested() -> None:
        with db.get_conn() as outer, db.get_conn() as inner, db.get_conn() as innermost:
            assert outer is inner is innermost

    threads = [threading.Thread(target=nested) for _ in range(5)]  # more callers than slots
    for t in threads: t.start()
    for t in threads: t.join(timeout=10)
    assert not any(t.is_alive() for t in threads)


def test_gives_up_with_a_poolerror_after_the_wait_limit(tiny_pool, monkeypatch):
    monkeypatch.setattr(db, "POOL_WAIT_SECONDS", 0.2)
    hold = threading.Event()
    started = threading.Barrier(3)

    def hog() -> None:
        with db.get_conn():
            started.wait()
            hold.wait(5)

    hogs = [threading.Thread(target=hog) for _ in range(2)]
    for t in hogs: t.start()
    started.wait()
    t0 = time.time()
    with pytest.raises(PoolError):
        with db.get_conn():
            pass
    assert time.time() - t0 < 2
    hold.set()
    for t in hogs: t.join()


def test_a_dropped_connection_is_replaced(tiny_pool):
    with db.get_conn():
        pass
    for idle in list(db._pool._pool):  # the pooler hangs up on every idle connection
        idle.close()
    with db.get_conn() as conn:
        cur = conn.cursor(); cur.execute("SELECT 1")
        assert cur.fetchone()[0] == 1
