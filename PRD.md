# Carpool PRD

## Problem Statement

People who need rides and people who are already driving to similar destinations lack a simple, trusted way to find each other, coordinate details, and agree on a fair gas split without turning the product into a full rideshare, payment, or safety platform too early.

Riders need to publish where they want to go, find drivers going to similar destinations, and coordinate a practical pickup. Drivers need to publish planned trips, discover relevant rider requests, manage available seats, and decide who to connect with. Both sides need enough structure to feel organized, but enough flexibility to coordinate real-world timing through chat.

## Current State (as of 2026-09-26)

The MVP marketplace loop — sign in, create profile, publish listing, search, connect, coordinate, confirm gas split — is **built and working locally**. The product has also grown well beyond the original two-sided marketplace: a community Pools feature, a driver "Start Driving" live-navigation mode, a staff admin/moderation panel, and a round of production hardening (verified auth, PostGIS-backed geo queries, persisted driver location, scheduled expiry) that closed several of the gaps this document originally flagged. Some deployed-environment gaps remain (see Known issues below).

This document describes the system as it actually exists, then lists the improvements needed to close the gap between "works on my machine" and "safe to put in front of real users."

## Architecture (as built)

- **Frontend**: Vite + React 18 SPA (TypeScript), not React Native. `frontend/`. Tailwind 4, `react-router-dom` v7, `motion`, `lucide-react`. Deployed as a static build to Vercel (`frontend/vercel.json`).
  - Dead scaffold code remains from the original React Native plan: `frontend/src/pages.tsx` and `frontend/src/react-native-web.d.ts` are unused (not imported by `App.tsx`).
- **Backend**: FastAPI (Python), `backend/app/main.py`. Deployed as a Vercel Python serverless function via `api/index.py`, routed by the root `vercel.json`. Not a long-running server.
- **Database**: Postgres on Neon, accessed with raw `psycopg2` — no ORM. Schema is created idempotently in code (`backend/app/db.py: run_migrations()`); the checked-in SQL files under `backend/migrations/` are stale/incomplete and are not the real source of truth.
- **Auth**: Two layers, now cryptographically bridged.
  - Supabase Auth (`@supabase/supabase-js`) provides the session in the browser, behind the app's own sign-in / sign-up / password-reset screens (`frontend/src/pages/auth.tsx`).
  - The FastAPI backend's `/auth/login` verifies the Supabase access token server-side against the project's JWKS (`verify_supabase_token`, checking issuer + `authenticated` audience; legacy HS256 projects via `SUPABASE_JWT_SECRET`) before minting its own self-issued HS256 session JWT — it no longer trusts a client-supplied email. A failed/forged token, or a suspended account, is rejected and logged to the audit log.
- **Real-time**: A WebSocket implementation exists (`ConnectionManager` in `main.py`, `/ws/{user_id}`) for chat messages, connection updates, and nearby-driver broadcasts — but the frontend still explicitly disables it whenever the API is not on `localhost` (`frontend/src/api.ts`). So **real-time is still dev-only**; production silently falls back to no live updates. This part has not changed (see roadmap item 8).
- **Maps / location**: MapLibre GL (vector basemap via CARTO) for rendering, OSRM's public demo server for road routing, Nominatim (OSM) for geocoding/address search — all free, keyless, third-party services with no rate-limit handling or fallback provider.
- **PostGIS**: actually in use now. `driver_locations.geog` and the `ride_requests`/`driver_trips` pickup/destination location joins are queried with `ST_DWithin`/`ST_Distance` (see `search_ride_requests`, `search_driver_trips`, `get_nearby_drivers` in `backend/app/domain.py`). Python `haversine_meters` remains, but only for display-value distance/fare estimates, not for radius filtering.
- **Deployment**: two independent Vercel projects (frontend static build, backend Python serverless function), both reading from the same Neon database. `run.sh` requires a real Neon `DATABASE_URL` for local dev now; `docker-compose.yml` (local Postgres+PostGIS) is a vestige of the earlier local-only setup. Listing/connection expiry now runs via Vercel Cron hitting `GET /cron/expire`, gated by a shared cron secret (`RequireCronSecret`).

