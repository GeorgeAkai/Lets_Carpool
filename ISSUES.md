# Carpool MVP Issues

These issues were generated from `PRD.md` using tracer-bullet vertical slices. They are ordered by dependency so they can be copied into an issue tracker in sequence.

## 1. Create App Foundation And Healthcheck

## What to build

Create the greenfield application foundation so the team can run the shared mobile/web frontend, backend API, database, migrations, and tests from a clean checkout. The first demoable behavior is a frontend shell calling a FastAPI health endpoint backed by a working PostgreSQL/PostGIS connection.

## Acceptance criteria

- [ ] React Native with web support can run a basic app shell.
- [ ] FastAPI exposes a health endpoint that the frontend can call.
- [ ] PostgreSQL with PostGIS is configured for local development.
- [ ] Database migrations can be created and applied.
- [ ] A smoke test verifies frontend-to-backend connectivity.
- [ ] A backend test verifies database connectivity and PostGIS availability.

## Blocked by

None - can start immediately.

---

## 2. Sign In And Create Profile

## What to build

Allow a new user to sign in with OAuth, create or fetch their app user record, create an initial profile, capture verified email/domain, and receive an app session for authenticated API calls.

## Acceptance criteria

- [ ] Users can start OAuth sign-in from the frontend.
- [ ] The backend verifies OAuth provider tokens through a replaceable provider interface.
- [ ] First sign-in creates a user and profile.
- [ ] Repeat sign-in fetches the existing user and profile.
- [ ] Verified email and email domain are stored.
- [ ] The app issues its own session or JWT after provider verification.
- [ ] Authenticated frontend requests include the app session.
- [ ] Tests cover new-user sign-in, returning-user sign-in, and email-domain capture with mocked providers.

## Blocked by

- Issue 1. Create App Foundation And Healthcheck

---

## 3. Edit Profile And Driver Readiness

## What to build

Let users maintain their public profile and driver readiness details from the same account. A user can edit display identity, add vehicle details, and self-declare license, insurance, and good driving record without document upload.

## Acceptance criteria

- [ ] Users can edit display name, profile photo, and short bio.
- [ ] Users can add and edit basic vehicle details.
- [ ] Users can self-declare license, insurance, and good driving record.
- [ ] Driver readiness fields are visible where relevant to rider-facing views.
- [ ] The app does not request document uploads or perform verification review.
- [ ] Tests cover profile updates, vehicle updates, and self-declaration persistence.

## Blocked by

- Issue 2. Sign In And Create Profile

---

## 4. Normalize Geocoded Locations

## What to build

Create the location foundation used by rider requests, driver trips, search, and privacy-aware display. The app should use a managed geocoding provider through a replaceable integration while storing normalized app-owned location data.

## Acceptance criteria

- [ ] Users can search for an address or place through the frontend.
- [ ] The backend stores normalized latitude, longitude, display label, optional structured metadata, provider identifier, and timestamps.
- [ ] Provider response blobs are not treated as the source of truth.
- [ ] Location records can produce approximate display labels before acceptance.
- [ ] Location records can produce exact pickup/dropoff details after acceptance.
- [ ] Tests cover provider abstraction, normalized persistence, and approximate/exact display behavior.

## Blocked by

- Issue 1. Create App Foundation And Healthcheck

---

## 5. Publish Rider Ride Requests

## What to build

Allow riders to create, view, cancel, and expire one-off `RideRequest` listings with geocoded pickup/dropoff, flexible timing, passenger count, and lightweight tags.

## Acceptance criteria

- [ ] Authenticated users can create a ride request.
- [ ] Ride requests include pickup, destination, target date/flexibility, passenger count, and optional tags.
- [ ] Supported MVP tags include `airport` and `student`.
- [ ] Ride requests are created with `open` status.
- [ ] Riders can cancel their own ride requests.
- [ ] Ride requests expire after the relevant date/flexibility window.
- [ ] Stale or cancelled ride requests do not appear in active discovery.
- [ ] Tests cover creation, validation, cancellation, expiry, and tag persistence.

## Blocked by

- Issue 2. Sign In And Create Profile
- Issue 4. Normalize Geocoded Locations

---

## 6. Publish Driver Trips

## What to build

