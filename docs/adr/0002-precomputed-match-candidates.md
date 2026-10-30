# Match candidates are computed when a listing is written, not when it is viewed

Status: accepted

## Context

Proposed matches (ADR 0001) ran the corridor search, filtered in Python and asked OSRM
for up to ten insertion detours on every proposal request. Which trip fits which
request depends only on the two listings' geometry, which does not change after they
are written, so the same work was repeated on every view by every user.

## Decision

- `match_candidates (ride_request_id, driver_trip_id, detour_minutes, off_route_m)`
  holds the pairs that fit. One table serves both sides: the passenger's proposal and
  the driver's matches read the same rows.
- A pair is stored when either listing is created. `compute_matches_for_request` /
  `compute_matches_for_trip` run as a background task after the response, store up to
  50 pairs per listing, and route the detour for the newest 20. Editing a request's
  pickup or a trip's date marks the listing stale (`matches_computed_at = NULL`) and
  recomputes it.
- Only geometry is stored. Everything that changes over time is applied when a
  proposal is read: listing status, free seats, date window, skips, existing
  connections, blocks and suspensions.
- A listing with `matches_computed_at IS NULL` (created before this change, or its
  background task has not finished) is computed on its first proposal, so proposals
  never depend on the background task having run.
- Listings carry a copy of their pickup/destination point and area flag
  (`pickup_geog`, `dest_geog`, `*_is_general`), maintained by a trigger, so search and
  candidate computation use the listings' own spatial indexes with no join to
  `locations`. Locations are immutable, so the copies cannot go stale.
- The expiry sweep deletes candidates whose request is no longer open or whose trip
  can no longer be proposed.

## Consequences

- A proposal is an indexed lookup; it makes no routing calls.
- A detour is `NULL` if routing was unavailable when the pair was written, or the pair
  was beyond the newest 20; ranking then falls back to date/flexibility as before. It
  is not retried.
- A very popular trip keeps only its 50 newest candidate requests.
- `match_candidates` has no foreign keys (like the skip tables), so deleting a listing
  does not remove its rows; the expiry sweep does.
- Manual browsing (`/driver-trips/search`) is unchanged and still computes detours live
  from the search coordinates.