## Data model (as built)

Both the original two-sided listing model and a newer community-pool model exist side by side:

- `users`, `profiles` (display name, photo, bio, `photo_verified`), `vehicles` (make/model/color/seats, `car_type`, self-declared license/insurance/driving record)
- `locations` (lat/lng, label, provider metadata)
- `ride_requests` / `driver_trips` — the PRD's original rider/driver listing split, including `luggage_size`/`luggage_capacity` and `car_type`/`preferred_car_type`, tags (`airport`, `student`, plus `church`/`college`/`work`/`event` added since), and the full `open/expired/matched/cancelled/completed` status enum
- `connections` — links one ride request to one driver trip, full `pending/expired/accepted/declined/cancelled/completed` state machine, seat reservation
- `messages` — canned vs. free-text, gated by connection state
- `gas_split_confirmations` — suggested-fare + manual confirmation per side (haversine distance, $3.50/gal, 28mpg assumption)
- `notifications` — in-app only, polled
- `reports`, `blocks` — backend enforcement wired into search/connect/message, plus a `...` overflow menu on listing cards, connection cards, and profiles (see Feature status)
- `audit_logs` — append-only log of admin actions and auth events (logins, failed logins, suspensions, warnings, report actions, listing removals), backing the Admin Panel's Logs tab
- `pools`, `pool_memberships`, `pool_messages` — **new, not in the original PRD**: organizer-created group trips with a community tag, capacity, and seats-per-vehicle, auto-flipping to `full`; each pool has its own group chat
- `driver_locations` — a real PostGIS geography column, persisted to Postgres on every location update (`ON CONFLICT ... DO UPDATE`), not an in-memory dict. `get_nearby_drivers` queries it with `ST_DWithin`/`ST_Distance` and excludes stale rows (no update in the last 5 minutes). This survives a serverless cold start; it just doesn't push live updates in production (see the WebSocket note above).

## Feature status

| Area | Status |
|---|---|
| Sign in / profile | Working via Supabase Auth, server-side verified against the project's JWKS before a session JWT is issued |
| Ride requests / driver trips (create, search, filter by radius/date/tag/luggage/car type) | Fully built, Postgres-persisted, radius filtering via PostGIS `ST_DWithin` |
| Community pools | Fully built — organizer create, join/leave, capacity auto-fill, named roster + departure time + group chat all present in the pool card UI |
| Connections (request/offer, accept/decline, seat reservation) | Fully built, matches the original state machine |
| Chat (canned while pending, full after accepted) | Fully built, including inbox UI, unread badges, and a full-screen chat view |
| Gas split (suggested fare + manual confirmation) | Built as a suggestion + independent confirmation; still **no reconciliation** if the two sides confirm different amounts |
| Block / report | Backend complete (enforced in search/connect/message); **UI entry point now exists** — an overflow menu on listing cards and connection cards |
| Driver "Start Driving" pickup navigation | Fully built: live GPS watch, routed map to the rider's pickup, auto-refreshing ETA/distance, ends on arrival |
| Admin panel / moderation | Fully built (`frontend/src/pages/admin.tsx`, linked from account settings): overview stats, user directory + suspend/unsuspend/warn, report review (dismiss/action), active-route removal, and an audit log viewer |
| Listing/connection expiry | Automated: Vercel Cron calls `GET /cron/expire`, gated by a shared cron secret; the ownership/authorization gap is closed |
| Notifications | In-app/polled only. No email, no push. |
| Live driver location (map) | Persisted to Postgres/PostGIS (survives cold starts); real-time *push* of it to other clients is still disabled outside localhost, so nearby-driver views rely on periodic polling in production |
| Photo upload | Base64 data URL stored directly in the `profiles` table — no object storage/CDN (unchanged) |
| Maps/routing | Real road routing (OSRM) and geocoding (Nominatim), both public/keyless with no fallback; rendered with MapLibre GL (not Leaflet) |
| PostGIS | In active use for radius search and nearby-driver queries (`ST_DWithin`/`ST_Distance`); haversine remains only for display-value distance/fare math |

## Known issues / tech debt

