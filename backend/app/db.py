"""PostgreSQL connection pool and schema bootstrap."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Generator

import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool

_pool: ThreadedConnectionPool | None = None


def init_pool(database_url: str, minconn: int = 1, maxconn: int = 10) -> None:
    global _pool
    _pool = ThreadedConnectionPool(minconn, maxconn, dsn=database_url)


def close_pool() -> None:
    global _pool
    if _pool:
        _pool.closeall()
        _pool = None


@contextmanager
def get_conn() -> Generator[psycopg2.extensions.connection, None, None]:
    assert _pool is not None, "DB pool not initialised — call init_pool() first"
    conn = _pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


def run_migrations(database_url: str) -> None:
    """Create all tables if they don't exist yet."""
    conn = psycopg2.connect(database_url)
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id                TEXT PRIMARY KEY,
            email             TEXT NOT NULL UNIQUE,
            email_domain      TEXT NOT NULL,
            provider          TEXT NOT NULL,
            provider_subject  TEXT NOT NULL,
            created_at        TIMESTAMPTZ NOT NULL
        )
    """)
    # Admin moderation: 'active' | 'suspended'. Suspended users are locked out
    # entirely (see current_user() in main.py) and their listings drop out of
    # search, rather than just being blocked by one peer (see `blocks` below).
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'")
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ")
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS profiles (
            user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            display_name   TEXT NOT NULL,
            photo_url      TEXT,
            bio            TEXT,
            photo_verified BOOLEAN NOT NULL DEFAULT FALSE,
            interests      TEXT[] NOT NULL DEFAULT '{}',
            nationality    TEXT
        )
    """)
    cur.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}'")
    cur.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nationality TEXT")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS vehicles (
            user_id                 TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            make                    TEXT,
            model                   TEXT,
            color                   TEXT,
            seats                   INTEGER,
            car_type                TEXT,
            has_license             BOOLEAN NOT NULL DEFAULT FALSE,
            has_insurance           BOOLEAN NOT NULL DEFAULT FALSE,
            has_good_driving_record BOOLEAN NOT NULL DEFAULT FALSE
        )
    """)

    cur.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS locations (
            id                TEXT PRIMARY KEY,
            label             TEXT NOT NULL,
            latitude          DOUBLE PRECISION NOT NULL,
            longitude         DOUBLE PRECISION NOT NULL,
            provider          TEXT,
            provider_place_id TEXT,
            metadata          JSONB NOT NULL DEFAULT '{}',
            created_at        TIMESTAMPTZ NOT NULL
        )
    """)
    # Persisted geography point for PostGIS proximity queries (ST_DWithin) instead
    # of fetching every open listing and filtering distance in Python. New rows
    # populate this at insert time (see Store.create_location); this backfills
    # any rows written before the column existed.
    cur.execute("ALTER TABLE locations ADD COLUMN IF NOT EXISTS geog GEOGRAPHY(POINT, 4326)")
    cur.execute("""
        UPDATE locations SET geog = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
        WHERE geog IS NULL
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_locations_geog ON locations USING GIST (geog)")

    # Live driver location — persisted (was an in-memory dict, wiped on every
    # serverless cold start). TTL-style staleness is enforced at query time in
    # Store.get_nearby_drivers rather than by deleting rows, so a driver who
    # briefly drops offline doesn't lose their last-known position outright.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS driver_locations (
            user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            geog        GEOGRAPHY(POINT, 4326) NOT NULL,
            heading     DOUBLE PRECISION,
            speed_kmh   DOUBLE PRECISION,
            updated_at  TIMESTAMPTZ NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_driver_locations_geo ON driver_locations USING GIST (geog)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS ride_requests (
            id                      TEXT PRIMARY KEY,
            rider_id                TEXT NOT NULL REFERENCES users(id),
            pickup_location_id      TEXT NOT NULL REFERENCES locations(id),
            destination_location_id TEXT NOT NULL REFERENCES locations(id),
            target_date             DATE NOT NULL,
            flexibility             TEXT NOT NULL,
            passenger_count         INTEGER NOT NULL,
            tags                    TEXT[] NOT NULL DEFAULT '{}',
            status                  TEXT NOT NULL DEFAULT 'open',
            created_at              TIMESTAMPTZ NOT NULL,
            luggage_size            TEXT NOT NULL DEFAULT 'none',
            preferred_car_type      TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS driver_trips (
            id                      TEXT PRIMARY KEY,
            driver_id               TEXT NOT NULL REFERENCES users(id),
            pickup_location_id      TEXT NOT NULL REFERENCES locations(id),
            destination_location_id TEXT NOT NULL REFERENCES locations(id),
            target_date             DATE NOT NULL,
            flexibility             TEXT NOT NULL,
            seats_available         INTEGER NOT NULL,
            seats_reserved          INTEGER NOT NULL DEFAULT 0,
            tags                    TEXT[] NOT NULL DEFAULT '{}',
            status                  TEXT NOT NULL DEFAULT 'open',
            created_at              TIMESTAMPTZ NOT NULL,
            luggage_capacity        TEXT NOT NULL DEFAULT 'medium',
            car_type                TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS connections (
            id                    TEXT PRIMARY KEY,
            ride_request_id       TEXT NOT NULL REFERENCES ride_requests(id),
            driver_trip_id        TEXT NOT NULL REFERENCES driver_trips(id),
            initiator_user_id     TEXT NOT NULL REFERENCES users(id),
            status                TEXT NOT NULL DEFAULT 'pending',
            created_at            TIMESTAMPTZ NOT NULL,
            updated_at            TIMESTAMPTZ NOT NULL,
            completed_confirmed_by TEXT[] NOT NULL DEFAULT '{}'
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id            TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL REFERENCES connections(id),
            sender_id     TEXT NOT NULL REFERENCES users(id),
            content       TEXT NOT NULL,
            kind          TEXT NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS gas_split_confirmations (
            id            TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL REFERENCES connections(id),
            confirmer_id  TEXT NOT NULL REFERENCES users(id),
            amount_cents  INTEGER NOT NULL,
            currency      TEXT NOT NULL DEFAULT 'USD',
            assumptions   JSONB NOT NULL DEFAULT '{}',
            created_at    TIMESTAMPTZ NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id),
            type       TEXT NOT NULL,
            title      TEXT NOT NULL,
            body       TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            read       BOOLEAN NOT NULL DEFAULT FALSE
        )
    """)
    cur.execute("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_id TEXT")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS reports (
            id               TEXT PRIMARY KEY,
            reporter_id      TEXT NOT NULL REFERENCES users(id),
            reported_user_id TEXT NOT NULL REFERENCES users(id),
            reason           TEXT NOT NULL,
            created_at       TIMESTAMPTZ NOT NULL
        )
    """)
    # 'open' | 'dismissed' | 'actioned' — set by an admin working the reports queue.
    cur.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS blocks (
            blocker_id TEXT NOT NULL REFERENCES users(id),
            blocked_id TEXT NOT NULL REFERENCES users(id),
            PRIMARY KEY (blocker_id, blocked_id)
        )
    """)

    # Admin audit trail: security- and moderation-relevant events (signups,
    # listing publication, suspensions, failed logins, ...). Append-only.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id              TEXT PRIMARY KEY,
            event_type      TEXT NOT NULL,
            actor_user_id   TEXT REFERENCES users(id),
            actor_email     TEXT,
            ip_address      TEXT,
            detail          JSONB NOT NULL DEFAULT '{}',
            created_at      TIMESTAMPTZ NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs (event_type)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS pools (
            id                      TEXT PRIMARY KEY,
            name                    TEXT NOT NULL,
            organizer_id            TEXT NOT NULL REFERENCES users(id),
            community_tag           TEXT NOT NULL,
            trip_date               DATE NOT NULL,
            departure_time          TIME NOT NULL,
            pickup_location_id      TEXT NOT NULL REFERENCES locations(id),
            destination_location_id TEXT NOT NULL REFERENCES locations(id),
            max_participants        INTEGER NOT NULL,
            status                  TEXT NOT NULL DEFAULT 'open',
            created_at              TIMESTAMPTZ NOT NULL,
            description             TEXT,
            seats_per_vehicle       INTEGER NOT NULL DEFAULT 4
        )
    """)
    cur.execute("""
        ALTER TABLE pools ADD COLUMN IF NOT EXISTS departure_time TIME NOT NULL DEFAULT '00:00'
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS pool_memberships (
            pool_id   TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
            user_id   TEXT NOT NULL REFERENCES users(id),
            role      TEXT NOT NULL,
            joined_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (pool_id, user_id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS pool_messages (
            id         TEXT PRIMARY KEY,
            pool_id    TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
            sender_id  TEXT NOT NULL REFERENCES users(id),
            content    TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )
    """)

    cur.close()
    conn.close()