Allow drivers to create, view, cancel, and expire one-off `DriverTrip` listings with geocoded pickup/dropoff, flexible timing, available seats, and lightweight tags.

## Acceptance criteria

- [ ] Authenticated users with driver readiness details can create a driver trip.
- [ ] Driver trips include pickup, destination, target date/flexibility, seats available, and optional tags.
- [ ] Supported MVP tags include `airport` and `student`.
- [ ] Driver trips are created with `open` status.
- [ ] Drivers can cancel their own driver trips.
- [ ] Driver trips expire after the relevant date/flexibility window.
- [ ] Stale or cancelled driver trips do not appear in active discovery.
- [ ] Tests cover creation, validation, cancellation, expiry, seats available, and tag persistence.

## Blocked by

- Issue 3. Edit Profile And Driver Readiness
- Issue 4. Normalize Geocoded Locations

---

## 7. Search Opposite Listings

## What to build

Let authenticated users discover relevant opposite-side listings. Riders search driver trips. Drivers search rider requests. Search should use endpoint destination radius, pickup proximity, target date/flexibility, and tags. Route-corridor matching is intentionally out of scope.

## Acceptance criteria

- [ ] Riders can search open driver trips.
- [ ] Drivers can search open ride requests.
- [ ] Search supports destination-radius filtering.
- [ ] Search supports pickup-proximity filtering.
- [ ] Search supports target date/flexibility filtering.
- [ ] Search supports `airport` and `student` tag filtering.
- [ ] Search results do not include expired, cancelled, completed, or blocked listings.
- [ ] Tests cover PostGIS destination-radius filtering, pickup proximity, tag filtering, and exclusion of inactive listings.

## Blocked by

- Issue 5. Publish Rider Ride Requests
- Issue 6. Publish Driver Trips

---

## 8. Create And Manage Connections

## What to build

Support symmetric manual connection initiation. A rider can request to join a driver trip, and a driver can offer a ride on a rider request. The recipient can accept, decline, or allow the connection to expire.

## Acceptance criteria

- [ ] Riders can create a pending connection from a driver trip.
- [ ] Drivers can create a pending connection from a ride request.
- [ ] Connection states include `pending`, `expired`, `accepted`, `declined`, `cancelled`, and `completed`.
- [ ] Recipients can accept or decline pending connections.
- [ ] Either participant can cancel where allowed.
- [ ] Pending connections expire after the relevant ride date/flexibility window.
- [ ] A connection links exactly one ride request and one driver trip.
- [ ] Tests cover both initiation directions and all state transitions.

## Blocked by

- Issue 7. Search Opposite Listings

---

## 9. Reserve Seats On Accepted Connections

## What to build

Ensure accepting connections reserves driver-trip seats and prevents overbooking. Seat availability must stay correct when multiple ride requests compete for the same driver trip.

## Acceptance criteria

- [ ] Ride requests declare passenger count.
- [ ] Driver trips declare seats available.
- [ ] Accepting a connection reserves the requested passenger count against the driver trip.
- [ ] The app prevents accepting a connection that would exceed available seats.
- [ ] Cancelled accepted connections release seats if the ride has not completed.
- [ ] Concurrent accept attempts cannot overbook seats.
- [ ] Tests cover reservation, release, insufficient seats, and concurrent overbooking prevention.

## Blocked by

- Issue 8. Create And Manage Connections

---

## 10. Unlock Chat By Connection State

## What to build

Attach chat to connections with state-based permissions. Pending connections allow only canned or quick messages. Accepted connections unlock full chat.

## Acceptance criteria

- [ ] Creating a connection creates or exposes a chat thread.
- [ ] Pending connections allow only approved canned/quick messages.
- [ ] Accepted connections allow full free-text chat.
- [ ] Declined, expired, cancelled, or blocked connections cannot continue normal chat.
- [ ] The frontend clearly distinguishes pending quick-message mode from accepted full-chat mode.
- [ ] Tests cover chat permissions for pending, accepted, declined, expired, cancelled, and blocked states.

## Blocked by

- Issue 8. Create And Manage Connections

---

## 11. Confirm Gas Split

## What to build

Let participants see a suggested gas split, edit assumptions or override the amount, and confirm the final split in app while keeping payment outside the product.

## Acceptance criteria

