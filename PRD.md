# Carpool PRD

## Problem Statement

People who need rides and people who are already driving to similar destinations lack a simple, trusted way to find each other, coordinate details, and agree on a fair gas split without turning the product into a full rideshare, payment, or safety platform too early.

Riders need to publish where they want to go, find drivers going to similar destinations, and coordinate a practical pickup. Drivers need to publish planned trips, discover relevant rider requests, manage available seats, and decide who to connect with. Both sides need enough structure to feel organized, but enough flexibility to coordinate real-world timing through chat.

## Current State (as of 2026-07-21)

The MVP marketplace loop — sign in, create profile, publish listing, search, connect, coordinate, confirm gas split — is **built and working locally**. The product has also grown a second, additional feature (community Pools) beyond the original two-sided marketplace, and the deployed (Vercel) environment has real gaps relative to local dev that need attention before this is genuinely production-ready.

This document describes the system as it actually exists, then lists the improvements needed to close the gap between "works on my machine" and "safe to put in front of real users."

## Architecture (as built)

- **Frontend**: Vite + React 18 SPA (TypeScript), not React Native. `frontend/`. Tailwind 4, `react-router-dom` v7, `motion`, `lucide-react`. Deployed as a static build to Vercel (`frontend/vercel.json`).
  - Dead scaffold code remains from the original React Native plan: `frontend/src/pages.tsx` and `frontend/src/react-native-web.d.ts` are unused (not imported by `App.tsx`).
- **Backend**: FastAPI (Python), `backend/app/main.py`. Deployed as a Vercel Python serverless function via `api/index.py`, routed by the root `vercel.json`. Not a long-running server.
- **Database**: Postgres on Neon, accessed with raw `psycopg2` — no ORM. Schema is created idempotently in code (`backend/app/db.py: run_migrations()`); the checked-in SQL files under `backend/migrations/` are stale/incomplete and are not the real source of truth.
- **Auth**: Two layers, bridged rather than unified.
  - Neon Auth (`@neondatabase/neon-js`, `@neondatabase/auth-ui`) provides the real sign-in UI/session in the browser.
  - The FastAPI backend has its own trivial `/auth/login` (name + email, no password, no OAuth) that trusts whatever email the frontend hands it and mints its own self-issued HS256 JWT. It does **not** verify the Neon Auth session server-side — the two systems are connected by convention, not by a verified handoff.
- **Real-time**: A WebSocket implementation exists (`ConnectionManager` in `main.py`, `/ws/{user_id}`) for chat messages, connection updates, and nearby-driver broadcasts — but the frontend explicitly disables it whenever the API is not on `localhost` (`frontend/src/api.ts`). So **real-time is dev-only**; production silently falls back to no live updates, which also fits Vercel's serverless model not supporting long-lived sockets well.
- **Maps / location**: Leaflet for rendering, OSRM's public demo server for road routing, Nominatim (OSM) for geocoding/address search — all free, keyless, third-party services with no rate-limit handling or fallback provider.
- **PostGIS**: declared in SQL (`CREATE EXTENSION postgis`) but functionally unused. All distance/matching math is Python haversine over plain `DOUBLE PRECISION` lat/lng columns.
- **Deployment**: two independent Vercel projects (frontend static build, backend Python serverless function), both reading from the same Neon database. `run.sh` requires a real Neon `DATABASE_URL` for local dev now; `docker-compose.yml` (local Postgres+PostGIS) is a vestige of the earlier local-only setup.

## Data model (as built)

Both the original two-sided listing model and a newer community-pool model exist side by side:

- `users`, `profiles` (display name, photo, bio, `photo_verified`), `vehicles` (make/model/color/seats, `car_type`, self-declared license/insurance/driving record)
- `locations` (lat/lng, label, provider metadata)
- `ride_requests` / `driver_trips` — the PRD's original rider/driver listing split, including `luggage_size`/`luggage_capacity` and `car_type`/`preferred_car_type`, tags (`airport`, `student`, plus `church`/`college`/`work`/`event` added since), and the full `open/expired/matched/cancelled/completed` status enum
- `connections` — links one ride request to one driver trip, full `pending/expired/accepted/declined/cancelled/completed` state machine, seat reservation
- `messages` — canned vs. free-text, gated by connection state
- `gas_split_confirmations` — suggested-fare + manual confirmation per side (haversine distance, $3.50/gal, 28mpg assumption)
- `notifications` — in-app only, polled
- `reports`, `blocks` — backend enforcement wired into search/connect/message
- `pools`, `pool_memberships` — **new, not in the original PRD**: organizer-created group trips with a community tag, capacity, and seats-per-vehicle, auto-flipping to `full`
- `driver_locations` — declared in SQL as a PostGIS geography column, but actually kept **only in-memory** in the backend process, not persisted. This does not survive a serverless cold start.