- **Real-time is effectively dev-only** due to the `localhost`-only WebSocket check and Vercel serverless not holding long-lived connections. Chat/notifications/nearby-driver updates fall back to polling in production. (Unchanged — see roadmap item 8.)
- **No reconciliation on gas split confirmations** — each side confirms independently; nothing checks the two confirmed amounts agree. (Unchanged — see roadmap item 14.)
- **Photo upload has no object storage** — base64 data URLs stored directly in `profiles`. (Unchanged — see roadmap item 10.)
- **Stale docs**: `README.md` still describes an in-memory store (persistence is real now) and describes auth as not-yet-OAuth (Neon Auth is wired). `backend/.env.example` references Railway, but deployment is actually Vercel.
- **Dead code**: root-level `package.json`/`node_modules` unused by any build; `frontend/src/pages.tsx` and `react-native-web.d.ts` are leftovers from the original React Native scaffold; duplicate `auth.ts` files (`src/auth.ts` and `src/lib/auth.ts`).
- **Third-party map dependencies have no fallback**: OSRM demo server and Nominatim are free, unauthenticated, rate-limited public services — fine for a prototype, risky to depend on for anything with real usage.

## Out of scope (unchanged from original MVP intent)

- Full ID verification; document upload/review for license, insurance, driving record
- In-app payments, credit card storage, refunds/disputes
- Real-time driver/rider tracking beyond the existing nearby-driver map, journey sharing, SOS
- Ratings and reviews
- AI matching, dynamic pricing beyond the simple editable gas-split estimate
- Flight data integration, luggage/vehicle-size ML
- Route-corridor ("on the way") matching — still endpoint-radius based
- Recurring carpools
- Push notifications
- Moving help

## External feedback (2026-08-28)

Unsolicited product/UI feedback came in covering six themes. Each is evaluated against what's actually built, not adopted wholesale — some conflict with deliberate scope decisions above.

1. **Progressive sign-up animation** (an SUV drives down a route, picking up passengers as onboarding steps complete: details+email → ID → selfie/liveness → payment → done). Cosmetic, and the steps it animates mostly don't exist yet — sign-in today is Neon Auth email/OAuth only, with no ID/liveness/payment steps. Revisit once (if) item 5 below gives it real steps to represent; building the animation first would be decorating an onboarding flow that isn't there.
2. **Auto-match instead of manual browse-and-connect** ("system pairs you, accept/cancel," Uber-style). This isn't a UI tweak — it replaces the deliberate manual/symmetric request-offer model (`connections` state machine) and runs directly against the existing "AI matching... out of scope" decision below. Needs its own architecture decision if pursued, not a roadmap line item. Not adopted.
3. **Richer match profile as a trust/icebreaker layer** (rating, shared interests, nationality, alongside name). Rating is explicitly out of scope today (no ratings system exists). Shared interests / nationality are cheap additions to `profiles` if we want them, independent of the rating piece.
4. **Explicit Passenger/Driver mode toggle.** The backend already supports one account acting as both rider and driver — there's just no dedicated UI toggle for it, and no prompt into driver verification when a passenger first switches to Driver mode. Concrete, buildable UI work; added to the roadmap below.
5. **Materially stronger driver verification**: live (not uploaded) vehicle photos, AI-based damage/feature checks (headlights, brake lights, indicators, plate), insurance verification, background checks. This directly reopens "Full ID verification; document upload/review for license, insurance, driving record," which is currently out of scope — vehicle/license/insurance are self-declared only. It's also a large, separate initiative (vision model, background-check vendor, insurance verification integration), not incremental hardening. Track as its own future phase rather than a roadmap line.
6. **Group Carpool UI details.** This already exists as the `pools`/`pool_memberships` feature. The concrete ask — driver sets pickup location, departure time, and manages the group chat; passengers immediately see pickup, ETA, destination, seats available, current passengers (optional), and get the group chat after joining — is actionable now as a UI audit against the existing Pools screens, not new scope.
7. **Branding: keep navy blue as primary, paired with white and a lighter accent.** Already the direction in place (green→blue switch, then deepened to royal blue `#2848c8`/`#5b7beb` per recent commits). No action needed — treat as confirmation of the current direction, not a change.