- [ ] The app shows a suggested split based on estimated distance and editable cost assumptions.
- [ ] Participants can override the suggested amount.
- [ ] Participants can confirm the split in app.
- [ ] Confirmation records include amount, confirmer, timestamp, and cost assumptions or override metadata.
- [ ] Product copy uses "confirm split" and does not use "sign agreement."
- [ ] The app does not collect card details or process payment.
- [ ] Tests cover suggestion calculation, override, confirmation persistence, and forbidden payment behavior.

## Blocked by

- Issue 8. Create And Manage Connections

---

## 12. Send Marketplace Notifications

## What to build

Create in-app and email notifications for important marketplace events so users do not miss connection, chat, or gas split activity. Push notifications are not part of this MVP slice.

## Acceptance criteria

- [ ] Notifications are created for offer/request received.
- [ ] Notifications are created for accept, decline, and cancel events.
- [ ] Notifications are created when chat unlocks.
- [ ] Notifications are created for relevant chat messages.
- [ ] Notifications are created for gas split confirmations.
- [ ] Users can see in-app notifications.
- [ ] Email notifications are sent or queued through a replaceable email integration.
- [ ] Tests cover notification event creation and delivery adapter behavior.

## Blocked by

- Issue 8. Create And Manage Connections
- Issue 10. Unlock Chat By Connection State
- Issue 11. Confirm Gas Split

---

## 13. Complete Rides

## What to build

Allow accepted connections to be marked completed after the ride date and record who confirmed completion. This creates durable ride-history data for future ratings without adding reviews in MVP.

## Acceptance criteria

- [ ] Accepted connections can be marked completed after the ride date/flexibility window.
- [ ] Completion records who confirmed completion and when.
- [ ] Completion does not require in-app payment.
- [ ] Completion does not include ratings, reviews, disputes, or refunds.
- [ ] Completed rides no longer appear as active listings/connections.
- [ ] Tests cover completion eligibility, confirmation metadata, and inactive discovery behavior.

## Blocked by

- Issue 8. Create And Manage Connections
- Issue 11. Confirm Gas Split

---

## 14. Block And Report Users

## What to build

Add basic safety controls so authenticated users can block and report other users. Blocking should affect discovery and chat surfaces enough to prevent unwanted continued interaction in MVP.

## Acceptance criteria

- [ ] Users can report another user with a reason.
- [ ] Reports are stored for later moderation review.
- [ ] Users can block another user.
- [ ] Blocked users are filtered from discovery results where applicable.
- [ ] Blocked users cannot continue normal chat with the blocker.
- [ ] Blocking does not require a full moderation workflow.
- [ ] Tests cover report creation, block creation, discovery filtering, and chat enforcement.

## Blocked by

- Issue 2. Sign In And Create Profile
- Issue 7. Search Opposite Listings
- Issue 10. Unlock Chat By Connection State

---

## 15. Prove MVP Happy Paths

## What to build

Add end-to-end coverage for the core marketplace loops so the MVP can be validated as a coherent product, not just separate features.

## Acceptance criteria

- [ ] E2E test covers rider creates request, driver finds it, driver offers, rider accepts, chat unlocks, split is confirmed, and ride is completed.
- [ ] E2E test covers driver creates trip, rider finds it, rider requests to join, driver accepts, seats are reserved, split is confirmed, and ride is completed.
- [ ] E2E test covers stale listing or pending connection expiry.
- [ ] E2E test covers overbooking prevention for limited driver seats.
- [ ] E2E test covers approximate location before acceptance and exact details after acceptance.
- [ ] The happy-path suite can run locally with documented setup.

## Blocked by

- Issue 9. Reserve Seats On Accepted Connections
- Issue 10. Unlock Chat By Connection State
- Issue 11. Confirm Gas Split
- Issue 12. Send Marketplace Notifications
- Issue 13. Complete Rides
- Issue 14. Block And Report Users

---

# External Feedback Issues (2026-08-28)

Generated from the "External feedback" and "Future improvements roadmap" sections of `PRD.md`, itself sourced from unsolicited product/UI feedback. Kept local rather than published to the issue tracker.