## Feature status

| Area | Status |
|---|---|
| Sign in / profile | Working via Neon Auth UI, bridged to a trust-on-email backend session (not cryptographically verified) |
| Ride requests / driver trips (create, search, filter by radius/date/tag/luggage/car type) | Fully built, Postgres-persisted |
| Community pools | Fully built — new feature beyond original scope |
| Connections (request/offer, accept/decline, seat reservation) | Fully built, matches the original state machine |
| Chat (canned while pending, full after accepted) | Fully built, including inbox UI and unread badges |
| Gas split (suggested fare + manual confirmation) | Built as a suggestion + independent confirmation; no reconciliation if the two sides confirm different amounts |
| Block / report | Backend complete (enforced in search/connect/message); **no UI entry point found** to actually block or report someone |
| Listing/connection expiry | Domain logic and endpoints exist, but **nothing calls them automatically** — no cron/scheduled job, so nothing expires in production without a manual API call. The expiry endpoints also have no ownership/authorization check. |
| Notifications | In-app/polled only. No email, no push. |
| Live driver location (map) | Works locally; in-memory only, lost on every serverless cold start; real-time push disabled outside localhost |
| Photo upload | Base64 data URL stored directly in the `profiles` table — no object storage/CDN |
| Maps/routing | Real road routing (OSRM) and geocoding (Nominatim), both public/keyless with no fallback |
| PostGIS | Declared, not used — all geo queries are Python haversine |

## Known issues / tech debt

- **Automated tests are currently broken on both sides.** Backend `pytest` can't even collect (`Store()` now requires a `database_url`; the test file wasn't updated after the Postgres migration and the module eagerly connects to Postgres at import time). Frontend `vitest` is 11/12 failing because tests assume the old name+email sign-in gate, which Neon Auth's `<AuthView>` has replaced. There is currently no passing safety net for either side.
- **Auth bridging is not secure**: the backend's `/auth/login` trusts a client-supplied email with no verification against the Neon Auth session. Anyone who can call the API directly can authenticate as any email.
- **Real-time is effectively dev-only** due to the `localhost`-only WebSocket check and Vercel serverless not holding long-lived connections.
- **Driver location is not durable** — in-memory dict, wiped on cold start, and inconsistent with the PostGIS geography column declared for it in SQL.
- **No automatic expiry** — stale listings/connections never transition to `expired` in production; the manual expiry endpoints are also unauthenticated for any caller.
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
2. Verify the Neon Auth session server-side instead of trusting a client-supplied email in `/auth/login` — otherwise anyone can authenticate as any user by calling the API directly. → Issue 24.
3. Add authorization to the `/ride-requests/expire`, `/driver-trips/expire`, `/connections/expire` endpoints, and put them on a schedule (Vercel Cron or similar) so stale listings/connections actually expire without a manual trigger. → Issue 25 (also extends the authorization audit to `/messages` and `/profile`).
4. Add a UI entry point for block/report — the backend enforcement exists but is currently unreachable from the app. → Issue 32 (scoped up to a `...` overflow menu on profiles, inbox cards, and chat headers, per the 2026-08-28 hardening initiative below).

**Architecture decisions worth making deliberately:**
5. Decide whether `Pool` should stay a separate bolt-on concept or eventually unify with `RideRequest`/`DriverTrip` into one listing model — right now both coexist and could confuse future feature work. Still open.
6. ~~Decide the fate of PostGIS~~ — **decided 2026-08-28**: adopt it. Replace the Python haversine loops with `ST_DWithin`/`ST_Buffer` queries. → Issue 28.
7. Persist driver location (Postgres or a fast store like Redis) instead of an in-memory dict, so live tracking survives serverless cold starts. → Issue 27.
8. ~~Pick a real-time strategy for production~~ — **decided 2026-08-28**: hybrid. Short-interval polling fallback everywhere, with room to swap in a hosted realtime service (Ably/Pusher) later; remove the dead-in-prod `localhost`-only WebSocket gate. → Issue 29.
9. Whether to move from manual browse-and-connect to some form of auto-matching (external feedback, item 2 above) — **partially decided 2026-08-28**: still **not adopted**. The 2026-08-28 hardening initiative's "algorithmic match cards" (below) is a ranking/presentation layer over the existing manual request-offer model — it surfaces the top 2–3 scored matches as cards with an "Instant Request Match" CTA, but that CTA still creates a `pending` connection through the existing state machine, not an auto-accepted pair. Full Uber-style auto-pairing (system proposes, both sides accept/cancel with no browse step) remains undecided; if wanted, it needs its own follow-up decision. → Issue 30 for the ranking/card UI; issue 22 stays open for the full auto-pairing question.