## Future improvements roadmap

Roughly ordered by what would most reduce risk or unblock real usage:

**Correctness / safety (do before real users touch this):**
1. ~~Fix the backend/frontend test suites so there's a passing baseline again~~ — **done.** `Store(database_url=...)` and Postgres-backed backend tests are green (`backend/tests/test_mvp_api.py`, `backend/tests/conftest.py`); frontend `vitest` rewritten against the real Neon Auth gate (`frontend/src/test-setup.ts`, `frontend/src/test-support/`).
2. ~~Verify the Neon Auth session server-side instead of trusting a client-supplied email in `/auth/login`~~ — **done.** `/auth/login` now calls `verify_neon_auth_token` against Neon's JWKS (issuer + audience checked) before minting a session JWT; failures and suspended-account logins are audit-logged. → Issue 24.
3. ~~Add authorization to the expire endpoints and put them on a schedule~~ — **done.** `/ride-requests/expire`, `/driver-trips/expire`, and `/connections/expire` now require `RequireCronSecret`, and `GET /cron/expire` is the single entry point Vercel Cron calls. → Issue 25 (the `/messages`/`/profile` authorization audit this issue also covered has not been separately re-verified).
4. ~~Add a UI entry point for block/report~~ — **done.** A `...` overflow menu on listing cards and connection cards now exposes Block/Report. → Issue 32.

**Architecture decisions worth making deliberately:**
5. Decide whether `Pool` should stay a separate bolt-on concept or eventually unify with `RideRequest`/`DriverTrip` into one listing model — right now both coexist and could confuse future feature work. Still open.
6. ~~Decide the fate of PostGIS~~ — **done.** `search_ride_requests`, `search_driver_trips`, and `get_nearby_drivers` now filter with `ST_DWithin`/`ST_Distance` over `geography` columns instead of Python haversine loops. → Issue 28.
7. ~~Persist driver location instead of an in-memory dict~~ — **done.** `update_driver_location` upserts into the Postgres `driver_locations` table (PostGIS `geog` column); it survives serverless cold starts. → Issue 27.
8. ~~Pick a real-time strategy for production~~ — **decided 2026-08-28**: hybrid. Short-interval polling fallback everywhere, with room to swap in a hosted realtime service (Ably/Pusher) later; remove the dead-in-prod `localhost`-only WebSocket gate. The decision stands but the implementation hasn't landed — `frontend/src/api.ts` still gates `createWebSocket` to `localhost`/`127.0.0.1`, so real-time is still dev-only in production. → Issue 29, still open.
9. Whether to move from manual browse-and-connect to some form of auto-matching (external feedback, item 2 above) — **partially decided 2026-08-28**: still **not adopted**. The 2026-08-28 hardening initiative's "algorithmic match cards" (below) is a ranking/presentation layer over the existing manual request-offer model — it surfaces the top 2–3 scored matches as cards with an "Instant Request Match" CTA, but that CTA still creates a `pending` connection through the existing state machine, not an auto-accepted pair. Full Uber-style auto-pairing (system proposes, both sides accept/cancel with no browse step) remains undecided; if wanted, it needs its own follow-up decision. → Issue 30 for the ranking/card UI; issue 22 stays open for the full auto-pairing question.

**Hardening / cleanup:**
10. Move photo storage off inline base64-in-Postgres to object storage (S3/R2/Vercel Blob) with a CDN URL. Still open. → Issue 26.
11. Add an authenticated/rate-limited routing & geocoding provider (or at least caching + a fallback) instead of depending on public OSRM/Nominatim with no key. Still open.
12. Delete dead code: root `package.json`/`node_modules`, `frontend/src/pages.tsx`, `react-native-web.d.ts`, duplicate `auth.ts`. Still open — all four still present.
13. Update `README.md` and `backend/.env.example` to match the actual Neon/Vercel/Postgres-persisted reality. Still open — `README.md` still describes an in-memory store and name+email-only auth.
14. Reconcile gas-split confirmations — currently each side can confirm independently with no check that the amounts agree. Still open.
15. ~~Audit the Pools UI against external feedback's group-carpool expectations~~ — **mostly done.** The pool card shows pickup, destination, departure time, a named roster (organizer + members), seats filled/`max_participants`, and a group chat toggle (`frontend/src/PoolView.tsx`). A per-pool ETA is not shown; add it if still wanted.
16. ~~Add a Passenger/Driver mode toggle to the home screen~~ — **done** (issue 19: session-persisted mode choice, gating the Discover feed; issue 20: first-time Driver-mode switch routes into vehicle setup).