**Progress (2026-08-28):** Backend TDD complete for #16, #17, #18, #21 (schema + API + tests, all green — see `backend/tests/test_mvp_api.py`). #19 and #20 are fully complete, backend and frontend, with tests. The frontend UI for #16/#17/#18/#21 (Pool card departure-time/roster display, pool chat UI, profile interest/nationality fields) is not yet wired — the API is ready for it. As a prerequisite, the backend test harness (was fully broken — `Store()` needed a `database_url`) and the frontend test suite (was 11/12 failing) were both fixed; see PRD.md roadmap item #1, now done.

## 16. Add Pool Departure Time And ETA Display

**Type:** AFK

**Status:** Backend done (schema, `PoolCreate`, `serialize_pool` all return/persist `departure_time`). Frontend form + card display still pending.

## What to build

Pools currently only carry a `trip_date` (date, no time). Add a `departure_time` to pool creation, storage, and API responses, and surface it as the estimated departure/arrival time on pool browse cards so passengers can see timing at a glance, not just the date.

## Acceptance criteria

- [ ] Pool creation form collects a departure time alongside the trip date.
- [ ] `PoolCreate` and the pool schema/table persist `departure_time`.
- [ ] `serialize_pool` / the pools API includes `departure_time` in responses.
- [ ] Pool browse cards in `PoolView.tsx` display the departure time next to the date.
- [ ] Tests cover creating a pool with a departure time and reading it back.

## Blocked by

None - can start immediately.

---

## 17. Show Pool Passenger Roster With Names

**Type:** AFK

**Status:** Backend done (`serialize_pool` members now include `display_name`/`photo_url`). Frontend roster display still pending.

## What to build

`get_pool_members` / `serialize_pool` currently return only `user_id`, `role`, and `joined_at` for pool members — the UI shows anonymous dot indicators for the member count, not who is actually in the pool. Join profile display name/photo into the members list and show a real roster (name + optional avatar) on the pool card, matching the "current passengers (optional)" expectation from feedback.

## Acceptance criteria

- [ ] The pools API returns each member's display name (and photo, if available) alongside `user_id`/`role`.
- [ ] `PoolView.tsx` shows passenger names/avatars instead of (or alongside) the dot-count indicator.
- [ ] The organizer is visually distinguishable from passengers in the roster.
- [ ] Tests cover roster data returned for a pool with multiple members.

## Blocked by

None - can start immediately.

---

## 18. Add Pool Group Chat

**Type:** AFK

**Status:** Backend done (`pool_messages` table, `POST`/`GET /pools/{id}/messages`, membership-gated, tested). Frontend chat UI still pending.

## What to build

Chat currently only attaches to `connections` — there is no chat thread for Pools at all. Add a chat thread scoped to each pool: members can read and post messages once joined, and the organizer has the same access (no separate moderation tooling in this slice — that can be a follow-up). Reuse the existing chat UI patterns (inbox, message list) rather than building a new component style.

## Acceptance criteria

- [ ] A chat thread is created for (or lazily attached to) each pool.
- [ ] Only members of a pool (including the organizer) can read or post messages in its thread.
- [ ] Leaving a pool revokes further posting access to its thread.
- [ ] The frontend surfaces the pool chat from the pool card once the user has joined (or is the organizer).
- [ ] Tests cover posting/reading permissions for members, non-members, and a user who has left.

## Blocked by

None - can start immediately.

---

## 19. Add Passenger/Driver Mode Toggle

**Type:** AFK

**Status:** Done. Toggle in `TopBar` (`pages/home.tsx`), persisted to `sessionStorage`, drives the Post form's default listing type. Tested in `App.test.tsx`. Scoped down from the original ask: the toggle does NOT auto-change the Feed's search filter (an early attempt at that hid same-type listings by default and regressed existing browse tests/behavior) — Feed filtering stays manual, as it already was.

## What to build

One account already supports acting as both rider and driver, but there is no explicit UI for switching between them. Add a toggle at the top of the home screen that switches between Passenger and Driver views (which listing type is created/searched, which actions are shown) for users already set up in both roles.

## Acceptance criteria

- [ ] A mode toggle is visible at the top of the home screen.
- [ ] Switching modes changes the home screen's primary actions/views between rider-facing and driver-facing.
- [ ] The toggle state persists across a session (at minimum) so the app doesn't reset to a default mode on every navigation.
- [ ] Switching is seamless (no extra confirmation step) for a user already verified/set up for both roles.
- [ ] Tests cover toggling mode and the resulting view/action changes.

