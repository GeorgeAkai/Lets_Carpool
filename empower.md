# Matching Carpool to (and past) Empower

Working notes from an architecture review, aimed at making this app match or beat
[Empower](https://driveempower.com)'s core pitch: get in, say where you're headed, and
get matched to a driver going the same way, for the fastest combined time with minimal
detours.

## Current state

- **Frontend**: Vite + React 18 SPA (not React Native, despite the PRD's original plan),
  Tailwind, MapLibre GL + OSRM (public demo server) + Nominatim for maps/routing/geocoding.
- **Backend**: FastAPI, deployed as a Vercel serverless function, Postgres (Neon) + PostGIS,
  no ORM.
- **Matching today is two separate things, and neither is what Empower does**:
  1. **Search**: manual, symmetric, endpoint-radius only — PostGIS `ST_DWithin` around the
     destination and pickup points separately (`_geo_search_clauses`,
     `backend/app/domain.py:817-842`), plus exact-match filters (date, tag, seats, car type,
     luggage). Riders and drivers browse each other and manually request/offer a
     `Connection`, which the other side accepts/declines.
  2. **"Best Matches" ranking** (`frontend/src/pages/home.tsx:541`): a client-side scoring
     layer on top of search results — 45% date/flexibility closeness, 40% shared profile
     interests, 15% verified-photo badge. **No distance, route, or ETA signal at all** — the
     comment in the code explicitly says this is deliberate, since exact pickup coordinates
     are withheld pre-connection for privacy.
  3. Real routing (OSRM) only shows up **after** a connection is accepted — for the driver's
     live "Start Driving" navigation and a fare estimate
     (`frontend/src/MapView.tsx:180` `fetchOSRMRoute`). It plays no role in deciding who
     gets matched.
  4. `Store.suggest_route` (`backend/app/domain.py:1348-1365`) is a **synthetic estimate** —
     `haversine * 1.3` fudge factor for road distance, `distance / 35mph` for duration. It is
     not a real road route, and it's the only "routing" the backend does today. OSRM is only
     ever called from the browser, never from the server.

Empower's pitch is a **route-corridor / insertion-detour matching problem**. This codebase
doesn't solve that problem anywhere yet — that's the real gap, not a UI gap.

## The plan

**Phase 1 — Build an actual route-matching engine (the core gap).** See detailed sketch below.

**Phase 2 — Surface it safely pre-connection.** The exact-coordinates-withheld-pre-accept rule
is a UI/label rule, not a data rule — lat/lng are already stored, so the backend can compute
real detour/ETA pre-connection without exposing precise pins on the map. Show "+6 min detour,
same direction" on match cards instead of the current non-geographic score.

**Phase 3 — Decide on auto-matching, deliberately.** This is the one piece the project has
explicitly deferred (PRD: "needs its own architecture decision"). With real detour scoring in
place, there are two options to choose between, not default into:
- Keep manual browse + "Instant Request Match" (current model), just with much better ranking.
- Move toward Empower-style "system proposes top match, you accept/skip" — a bigger change to
  the `Connection` state machine.

**Phase 4 — Harden what the new engine depends on.** Route-matching makes OSRM/Nominatim
load-bearing in a new way (pre-connection, not just post-accept), so the existing roadmap items
to fix the public-demo-server dependency (rate limits, no SLA) and fix the prod-disabled
WebSocket (so match/detour updates feel live) move up in priority rather than staying "nice to
have."

**Phase 5 — Trust/conversion layer**, if "better than Empower" includes polish: verified badges
(exists), ratings (deferred, schema-ready), driver verification depth — lower priority than the
matching engine itself.

## Phase 1 in detail

### 1. Schema: store the driver's route, not just its endpoints

```sql
-- migrate alongside the existing locations.geog backfill pattern (db.py:109)
ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS route_geog GEOGRAPHY(LINESTRING, 4326);
ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS route_distance_m DOUBLE PRECISION;
ALTER TABLE driver_trips ADD COLUMN IF NOT EXISTS route_duration_s DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS idx_driver_trips_route_geog ON driver_trips USING GIST (route_geog);
```

Populate it in `create_driver_trip` (`backend/app/domain.py:663`) by calling a new
`backend/app/routing.py` module — a server-side OSRM client, mirroring what
`MapView.tsx:fetchOSRMRoute` already does client-side, just now needed on the backend too:

```python
# backend/app/routing.py
def route(points: list[tuple[float, float]]) -> RouteResult | None:
    coords = ";".join(f"{lng},{lat}" for lat, lng in points)
    resp = httpx.get(f"{OSRM_BASE}/route/v1/driving/{coords}",
                      params={"overview": "full", "geometries": "geojson"}, timeout=5)
    ...
```

`create_driver_trip` calls `route([pickup, destination])` once, stores the geometry/distance/
duration. One call per trip creation, not per search.

### 2. Corridor pre-filter — replace endpoint-radius with route-buffer

Swap the destination/pickup `ST_DWithin` pair in `_geo_search_clauses` for a single
buffer-around-the-route check:

```sql
SELECT DISTINCT dt.*
FROM driver_trips dt
JOIN locations rider_pickup ON rider_pickup.id = %(rider_pickup_id)s
JOIN locations rider_dest   ON rider_dest.id   = %(rider_dest_id)s
WHERE dt.status IN ('open', 'matched')
  AND dt.route_geog IS NOT NULL
  AND ST_DWithin(dt.route_geog, rider_pickup.geog, %(buffer_m)s)
  AND ST_DWithin(dt.route_geog, rider_dest.geog, %(buffer_m)s)
  -- direction guard: rider's dest must be *ahead* of their pickup along the driver's line,
  -- not behind it — cheap check via ST_LineLocatePoint fractions
  AND ST_LineLocatePoint(dt.route_geog::geometry, rider_pickup.geog::geometry)
    < ST_LineLocatePoint(dt.route_geog::geometry, rider_dest.geog::geometry)
```

`buffer_m` ~800m-1.5km (tune later). The `ST_LineLocatePoint` ordering check is what stops
matching a driver going the opposite direction on the same road — the current endpoint-radius
filter has no concept of direction at all, which is a real correctness gap today (a driver
headed away from downtown and a rider headed into downtown along the same corridor could
currently both pass the existing radius filter).

This runs cheaply with the GIST index and keeps the candidate set small — same role
`_geo_search_clauses` plays now, just direction-aware.

### 3. Detour scoring — only for the survivors

For each candidate that passes the buffer filter (should be single digits, same as
`home.tsx`'s existing `.slice(0, 8)` cap), call OSRM once more with the insertion order:

```python
def detour_minutes(trip: DriverTrip, rider_pickup: Location, rider_dest: Location) -> float | None:
    with_detour = routing.route([
        (trip.pickup.lat, trip.pickup.lng),
        (rider_pickup.lat, rider_pickup.lng),
        (rider_dest.lat, rider_dest.lng),
        (trip.destination.lat, trip.destination.lng),
    ])
    if with_detour is None:
        return None
    return (with_detour.duration_s - trip.route_duration_s) / 60
```

This is the actual Empower-equivalent number: minutes added to the driver's trip by picking
this rider up. Expose it from `search_driver_trips` / a new `/driver-trips/{id}/match-score`
endpoint as `detour_minutes`.

### 4. Replace the scoring formula in `home.tsx`

Today's score (`frontend/src/pages/home.tsx:602`):

```ts
score = 0.45 * windowScore + 0.4 * interestScore + 0.15 * verifiedScore
```

has zero geographic signal. Swap to detour as the dominant term, keep the rest as tie-breakers:

```ts
score = 0.6 * detourScore + 0.25 * windowScore + 0.1 * interestScore + 0.05 * verifiedScore
// detourScore = clamp(1 - detourMinutes / 15, 0, 1)  — 0 min detour = 1.0, 15+ min = 0
```

And the card shows "+6 min detour" instead of nothing geographic at all.

### Cost/ops note

This is the point where the public OSRM demo server (no key, rate-limited,
`frontend/src/MapView.tsx:183`) stops being a "fine for a prototype" risk and becomes a hard
dependency on the hot search path, server-side, at creation *and* at every search. Bundle
standing up a self-hosted OSRM instance (a Docker container + a regional `.osm.pbf` extract)
with this phase rather than after — this was already flagged as tech debt (PRD item 11),
route-matching is what makes it urgent.

## Open decisions before implementation starts

- Buffer distance for the route-corridor filter (starting guess: 800m-1.5km).
- Self-host OSRM now, or defer and accept public-demo-server rate limits during this build?
- Whether Phase 3's auto-matching question gets decided alongside Phase 1, or stays deferred.
