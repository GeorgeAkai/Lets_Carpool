"""PostgreSQL connection pool and schema bootstrap."""
from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import contextmanager
from typing import Generator

import psycopg2
import psycopg2.extras
from psycopg2.pool import PoolError, ThreadedConnectionPool

log = logging.getLogger("carpool.db")

_pool: ThreadedConnectionPool | None = None


# How long a request waits for a free connection before giving up (seconds).
POOL_WAIT_SECONDS = float(os.environ.get("DB_POOL_WAIT_SECONDS", "20"))

# A pooled connection is only probed with a round trip if it has sat idle this
# long (seconds); busy connections are trusted. TCP keepalives cover the gap.
VALIDATE_AFTER_IDLE_SECONDS = float(os.environ.get("DB_VALIDATE_AFTER_IDLE_SECONDS", "30"))

_slots: threading.BoundedSemaphore | None = None
_local = threading.local()
# id(conn) -> time.monotonic() when it was last returned to the pool.
_last_returned: dict[int, float] = {}


def init_pool(database_url: str, minconn: int = 1, maxconn: int = 10) -> None:
    global _pool, _slots
    # Each Cloud Run instance holds its own pool, so total connections =
    # instances x DB_POOL_MAX — keep that under the database's limit.
    maxconn = int(os.environ.get("DB_POOL_MAX", maxconn))
    # Keepalives stop idle pooled connections being silently dropped by NAT/poolers.
    _pool = ThreadedConnectionPool(
        minconn, maxconn, dsn=database_url,
        keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
    )
    # psycopg2's pool raises the instant it is empty. A page load fires many
    # requests at once, so callers queue on this semaphore for a free connection instead.
    _slots = threading.BoundedSemaphore(maxconn)


def close_pool() -> None:
    global _pool, _slots
    if _pool:
        _pool.closeall()
        _pool = None
    _slots = None
    _last_returned.clear()


def _needs_probe(conn: psycopg2.extensions.connection) -> bool:
    """Fresh connections and ones idle for a while get probed; ones that just
    served a request are assumed healthy, which saves a round trip per checkout."""
    returned = _last_returned.get(id(conn))
    return returned is None or time.monotonic() - returned > VALIDATE_AFTER_IDLE_SECONDS


def _release(conn: psycopg2.extensions.connection) -> None:
    discard = bool(conn.closed)
    if discard:
        _last_returned.pop(id(conn), None)
    else:
        _last_returned[id(conn)] = time.monotonic()
    _pool.putconn(conn, close=discard)  # type: ignore[union-attr]


def _is_alive(conn: psycopg2.extensions.connection) -> bool:
    """True if the server still answers on this connection (conn.closed only
    reflects drops we've already noticed, not ones the pooler did silently)."""
    if conn.closed:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.rollback()
        return True
    except psycopg2.Error:
        return False