## Blocked by

None - can start immediately.

---

## 20. Route First-Time Driver Switch Into Vehicle Setup

**Type:** AFK

**Status:** Done. `handleSetMode` in `pages/home.tsx` routes to the Profile view (where the vehicle form lives) when switching to Driver mode with no vehicle on file. Tested in `App.test.tsx`.

## What to build

When a passenger with no `vehicles` row switches to Driver mode for the first time, route them into the existing driver vehicle-details/self-declaration form instead of just flipping the UI to an empty driver view.

## Acceptance criteria

- [ ] Switching to Driver mode checks whether the current user has a `vehicles` row.
- [ ] If none exists, the user is routed into the existing vehicle-details/self-declaration form before landing on the driver home view.
- [ ] Completing the form lands the user in Driver mode with their new vehicle available.
- [ ] Users who already have a vehicle switch straight into Driver mode with no interruption.
- [ ] Tests cover both the first-time-switch and already-a-driver paths.

## Blocked by

- Issue 19. Add Passenger/Driver Mode Toggle

---

## 21. Add Shared-Interest And Nationality Profile Fields

**Type:** AFK

**Status:** Backend done (`profiles.interests`/`profiles.nationality`, `ProfileUpdate`, tested — set-and-read-back and omit-stays-valid). Frontend profile editor fields still pending.

## What to build

Add optional `interests` (tags) and `nationality` fields to `profiles`, editable in profile settings, and displayed on the counterpart's profile once a connection exists — as lightweight trust/icebreaker signals. This is independent of ratings, which remain out of scope.

## Acceptance criteria

- [ ] `profiles` stores optional `interests` (a small tag set) and `nationality`.
- [ ] Users can set/edit these fields from profile settings.
- [ ] Fields are optional — profiles without them render normally.
- [ ] The counterpart's profile view (post-connection) displays these fields when present.
- [ ] Tests cover setting, updating, and displaying the fields, including the empty case.

## Blocked by

None - can start immediately.

---

## 22. Decide Manual Connect Vs Auto-Match Interaction Model

**Type:** HITL

## What to build

Feedback proposed replacing manual browse-and-connect with Uber-style auto-pairing (system proposes a match, both sides accept/cancel). This conflicts with the current deliberate manual/symmetric connection model and the "AI matching... out of scope" line in `PRD.md`. This issue is a decision, not an implementation task.

## Acceptance criteria

- [ ] A decision is recorded (e.g. a short ADR in `docs/adr/`) on whether to pursue auto-matching, keep manual connect, or support both.
- [ ] If auto-matching is approved, a follow-up scoping/implementation issue is opened.
- [ ] `PRD.md`'s "Out of scope" / roadmap sections are updated to reflect the decision.

## Blocked by

None - can start immediately.

---

## 23. Scope Decision For Enhanced Driver Verification

**Type:** HITL

## What to build

Feedback proposed live (not uploaded) vehicle photos, AI-based damage/feature checks, insurance verification, and background checks. This reopens the "no ID verification" out-of-scope line in `PRD.md` and is a large, separate initiative (vision model, background-check vendor, insurance verification integration), not incremental hardening. This issue is a scoping decision, not an implementation task.

## Acceptance criteria

- [ ] A decision is recorded on which (if any) of the four sub-components to pursue.
- [ ] Vendor/build options are noted for background checks and insurance verification.
- [ ] `PRD.md`'s "Out of scope" section is updated to reflect the decision.
- [ ] If any component is approved, a follow-up scoping/implementation issue is opened per component.

## Blocked by

None - can start immediately.

---

# Production Hardening & Role-Aware Matching Issues (2026-08-28)

Generated from a follow-up spec covering the remaining `PRD.md` "Future improvements roadmap" items plus new role-aware matching/notification/design-system scope. Deduplicated against issues 1–23: the Passenger/Driver toggle (19, 20), pool departure time/roster/chat (16–18), and shared-interest/nationality fields (21) are already tracked and are **not** repeated here — this batch only covers what's still net-new or still unimplemented. Issue 30 partially informs the still-open decision in issue 22 (see `PRD.md` roadmap item 9): it adds ranked match presentation on top of the existing manual connect model, not full auto-pairing, so issue 22 stays open. Issue 34 is filed as HITL because it reverses a previously recorded "no change needed" branding conclusion (`PRD.md` external feedback item 7) and needs explicit confirmation before the new hex values are treated as final.

