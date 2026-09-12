from __future__ import annotations

import os

import psycopg2
import pytest

from backend.app.db import run_migrations

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://carpool:carpool@localhost:5434/carpool"
)

TABLES = [
    "pool_memberships",
    "pools",
    "blocks",
    "reports",
    "notifications",
    "gas_split_confirmations",
    "messages",
    "connections",
    "driver_trips",
    "ride_requests",
    "locations",
    "vehicles",
    "profiles",
    "users",
]


@pytest.fixture(scope="session", autouse=True)
def _migrate_database():
    run_migrations(TEST_DATABASE_URL)


@pytest.fixture(autouse=True)
def _clean_database(_migrate_database):
    conn = psycopg2.connect(TEST_DATABASE_URL)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE")
    finally:
        conn.close()
    yield
