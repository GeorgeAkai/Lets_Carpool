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