## 24. Verify Neon Auth JWT Server-Side

**Type:** AFK

## What to build

`/auth/login` currently trusts a client-supplied name/email with no cryptographic check against the Neon Auth session, so anyone calling the API directly can authenticate as any email. Verify the Neon Auth JWT server-side (signature, issuer, expiry) before minting the app's own session/JWT.

## Acceptance criteria

- [ ] `/auth/login` cryptographically verifies the incoming Neon Auth token (signature, issuer, audience, expiry) instead of trusting the client-supplied payload.
- [ ] Invalid, expired, or forged tokens are rejected with a 401 and do not mint an app session.
- [ ] Valid tokens still produce the existing app-issued session/JWT for authenticated requests, with no change to the frontend auth flow.
- [ ] Tests cover acceptance of a valid token, rejection of an invalid signature, rejection of an expired token, and rejection of a token for a mismatched issuer/audience.

## Blocked by

- Issue 2. Sign In And Create Profile

---

## 25. Authorize And Schedule Expiry Endpoints

**Type:** AFK

## What to build

`/ride-requests/expire`, `/driver-trips/expire`, and `/connections/expire` have no ownership/session check today, and nothing calls them automatically — stale listings/connections never actually expire in production. Add session-ownership checks to these endpoints plus `/messages` and `/profile`, and wire an hourly Vercel Cron trigger to call the `/expire` endpoints automatically.

## Acceptance criteria

- [ ] `/ride-requests/expire`, `/driver-trips/expire`, and `/connections/expire` verify the requesting session owns (or is otherwise authorized for) the resource before acting.
- [ ] `/messages` and `/profile` endpoints are audited and verify session ownership before returning or mutating data.
- [ ] A Vercel Cron entry calls the `/expire` endpoints on an hourly schedule.
- [ ] Expiry still functions correctly when triggered by the scheduled job (not just a manual authenticated call).
- [ ] Tests cover authorization rejection for a non-owner caller on each audited endpoint, and successful expiry via an authorized call.

## Blocked by

- Issue 5. Publish Rider Ride Requests
- Issue 6. Publish Driver Trips
- Issue 8. Create And Manage Connections
- Issue 24. Verify Neon Auth JWT Server-Side

---

## 26. Move Photo Uploads To Object Storage

**Type:** AFK

## What to build

Profile photos are currently stored as inline Base64 in `profiles.photo`, bloating Postgres rows and giving no CDN caching. Replace this with direct uploads to object storage (Vercel Blob, S3, or R2), storing only the resulting CDN URL in Postgres.

## Acceptance criteria

- [ ] Profile photo uploads go to object storage instead of being stored as Base64 in Postgres.
- [ ] `profiles.photo` stores a CDN URL, not raw image data.
- [ ] Existing Base64 photos have a migration path (backfill to object storage or documented one-time script).
- [ ] The frontend upload flow is updated to use the new storage path with no regression to the profile-photo UI.
- [ ] Tests cover successful upload-and-URL-persistence and rejection of oversized/invalid file types.

## Blocked by

- Issue 3. Edit Profile And Driver Readiness

---

## 27. Persist Driver Location Durably

**Type:** AFK

## What to build

Live driver location is currently kept only in an in-memory `driver_locations` dict, which is lost on every serverless cold start. Replace it with persistent storage (Postgres PostGIS geography column, already declared in SQL but unused, or Upstash Redis with a short TTL) so coordinates survive cold starts.

## Acceptance criteria

- [ ] Driver location updates are persisted to durable storage instead of an in-memory dict.
- [ ] A location written before a cold start is still readable after one.
- [ ] Stale locations expire or are treated as stale after a defined TTL.
- [ ] Existing nearby-driver map behavior has no functional regression.
- [ ] Tests cover write-then-read-after-restart behavior (or an equivalent simulated cold-start test) and TTL expiry.

## Blocked by

None - can start immediately.

---

## 28. Adopt PostGIS For Matching Queries

**Type:** AFK

## What to build