@contextmanager
def get_conn() -> Generator[psycopg2.extensions.connection, None, None]:
    assert _pool is not None and _slots is not None, "DB pool not initialised — call init_pool() first"
    # Re-entrant per thread: code that opens a connection while already holding
    # one (e.g. a helper called inside a transaction) shares it instead of
    # needing a second slot, which could deadlock a small pool. Only the
    # outermost block commits / rolls back / returns the connection.
    held = getattr(_local, "conn", None)
    if held is not None:
        yield held
        return
    if not _slots.acquire(timeout=POOL_WAIT_SECONDS):
        raise PoolError("timed out waiting for a database connection")
    try:
        conn = _pool.getconn()
        # The server/pooler may have dropped an idle connection: replace it
        # (the pool opens a fresh one when it has no spare).
        for _ in range(3):
            if not _needs_probe(conn) and not conn.closed:
                break
            if _is_alive(conn):
                break
            _last_returned.pop(id(conn), None)
            _pool.putconn(conn, close=True)
            conn = _pool.getconn()
    except Exception:
        _slots.release()
        raise
    _local.conn = conn
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except psycopg2.Error:
            pass  # connection is dead; it is discarded below
        raise
    finally:
        _local.conn = None
        _release(conn)
        _slots.release()


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
    # A whole city/neighbourhood rather than a street address (e.g. a driver
    # heading to "Sacramento"); matching treats it as an area, not a point.
    cur.execute("ALTER TABLE locations ADD COLUMN IF NOT EXISTS is_general BOOLEAN NOT NULL DEFAULT FALSE")
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
        CREATE UNLOGGED TABLE IF NOT EXISTS driver_locations (
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
    cur.execute("ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS notes TEXT")

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
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS notes TEXT")
    # The driver's actual road route (from OSRM at creation time), so search can
    # match passengers against a corridor rather than just the two endpoints. NULL
    # for trips created before this existed or while routing was unavailable;
    # search falls back to endpoint-radius matching for those.
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS route_geog GEOGRAPHY(LINESTRING, 4326)")
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS route_distance_m DOUBLE PRECISION")
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS route_duration_s DOUBLE PRECISION")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_driver_trips_route_geog ON driver_trips USING GIST (route_geog)")

    # Trips a passenger has skipped when the system proposed their next match, so
    # the same trip isn't proposed again for that request. No FKs: a skip is
    # just a hint and shouldn't block deleting/archiving either listing.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS match_skips (
            ride_request_id TEXT NOT NULL,
            driver_trip_id  TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (ride_request_id, driver_trip_id)
        )
    """)

    # Same idea from the driver's side: ride requests a driver skipped when the
    # system proposed a passenger for their trip. Separate from match_skips so one
    # side's skip never hides the listing from the other.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS driver_match_skips (
            driver_trip_id  TEXT NOT NULL,
            ride_request_id TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (driver_trip_id, ride_request_id)
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

    # ── Trip-planning, trust and trip-day data (passenger/driver redesign) ──────
    # Optional exact departure time alongside the date + flexibility window;
    # arrival is derived from the stored route duration, never stored.
    cur.execute("ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS departure_time TIME")
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS departure_time TIME")
    # Driver-set price per seat (NULL = use the suggested even gas split).
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS price_per_seat_cents INTEGER")
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS auto_accept_verified BOOLEAN NOT NULL DEFAULT FALSE")
    # Trips posted together with "Repeat on weekdays" share a series id.
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS series_id TEXT")
    # Shown to the other party only once a connection is accepted.
    cur.execute("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS plate TEXT")
    cur.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT")
    # Set by an admin after checking ID; drives the "Verified" badge/filter
    # and auto-accept.
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verified BOOLEAN NOT NULL DEFAULT FALSE")
    # Trip-day: when the passenger tapped "I'm at the pickup spot".
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS rider_at_pickup_at TIMESTAMPTZ")
    # Driver confirmed the passenger is in the car (the ride is en route).
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS ratings (
            id            TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            rater_id      TEXT NOT NULL REFERENCES users(id),
            ratee_id      TEXT NOT NULL REFERENCES users(id),
            stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
            comment       TEXT,
            created_at    TIMESTAMPTZ NOT NULL,
            UNIQUE (connection_id, rater_id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON ratings (ratee_id)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS saved_routes (
            id                      TEXT PRIMARY KEY,
            user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            label                   TEXT NOT NULL,
            pickup_location_id      TEXT NOT NULL REFERENCES locations(id),
            destination_location_id TEXT NOT NULL REFERENCES locations(id),
            departure_time          TIME,
            weekdays                INTEGER[] NOT NULL DEFAULT '{}',
            created_at              TIMESTAMPTZ NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS ride_alerts (
            id                      TEXT PRIMARY KEY,
            user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            destination_location_id TEXT NOT NULL REFERENCES locations(id),
            target_date             DATE NOT NULL,
            radius_meters           INTEGER NOT NULL DEFAULT 5000,
            created_at              TIMESTAMPTZ NOT NULL,
            fulfilled_at            TIMESTAMPTZ
        )
    """)

    # ── Secondary indexes ──────────────────────────────────────────────────────
    # Postgres indexes only primary keys and UNIQUE constraints by itself, so
    # every foreign-key lookup and status/date filter below was a sequential scan.
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_connections_ride_request ON connections (ride_request_id)",
        "CREATE INDEX IF NOT EXISTS idx_connections_driver_trip ON connections (driver_trip_id)",
        "CREATE INDEX IF NOT EXISTS idx_connections_pending ON connections (updated_at) WHERE status = 'pending'",
        "CREATE INDEX IF NOT EXISTS idx_messages_connection ON messages (connection_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id, blocker_id)",
        "CREATE INDEX IF NOT EXISTS idx_gas_splits_connection ON gas_split_confirmations (connection_id)",
        # Discovery only ever looks at live listings, so index just those.
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_live ON driver_trips (target_date) WHERE status IN ('open', 'matched')",
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_live ON ride_requests (target_date) WHERE status IN ('open', 'matched')",
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_driver ON driver_trips (driver_id)",
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_rider ON ride_requests (rider_id)",
        # The locations GiST index drives spatial search; these let it join back to listings.
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_pickup_loc ON driver_trips (pickup_location_id)",
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_dest_loc ON driver_trips (destination_location_id)",
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_pickup_loc ON ride_requests (pickup_location_id)",
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_dest_loc ON ride_requests (destination_location_id)",
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_tags ON driver_trips USING GIN (tags)",
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_tags ON ride_requests USING GIN (tags)",
        "CREATE INDEX IF NOT EXISTS idx_pool_memberships_user ON pool_memberships (user_id)",
        "CREATE INDEX IF NOT EXISTS idx_pool_messages_pool ON pool_messages (pool_id, created_at)",
    ):
        cur.execute(statement)

    # One live connection per request/trip pair: the "already pending" check in
    # Store.create_connection is read-then-insert, so two simultaneous taps could
    # both pass it. If old data already holds duplicates the index can't be
    # built; log it instead of refusing to boot, and fix the rows by hand.
    try:
        cur.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS uq_connections_live_pair
               ON connections (ride_request_id, driver_trip_id)
               WHERE status IN ('pending', 'accepted')"""
        )
    except psycopg2.Error:
        log.exception("Could not create uq_connections_live_pair: duplicate live connections exist")

    # ── Connection response tracking ───────────────────────────────────────────
    # responded_at: when the non-initiating side accepted or declined (drives the
    # "usually replies in N min" signal). reminded_at: the one nudge sent to a
    # recipient who has not answered yet.
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ")
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_connections_pending_created ON connections (created_at) WHERE status = 'pending'")

    # ── Denormalized coordinates on listings ───────────────────────────────────
    # Search and matching used to join `locations` twice per listing just to reach
    # its point. The point and area flag are copied onto the listing instead, by a
    # trigger so every write path (create, pickup edit, series) stays consistent.
    # Locations are immutable, so the copies can't go stale.
    for table in ("ride_requests", "driver_trips"):
        cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS pickup_geog GEOGRAPHY(POINT, 4326)")
        cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS dest_geog GEOGRAPHY(POINT, 4326)")
        cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS pickup_is_general BOOLEAN NOT NULL DEFAULT FALSE")
        cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS dest_is_general BOOLEAN NOT NULL DEFAULT FALSE")
        # When the pair-matching candidates were last computed for this listing; NULL = not yet.
        cur.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS matches_computed_at TIMESTAMPTZ")
        cur.execute(f"""
            UPDATE {table} x SET pickup_geog = p.geog, pickup_is_general = p.is_general,
                                 dest_geog = d.geog, dest_is_general = d.is_general
            FROM locations p, locations d
            WHERE x.pickup_geog IS NULL AND p.id = x.pickup_location_id AND d.id = x.destination_location_id
        """)
    cur.execute("""
        CREATE OR REPLACE FUNCTION listing_copy_geo() RETURNS trigger AS $$
        BEGIN
            SELECT geog, is_general INTO NEW.pickup_geog, NEW.pickup_is_general
              FROM locations WHERE id = NEW.pickup_location_id;
            SELECT geog, is_general INTO NEW.dest_geog, NEW.dest_is_general
              FROM locations WHERE id = NEW.destination_location_id;
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql
    """)
    for table in ("ride_requests", "driver_trips"):
        trigger = f"trg_{table}_copy_geo"
        cur.execute("SELECT 1 FROM pg_trigger WHERE tgname = %s", (trigger,))
        if not cur.fetchone():
            cur.execute(f"""
                CREATE TRIGGER {trigger} BEFORE INSERT OR UPDATE OF pickup_location_id, destination_location_id
                ON {table} FOR EACH ROW EXECUTE FUNCTION listing_copy_geo()
            """)
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_pickup_geog ON ride_requests USING GIST (pickup_geog) WHERE status IN ('open', 'matched')",
        "CREATE INDEX IF NOT EXISTS idx_ride_requests_dest_geog ON ride_requests USING GIST (dest_geog) WHERE status IN ('open', 'matched')",
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_pickup_geog ON driver_trips USING GIST (pickup_geog) WHERE status IN ('open', 'matched', 'paused')",
        "CREATE INDEX IF NOT EXISTS idx_driver_trips_dest_geog ON driver_trips USING GIST (dest_geog) WHERE status IN ('open', 'matched', 'paused')",
    ):
        cur.execute(statement)

    # ── Precomputed match candidates ───────────────────────────────────────────
    # Which trips fit which requests is geometry that never changes once both
    # listings exist, so it is worked out when a listing is created or edited and
    # stored here with the (expensive, routed) detour. Proposals then only read
    # this table and apply the live filters: status, seats, skips, blocks.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS match_candidates (
            ride_request_id TEXT NOT NULL,
            driver_trip_id  TEXT NOT NULL,
            detour_minutes  DOUBLE PRECISION,
            off_route_m     DOUBLE PRECISION,
            computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (ride_request_id, driver_trip_id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_match_candidates_trip ON match_candidates (driver_trip_id)")

    # driver_locations is ephemeral (5-minute TTL, rewritten every few seconds per
    # driver), so skip the write-ahead log for it. Tables created before this
    # change are converted once; losing it in a database crash only means drivers
    # reappear on their next GPS tick.
    cur.execute("SELECT relpersistence FROM pg_class WHERE relname = 'driver_locations'")
    row = cur.fetchone()
    if row and row[0] == "p":
        cur.execute("ALTER TABLE driver_locations SET UNLOGGED")

    # ── Integrity checks ───────────────────────────────────────────────────────
    # Added NOT VALID so rows written before this existed can't block startup;
    # they are enforced for every new write, and validated when the data allows.
    for name, table, expr in (
        ("driver_trips_seats_ck", "driver_trips", "seats_reserved >= 0 AND seats_reserved <= seats_available"),
        ("driver_trips_status_ck", "driver_trips",
         "status IN ('open', 'paused', 'matched', 'expired', 'cancelled', 'completed')"),
        ("ride_requests_status_ck", "ride_requests",
         "status IN ('open', 'matched', 'expired', 'cancelled', 'completed')"),
        ("connections_status_ck", "connections",
         "status IN ('pending', 'accepted', 'declined', 'cancelled', 'completed', 'expired')"),
    ):
        cur.execute("SELECT 1 FROM pg_constraint WHERE conname = %s", (name,))
        if not cur.fetchone():
            cur.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expr}) NOT VALID")
        try:
            cur.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")
        except psycopg2.Error:
            log.warning("Existing rows violate %s; new writes are still checked", name)

    # ── Preferences, trust, receipts and safety (redesign, part 2) ─────────
    # First-run welcome screen: shown until the user finishes it once.
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ")
    # Optional, self-declared, never shown to other users. Only used to honour
    # the "Women-only rides" preference (see ride_preferences.women_only).
    cur.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS gender TEXT")

    # "Ride preferences": how the rider wants search narrowed and ranked, plus
    # the driver's own ride vibe (copied onto each trip they post).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ride_preferences (
            user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            max_walk_minutes  INTEGER CHECK (max_walk_minutes IS NULL OR max_walk_minutes BETWEEN 1 AND 60),
            vibes             TEXT[] NOT NULL DEFAULT '{}',
            verified_only     BOOLEAN NOT NULL DEFAULT FALSE,
            women_only        BOOLEAN NOT NULL DEFAULT FALSE,
            coworkers_first   BOOLEAN NOT NULL DEFAULT FALSE,
            route_checkins    BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at        TIMESTAMPTZ NOT NULL
        )
    """)
    cur.execute("ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS vibes TEXT[] NOT NULL DEFAULT '{}'")

    # "Saved places": one-tap Home / Work (and a few named extras) on Home.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS saved_places (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind        TEXT NOT NULL CHECK (kind IN ('home', 'work', 'other')),
            label       TEXT NOT NULL,
            location_id TEXT NOT NULL REFERENCES locations(id),
            created_at  TIMESTAMPTZ NOT NULL
        )
    """)
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_places_home_work
        ON saved_places (user_id, kind) WHERE kind IN ('home', 'work')
    """)

    # How a user settles the gas split outside the app (no card data is ever
    # stored: in-app payments are out of MVP scope). Shown to accepted partners
    # and printed on receipts.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS settlement_preferences (
            user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            method     TEXT NOT NULL,
            handle     TEXT,
            updated_at TIMESTAMPTZ NOT NULL
        )
    """)

    # Request-status and receipt timeline, and the safety PIN the rider reads
    # out to the driver before getting in.
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ")
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ")
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS ride_pin TEXT")
    cur.execute("ALTER TABLE connections ADD COLUMN IF NOT EXISTS pin_verified_at TIMESTAMPTZ")

    # Immutable snapshot of a completed ride's cost split, so a receipt never
    # changes if the trip, prices or profiles are edited later.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS trip_receipts (
            id                TEXT PRIMARY KEY,
            receipt_number    BIGSERIAL UNIQUE,
            connection_id     TEXT NOT NULL UNIQUE REFERENCES connections(id) ON DELETE CASCADE,
            rider_id          TEXT NOT NULL REFERENCES users(id),
            driver_id         TEXT NOT NULL REFERENCES users(id),
            driver_name       TEXT,
            vehicle_label     TEXT,
            pickup_label      TEXT NOT NULL,
            dropoff_label     TEXT NOT NULL,
            trip_date         DATE NOT NULL,
            departure_time    TIME,
            completed_at      TIMESTAMPTZ NOT NULL,
            distance_km       DOUBLE PRECISION NOT NULL,
            gas_cost_cents    INTEGER NOT NULL,
            split_between     INTEGER NOT NULL,
            seats             INTEGER NOT NULL,
            price_per_seat_cents INTEGER NOT NULL,
            amount_cents      INTEGER NOT NULL,
            settlement_method TEXT,
            created_at        TIMESTAMPTZ NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trip_receipts_rider ON trip_receipts (rider_id, completed_at DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trip_receipts_driver ON trip_receipts (driver_id, completed_at DESC)")

    # Quick feedback chips on the rating screen ("On time", "Clean car", ...).
    cur.execute("ALTER TABLE ratings ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'")

    # "Ride with them again": people a user wants to see first in results.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ride_buddies (
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            buddy_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (user_id, buddy_id)
        )
    """)

    # Trusted contacts the user shares live trips with.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS emergency_contacts (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            relationship TEXT,
            phone        TEXT NOT NULL,
            share_mode   TEXT NOT NULL DEFAULT 'every_trip'
                         CHECK (share_mode IN ('every_trip', 'night_only', 'off')),
            created_at   TIMESTAMPTZ NOT NULL
        )
    """)

    # "Report an issue with this trip": a report can point at a ride and carry
    # a category so the admin queue can triage safety issues first.
    cur.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL")
    cur.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'")

    cur.close()
    conn.close()