**Hardening / cleanup:**
10. Move photo storage off inline base64-in-Postgres to object storage (S3/R2/Vercel Blob) with a CDN URL. → Issue 26.
11. Add an authenticated/rate-limited routing & geocoding provider (or at least caching + a fallback) instead of depending on public OSRM/Nominatim with no key.
12. Delete dead code: root `package.json`/`node_modules`, `frontend/src/pages.tsx`, `react-native-web.d.ts`, duplicate `auth.ts`.
13. Update `README.md` and `backend/.env.example` to match the actual Neon/Vercel/Postgres-persisted reality.
14. Reconcile gas-split confirmations — currently each side can confirm independently with no check that the amounts agree.
15. Audit the Pools UI against external feedback's group-carpool expectations (external feedback, item 6 above): confirm the driver can set pickup location, departure time, and manage the group chat, and that passengers see pickup, ETA, destination, seats available, and current passengers at a glance before joining. Backend done (issues 16–18); **frontend still pending** — pool card departure-time/roster display and the pool chat UI.
16. ~~Add a Passenger/Driver mode toggle to the home screen~~ — **done** (issue 19: `TopBar` toggle, session-persisted; issue 20: first-time Driver-mode switch routes into vehicle setup).

**Deferred product features (still genuinely post-MVP, not urgent):**
17. Email and push notifications (in-app/polled only today).
18. Ratings and reviews (completion data is already recorded to support this later). Still out of scope — see the 2026-08-28 initiative note below on "rating" vs. trip count.
19. Route-corridor ("on the way") matching instead of endpoint-radius only. Still out of scope — the 2026-08-28 "algorithmic match cards" work (item 23 below) ranks *within* endpoint-radius results by departure window/pickup proximity/shared interests; it does not add corridor/route-overlap matching.
20. Dedicated flows for airport/student/community tags beyond the current lightweight tag field.
21. Shared-interest / nationality fields on `profiles` as trust/icebreaker signals (external feedback, item 3 above) — cheap to add independent of the ratings piece, which stays out of scope. Backend done (issue 21: `profiles.interests`/`profiles.nationality`); **frontend profile-editor fields still pending.**
22. Progressive, milestone-based sign-up animation (external feedback, item 1 above) — worth building once there are real multi-step verification stages to represent; premature against today's single-step sign-in.

**Production hardening & role-aware matching initiative (2026-08-28):**

A follow-up spec came in covering the remaining production gaps above plus new UX scope. Items already covered by the roadmap above are cross-referenced rather than restated; genuinely new scope is listed here.

23. Algorithmic "Best Matches" card deck — replace the flat marketplace feed with a ranked top-2–3 card deck (departure window, pickup proximity, shared-interest overlap) showing driver identity, verified badge (`profiles.photo_verified`, not a star rating — ratings stay out of scope per item 18), trip specs, and an "Instant Request Match" CTA that creates a `pending` connection through the existing state machine. See roadmap item 9's decision note above. → Issue 30.
24. Simplify listing creation: auto-fill driver vehicle specs from profile settings when creating a trip; hide driver-only fields when posting a ride request and rider-only fields when posting a trip. (The gas-split estimator itself — $3.50/gal at 28 MPG — already exists per issue 11; no new work there.) → Issue 31.
25. Notification UX overhaul: deep-link each notification type to its record (connection → Inbox, chat message → the specific thread, gas split confirmed → the split detail view), add unread visual state (accent pill + card background per the design tokens below) vs. read (white), add "Mark all as read" and a per-item dismiss, and add category pill filters (All / Connections / Chat / Payments). This is UX on top of the existing in-app/polled notifications (item 17) — it does not add email/push. → Issue 33.
26. **Design system token conflict — needs confirmation, not yet applied.** External feedback item 7 (recorded above) concluded the current royal-blue direction (`#2848c8` / `#5b7beb`) needed no change. The 2026-08-28 spec specifies *different* hex values: primary navy `#0F172A`/`#1E3A8A`, accent sky blue/cyan `#0284C7`, backgrounds white/`#F8FAFC`. These are a real rebrand, not a restatement of the existing direction. Treated here as the newer, more specific instruction and scoped as issue 34, but flagging the conflict explicitly since it reverses a previously "no action needed" conclusion — confirm before merging.

## Further notes

This PRD was originally written before implementation began and described an intended React Native + FastAPI + PostGIS system. The actual build diverged in several ways (web SPA instead of native app, Neon Auth instead of custom OAuth, PostGIS unused, an added Pools feature) while still delivering the core marketplace loop the original PRD asked for. Treat the "Future improvements roadmap" above as the working backlog — update it as items get done or reprioritized, rather than letting this document drift out of sync with the code again.