PostGIS is declared (`CREATE EXTENSION postgis`) but unused — all distance/matching math is Python haversine over plain lat/lng columns. Replace the Python-side loops with PostGIS spatial queries (`ST_DWithin`, `ST_Buffer`) for route-corridor-adjacent and pickup-proximity matching at the database level. Decision recorded in `PRD.md` roadmap item 6 (2026-08-28): adopt PostGIS rather than drop it.

## Acceptance criteria

- [ ] Lat/lng columns used in matching queries are backed by (or synced to) `geography`/`geometry` columns.
- [ ] Destination-radius and pickup-proximity search (issue 7) uses `ST_DWithin` instead of a Python haversine loop.
- [ ] Query results are equivalent to the prior haversine behavior within expected precision.
- [ ] An index (e.g. GiST) supports the new spatial queries at expected listing volume.
- [ ] Tests cover PostGIS-based radius filtering matching the previously-tested haversine cases.

## Blocked by

- Issue 7. Search Opposite Listings

---

## 29. Implement Hybrid Real-Time Strategy

**Type:** AFK

## What to build

The WebSocket implementation (`ConnectionManager`, `/ws/{user_id}`) is explicitly disabled by the frontend whenever the API isn't on `localhost`, so real-time is dev-only in production. Decision recorded in `PRD.md` roadmap item 8 (2026-08-28): adopt a hybrid strategy — short-interval polling fallback everywhere outside `localhost`, with the door left open to a hosted realtime service (Ably/Pusher) later. Remove the dead-in-prod `localhost`-only WebSocket gate.

## Acceptance criteria

- [ ] Outside `localhost`, the frontend uses short-interval polling instead of silently doing nothing for chat messages, connection updates, and nearby-driver broadcasts.
- [ ] The `localhost`-only WebSocket gate is removed or replaced with an explicit environment-based strategy switch.
- [ ] Polling interval and endpoints are documented.
- [ ] No regression to the existing local-dev WebSocket behavior.
- [ ] Tests cover the polling fallback path receiving updates for at least chat messages and connection state changes.

## Blocked by

- Issue 10. Unlock Chat By Connection State
- Issue 27. Persist Driver Location Durably

---

## 30. Add Algorithmic Best-Matches Card Deck

**Type:** AFK

## What to build

Replace the flat marketplace feed with a ranked "Best Matches" card deck showing the top 2–3 matches, scored by departure-window overlap, pickup proximity, and shared-interest/tag overlap. Each card shows driver identity (avatar, display name, `profiles.photo_verified` badge — not a star rating, which stays out of scope), shared icebreaker tags, trip specs (pickup, destination, departure time + ETA, seats available), a primary "Instant Request Match" CTA, and a secondary "View Route Details" action. "Instant Request Match" creates a `pending` connection through the existing state machine (issue 8) — it does not auto-accept. See `PRD.md` roadmap item 9 for how this relates to the still-open manual-vs-auto-match decision (issue 22).

## Acceptance criteria

- [ ] Search results are scored and ranked by departure-window overlap, pickup proximity, and shared-interest/tag overlap, not just filtered.
- [ ] The home/search view shows the top 2–3 ranked matches as cards instead of (or ahead of) the flat list.
- [ ] Each card displays avatar, display name, verified badge (from `profiles.photo_verified`), shared tags, pickup/destination, departure time + ETA, and seats available.
- [ ] "Instant Request Match" creates a pending connection via the existing endpoint; "View Route Details" shows full listing details without creating a connection.
- [ ] Tests cover the ranking/scoring logic and both card actions.

## Blocked by

- Issue 7. Search Opposite Listings
- Issue 19. Add Passenger/Driver Mode Toggle
- Issue 21. Add Shared-Interest And Nationality Profile Fields

---

## 31. Auto-Fill And Simplify Listing Creation Forms

**Type:** AFK

## What to build

Pre-fill driver vehicle specs automatically from profile settings when creating a trip, and hide driver-only fields when posting a ride request (and rider-only fields when posting a trip) instead of showing one undifferentiated form. The gas-split estimator itself already exists (issue 11, $3.50/gal at 28 MPG) and needs no new work here.

## Acceptance criteria

