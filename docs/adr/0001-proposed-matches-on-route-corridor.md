# Proposed matches on a route corridor, on top of the manual Connection flow

Status: accepted

## Context

Matching used to be manual: passengers and drivers browsed each other and initiated a
`Connection` by hand, ranked client-side with no geographic signal. We want an
Empower-style flow — say where you're headed, get the best driver proposed.

## Decision

- Driver trips store their OSRM road route (`route_geog`, distance, duration).
  Search matches passengers to a **route corridor** (1000 m buffer, direction-aware)
  instead of endpoint radii, and computes `detour_minutes` server-side.
- A passenger with an open request gets one **proposed match** (and a driver with an open trip gets one proposed passenger, symmetrically; skips are tracked per side): the best eligible
  trip by detour, then date/flexibility. The passenger **requests** it or **skips** it
  (skips are stored in `match_skips`, per request).
- Accepting a proposal is the existing `POST /connections` — a normal `pending`
  `Connection` the driver still accepts or declines. **The Connection state
  machine is unchanged**; there is no `proposed` state.
- Manual browsing and "Instant Request Match" stay as the fallback.
- Routing uses a self-hosted OSRM (`OSRM_BASE_URL`); trips without a stored route
  fall back to endpoint-radius matching.

## Consequences

- Exact coordinates stay withheld pre-connection; only the derived detour is sent.
- A corridor search can be probed to learn roughly where a driver's route runs
  (match/no-match only, never coordinates).
- Proposals depend on OSRM being available; without it detour is unknown and
  ranking degrades to date/flexibility.