**Deferred product features (still genuinely post-MVP, not urgent):**
17. Email and push notifications (in-app/polled only today).
18. Ratings and reviews (completion data is already recorded to support this later). Still out of scope — see the 2026-08-28 initiative note below on "rating" vs. trip count.
19. Route-corridor ("on the way") matching instead of endpoint-radius only. Still out of scope — the 2026-08-28 "algorithmic match cards" work (item 23 below) ranks *within* endpoint-radius results by departure window/pickup proximity/shared interests; it does not add corridor/route-overlap matching.
20. Dedicated flows for airport/student/community tags beyond the current lightweight tag field.
21. ~~Shared-interest / nationality fields on `profiles` as trust/icebreaker signals~~ (external feedback, item 3 above) — **done, backend and frontend.** `profiles.interests`/`profiles.nationality` are editable in the profile editor, and match cards surface shared interests plus a nationality badge.
22. Progressive, milestone-based sign-up animation (external feedback, item 1 above) — worth building once there are real multi-step verification stages to represent; premature against today's single-step sign-in.

**Production hardening & role-aware matching initiative (2026-08-28):**

A follow-up spec came in covering the remaining production gaps above plus new UX scope. Items already covered by the roadmap above are cross-referenced rather than restated; genuinely new scope is listed here.

23. Algorithmic "Best Matches" card deck — replace the flat marketplace feed with a ranked top-2–3 card deck (departure window, pickup proximity, shared-interest overlap) showing driver identity, verified badge (`profiles.photo_verified`, not a star rating — ratings stay out of scope per item 18), trip specs, and an "Instant Request Match" CTA that creates a `pending` connection through the existing state machine. See roadmap item 9's decision note above. → Issue 30.
24. Simplify listing creation: auto-fill driver vehicle specs from profile settings when creating a trip; hide driver-only fields when posting a ride request and rider-only fields when posting a trip. (The gas-split estimator itself — $3.50/gal at 28 MPG — already exists per issue 11; no new work there.) → Issue 31.
25. Notification UX overhaul: deep-link each notification type to its record (connection → Inbox, chat message → the specific thread, gas split confirmed → the split detail view), add unread visual state (accent pill + card background per the design tokens below) vs. read (white), add "Mark all as read" and a per-item dismiss, and add category pill filters (All / Connections / Chat / Payments). This is UX on top of the existing in-app/polled notifications (item 17) — it does not add email/push. → Issue 33.
26. **Design system token conflict — needs confirmation, not yet applied.** External feedback item 7 (recorded above) concluded the current royal-blue direction (`#2848c8` / `#5b7beb`) needed no change. The 2026-08-28 spec specifies *different* hex values: primary navy `#0F172A`/`#1E3A8A`, accent sky blue/cyan `#0284C7`, backgrounds white/`#F8FAFC`. These are a real rebrand, not a restatement of the existing direction. Treated here as the newer, more specific instruction and scoped as issue 34, but flagging the conflict explicitly since it reverses a previously "no action needed" conclusion — confirm before merging.

## Further notes

This PRD was originally written before implementation began and described an intended React Native + FastAPI + PostGIS system. The actual build diverged from that plan (web SPA instead of native app, MapLibre instead of Leaflet) and grew scope the original PRD didn't anticipate — Pools, driver "Start Driving" navigation, and an admin/moderation panel — while still delivering the core marketplace loop the original PRD asked for. PostGIS, unlike the initial build, is now actually wired in rather than unused. Treat the "Future improvements roadmap" above as the working backlog — update it as items get done or reprioritized, rather than letting this document drift out of sync with the code again.