- [ ] Creating a driver trip pre-fills vehicle make/model/color/seats/car type from the user's saved `vehicles` row when one exists.
- [ ] The ride-request form does not show driver-only fields (e.g. seats available, vehicle specs).
- [ ] The driver-trip form does not show rider-only fields (e.g. passenger count-only fields not relevant to drivers).
- [ ] Pre-filled fields remain editable before submission.
- [ ] Tests cover pre-fill from an existing vehicle, pre-fill absence when no vehicle exists, and field visibility for each listing type.

## Blocked by

- Issue 3. Edit Profile And Driver Readiness
- Issue 5. Publish Rider Ride Requests
- Issue 6. Publish Driver Trips

---

## 32. Add Block/Report UI Entry Points

**Type:** AFK

## What to build

Block/report enforcement exists in the backend (issue 14) but has no reachable UI. Add a `...` overflow menu to user profiles, inbox conversation cards, and chat headers that opens an action sheet allowing the user to report (with a reason code) or block instantly, consistent with `PRD.md` roadmap item 4.

## Acceptance criteria

- [ ] A `...` overflow menu is present on user profile views, inbox conversation cards, and chat headers.
- [ ] The menu opens an action sheet offering "Report" (with reason codes) and "Block."
- [ ] Reporting calls the existing report endpoint and confirms submission to the user.
- [ ] Blocking calls the existing block endpoint and immediately reflects the block in discovery/chat (no stale UI showing the blocked user as available).
- [ ] Tests cover opening the menu from each surface and both report and block actions succeeding.

## Blocked by

- Issue 14. Block And Report Users

---

## 33. Add Notification Deep Linking, Unread State, And Filters

**Type:** AFK

## What to build

Notifications are in-app/polled only with no deep linking, unread visual treatment, bulk actions, or category filtering. Add: deep links from each notification type to its record (connection-related → the Inbox record, chat message → the specific 1:1 or Pool thread, gas split confirmed → the split detail view); an unread visual state (accent pill/dot + darker card background, transitioning to white once read); a "Mark all as read" header action; a per-item dismiss (`✕` or swipe); and category pill filters (All / Connections / Chat / Payments).

## Acceptance criteria

- [ ] Clicking a connection-related notification navigates to the specific connection record in the Inbox.
- [ ] Clicking a chat-message notification opens the corresponding 1:1 or Pool chat thread.
- [ ] Clicking a gas-split-confirmed notification navigates to that trip's gas split detail view.
- [ ] Unread notifications show a distinct accent pill/dot and card background; read notifications show a plain white background.
- [ ] A "Mark all as read" header action marks every visible notification read.
- [ ] Each notification item can be dismissed individually without marking others read.
- [ ] Category pill filters (All / Connections / Chat / Payments) filter the visible notification list.
- [ ] Tests cover deep-link routing for each notification type, unread/read visual state, mark-all-as-read, per-item dismiss, and category filtering.

## Blocked by

- Issue 12. Send Marketplace Notifications

---

## 34. Confirm Then Apply Navy/Sky-Blue Design System Tokens

**Type:** HITL

## What to build

A 2026-08-28 spec proposes primary navy (`#0F172A` / `#1E3A8A`), accent sky blue/cyan (`#0284C7`), and white/soft-grey (`#F8FAFC`) backgrounds. This conflicts with the previously recorded conclusion (`PRD.md` external feedback item 7) that the existing royal-blue direction (`#2848c8` / `#5b7beb`) needed no change. This issue is a confirmation decision first, implementation second — do not apply the new tokens until confirmed, since it reverses a previously closed conclusion.

## Acceptance criteria

- [ ] A decision is recorded confirming whether to adopt the new navy/sky-blue hex values in place of the current royal-blue palette.
- [ ] `PRD.md`'s external feedback item 7 is updated to reflect the final decision (superseded or reaffirmed).
- [ ] If adopted: color tokens are updated across the design system (structural elements/headers/cards in navy, interactive states/primary CTAs/progress indicators in sky blue, backgrounds in white/`#F8FAFC`), and Framer Motion micro-interaction transitions are added for sign-up milestones and action feedback toasts (e.g. "Seat Reserved," "Report Submitted," "Driver Mode Activated").
- [ ] Tests/visual check confirm no contrast regressions on core cards and CTAs.

## Blocked by

None - can start immediately (decision step). Implementation is blocked by the decision.
