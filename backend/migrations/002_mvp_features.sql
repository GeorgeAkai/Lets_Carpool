-- MVP feature additions: pools, live driver locations, luggage, car type

CREATE EXTENSION IF NOT EXISTS postgis;

-- Live driver location tracking (updated in real-time via PUT /me/location)
CREATE TABLE IF NOT EXISTS driver_locations (
    user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    location       GEOGRAPHY(POINT, 4326) NOT NULL,
    heading        FLOAT,
    speed_kmh      FLOAT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Spatial index for fast nearby-driver queries
CREATE INDEX IF NOT EXISTS idx_driver_locations_geo
    ON driver_locations USING GIST (location);

-- Community pools (church trips, college rides, work commutes, etc.)
CREATE TABLE IF NOT EXISTS pools (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    organizer_id          TEXT NOT NULL REFERENCES users(id),
    community_tag         TEXT NOT NULL DEFAULT 'event',
    description           TEXT,
    trip_date             DATE NOT NULL,
    pickup_location_id    TEXT NOT NULL REFERENCES locations(id),
    destination_location_id TEXT NOT NULL REFERENCES locations(id),
    max_participants      INT NOT NULL DEFAULT 10,
    seats_per_vehicle     INT NOT NULL DEFAULT 4,
    status                TEXT NOT NULL DEFAULT 'open', -- open, full, cancelled, completed
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_memberships (
    pool_id    TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'passenger', -- organizer, driver, passenger
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pool_id, user_id)
);

-- Extend vehicles table with car type
ALTER TABLE vehicles
    ADD COLUMN IF NOT EXISTS car_type TEXT; -- sedan, suv, van, minivan, truck, other

-- Extend ride_requests with luggage size and preferred car type
ALTER TABLE ride_requests
    ADD COLUMN IF NOT EXISTS luggage_size      TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS preferred_car_type TEXT;

-- Extend driver_trips with luggage capacity and car type
ALTER TABLE driver_trips
    ADD COLUMN IF NOT EXISTS luggage_capacity  TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN IF NOT EXISTS car_type          TEXT;

-- Extend profiles with photo verification flag
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS photo_verified BOOLEAN NOT NULL DEFAULT FALSE;
