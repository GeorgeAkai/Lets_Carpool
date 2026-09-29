# Carpool Context

This document is the working product and architecture context for the Carpool app. It captures the MVP decisions from `AGENDA.md` so future planning, design, and implementation work can share the same vocabulary and constraints.

## Product Goal

Carpool helps riders and drivers find each other for shared rides to similar destinations. The MVP focuses on general user-facing marketplace behavior: authentication, profiles, ride/trip listings, search, connections, chat coordination, and gas split confirmation.

The MVP is not trying to solve full trust, payments, live safety tracking, AI matching, or specialized logistics workflows yet.

## MVP Scope

In scope:

- Users sign in, create a profile, and can act as both rider and driver.
- Each session, a user picks an explicit mode (rider or driver) that gates the Discover feed and its primary actions; switchable anytime from Profile.
- Riders publish ride requests.
- Drivers publish driver trips.
- Either side can browse relevant opposite-side listings, with manual filters for date, tag, seats, car type, and luggage size.
- Either side can initiate a connection manually.
- Users coordinate through a limited pending chat flow and full chat after acceptance, delivered in real time over WebSocket.
- Users can confirm a gas split in app, while payment happens outside the app.
- Drivers provide self-declared vehicle and driving eligibility information.
- Listings support lightweight tags: `airport`, `student`, `church`, `college`, `work`, `event`.
- Organizers can publish one-off group trips ("Pools") that riders join directly, alongside the primary request/trip/connection flow. See Group Trips (Pools).
- Once a connection is accepted, drivers can start live, GPS-based navigation to the rider's pickup point, with a routed map, dynamically-refreshing ETA/distance, and a live position shared with the rider. See Live Location & Navigation.
- Basic admin moderation tooling: suspend/unsuspend users, send warnings, review and action reports, remove listings, and an audit log. See Admin & Moderation.

Out of scope for MVP:

- Full ID, insurance, or driving record verification.
- In-app payments, card storage, refunds, or payment disputes.
- SOS or emergency workflows.
- Live tracking beyond the pickup leg of an already-accepted connection — no background tracking for the full ride, and no tracking outside an active "Start Driving" session.
- Ratings and reviews.
- AI/ML-based matching, dynamic pricing, or flight alerts. (Car type and luggage size are supported today only as self-declared fields and manual search filters, not automated matching.)
- Moving help. This is not a carpool use case for the MVP.
- Recurring carpools. Pools are one-off group trips (a single `trip_date`), not recurring series.

## Tech Stack

- Frontend: React Native with web support, likely via Expo / React Native Web, so iOS, Android, and web share one codebase.
- Backend API: Python with FastAPI.
- Database: PostgreSQL with PostGIS for geospatial storage and queries.
- Auth: OAuth-first with Google/Apple and optional email fallback.
- Maps/geocoding: Use a managed provider behind a replaceable integration.

Provider responses should not become the source of truth. Persist normalized app data: coordinates, display labels, provider identifier where useful, and timestamps.

## Core Domain Language

- `User`: authenticated account. A single user can ride or drive.
- `Profile`: user-facing identity details: display name, profile photo, short bio, verified email/domain.
- `Vehicle`: driver-owned vehicle details and self-declared eligibility information.
- `RideRequest`: a rider's request for a ride.
- `DriverTrip`: a driver's planned trip with available seats.
- `Connection`: an initiated relationship between one ride request and one driver trip.
- `ChatThread`: conversation attached to a connection.
- `Message`: chat content within a thread.
- `GasSplitConfirmation`: confirmed gas split amount and metadata.
- `Notification`: in-app or email notification for important marketplace events.
- `Pool`: an organizer-created, one-off group trip (community tag, date, departure time, pickup/destination, capacity) that riders join directly. See Group Trips (Pools).
- `PoolMembership` / `PoolMessage`: a joined user's membership in a pool, and chat content within a pool.
- `DriverLocation`: a driver's latest live lat/lng/heading/speed, used both for nearby-driver browsing and for live navigation to a pickup.
- `Report`: a user-filed report against another user, reviewed and actioned by an admin.

## Listing Model

The MVP is two-sided:

- Riders create `RideRequest` listings.
- Drivers create `DriverTrip` listings.

Both are first-class marketplace objects. This decision may be revisited later if the team decides to move toward suggestions-only matching, but the MVP should support symmetric manual discovery and initiation.

Listings are one-off ride occurrences only. Do not model recurring rides in the MVP.

Alongside this two-sided model, `Pool` is a separate, simpler group-trip listing: an organizer publishes it directly (no opposite-side match needed), and riders join or leave up to `max_participants` without an accept/decline handshake. Pools do not go through `Connection`. See Group Trips (Pools).

## Time Model

Listings use date plus flexibility instead of rigid departure datetimes.

Examples:

- "Friday, flexible"
- "ASAP today"
- "Saturday morning"

Fine-grained coordination happens through chat after interest is initiated. The listing should carry enough structured date/flexibility data for search and expiry, but not require exact minute-level scheduling.

## Location Model

Pickup and dropoff locations use geocoded exact addresses or place search results.

Store:

- latitude and longitude as the geospatial source of truth
- display label for user-facing UI
- optional structured address/place metadata

Use PostGIS for radial queries and distance calculations.

Before a connection is accepted, show approximate area/place labels rather than exposing unnecessarily precise location details. Reveal exact agreed pickup/dropoff details after acceptance.

## Live Location & Navigation

Drivers can opt in to sharing a live GPS position (`DriverLocation`: lat/lng/heading/speed), used in two ways:

- **Nearby-driver browsing**: riders in browse mode see nearby sharing drivers as animated markers on the map, polled periodically.
- **"Start Driving" pickup navigation**: once a connection is `accepted`, the driver can start navigation to the rider's (now-revealed) pickup point. The map draws a routed line to the pickup, and the ETA/distance panel refreshes as the driver moves — enough movement or elapsed time triggers a fresh route, not every GPS tick. The driver ends this by marking arrival.

This is scoped to the pickup leg of one accepted connection, not a standing background service or full-ride tracking, and it is distinct from SOS/emergency journey sharing, which remains out of scope.

## Matching and Search

MVP search is based on tight endpoint matching:

- Destinations must be within a small radius, such as 500 m to 1 km.
- Pickup proximity is evaluated separately.
- Authenticated users search the opposite listing type.
- Search filters can include destination radius, date/flexibility, tag, pickup proximity, car type, and luggage size. These are exact-match filters over self-declared fields, not ML-based matching.

Do not implement route-corridor or "on the way" matching in MVP. That can be added later with route buffers and more advanced PostGIS logic.

## Connection Flow

Connections are symmetric and manual:

- A rider can request to join a driver trip.
- A driver can offer a ride on a rider request.
- The other party accepts or declines.

Connection states:

- `pending`
- `expired`
- `accepted`
- `declined`
- `cancelled`
- `completed`

Pending connections should expire if nobody responds before the relevant ride date.

Gas split confirmation is separate from connection state. Do not add payment or split states directly into the connection state machine.

## Chat Rules

Chat is hybrid:

- While a connection is `pending`, allow canned or quick messages only.
- After a connection is `accepted`, unlock full chat.

The reason is product safety: users need enough communication to coordinate flexible timing before accepting, but unrestricted pre-accept chat increases spam and harassment risk.

## Listing Lifecycle

Listing states:

- `open`
- `expired`
- `matched`
- `cancelled`
- `completed`

Use automatic expiry after the target date/flexibility window has passed. Avoid `draft` and `paused` in MVP unless a later product decision explicitly adds them.

## Seats and Passenger Count

Driver trips declare seats available.

Ride requests declare passenger count.

Accepted connections reserve seats and must prevent overbooking. If one driver trip accepts multiple ride requests, available seats must decrement consistently.

## Gas Split

The product should use "confirm split" language, not "sign agreement."

The app should:

- show a suggested gas split
- allow editable cost assumptions or manual override
- store amount, confirmer, and timestamp
- support both parties confirming the split

Payment happens outside the app in MVP. Do not store credit cards or process payments.

No live gas-price API is required for MVP. A simple distance-based estimate with editable assumptions is enough.

## Identity and Trust

Authentication is OAuth-first. The backend verifies provider tokens, creates or fetches users, and issues the app's own session/JWT.

Store verified email domain from OAuth for future identity grouping, such as `.edu` or organization trust groups. Do not build special matching, badges, or trust grouping in MVP.

Driver verification is self-declared in MVP. Drivers can confirm that they have a license, insurance, and a good driving record, but the app does not collect or review documents yet.

Basic MVP safety controls:

- authenticated-only marketplace
- block controls
- report controls, reviewed by admins (see Admin & Moderation)

ID verification, SOS, and journey sharing remain post-MVP. Basic admin-side moderation (suspend, warn, report review) is implemented; see Admin & Moderation.

## Admin & Moderation

Admins get a separate panel for marketplace health and safety, backed by an append-only audit log of admin actions:

- View stats, popular destinations, and currently-active routes/listings.
- Search/list users; suspend or unsuspend a user, or send them a warning notification.
- Review reports filed by users: dismiss, or action (which suspends the reported user).
- Remove an individual ride request or driver trip directly.

This is staff tooling, not user-facing trust/badge features, and does not replace the self-declared driver eligibility model.

## Notifications

Use in-app and email notifications for:

- offer/request received
- offer/request accepted
- offer/request declined
- connection cancelled
- chat unlocked
- relevant chat messages
- gas split confirmation
- admin warning

In-app chat messages and notifications are delivered in real time over a WebSocket connection (in addition to being persisted for later fetch); email delivery and mobile push remain to be added.

## Completion

After the ride date, accepted connections can be marked completed.

Record who confirmed completion. Do not implement disputes, refunds, or payment enforcement in MVP.

Keep completion data so ratings and reviews can be added later without remodelling rides.

## Tags and Verticals

Support lightweight listing tags within the same core flow:

- `airport`
- `student`
- `church`
- `college`
- `work`
- `event`

Do not create separate vertical-specific flows in MVP. Do not include moving help.

## Group Trips (Pools)

A `Pool` is an organizer-published, one-off group trip, separate from the `RideRequest`/`DriverTrip`/`Connection` flow above:

- An organizer sets a name, `community_tag` (e.g. `event`), trip date, departure time, pickup/destination locations, `max_participants`, and `seats_per_vehicle`.
- Other users join or leave directly (`PoolMembership`), up to capacity — there is no per-member accept/decline handshake the way `Connection` has.
- A pool has its own group chat (`PoolMessage`), separate from the pending/accepted-gated `ChatThread` model used for connections.
- Pool status: `open`, `full`, `cancelled`, `completed`. It fills automatically once membership hits `max_participants`, and reopens if a member leaves a full pool.

Use this model for organized/community group trips (e.g. an event or campus group going to the same place); use the `RideRequest`/`DriverTrip`/`Connection` flow for one-to-one rider/driver matching.

## Key Invariants

- A user can be both rider and driver, but picks one mode per session for the Discover feed.
- A listing represents exactly one planned ride occurrence.
- Exact geocoded points are stored, but precise locations should be revealed carefully.
- Search uses endpoint radius matching first, not route-corridor matching.
- A connection links one ride request and one driver trip.
- Accepted connections reserve driver seats.
- Live position tracking is scoped to the pickup leg of one accepted connection (the driver's "Start Driving" session), not a standing background service or full-ride tracking.
- A `Pool` is joined directly (no accept/decline) and is not modeled as a `Connection`.
- Gas split confirmation is not payment.
- "Confirm split" is the product term; avoid "sign agreement."
- Security/trust features should not be quietly pulled into MVP unless explicitly reprioritized — the admin/moderation tooling that exists today (suspend, warn, report review, audit log) was an explicit, scoped exception, not a precedent for e.g. ID verification or SOS.

## Revisit Candidates

These decisions are likely to change after team feedback or user testing:

- Whether symmetric manual connection remains the default, or whether suggestions-only matching becomes primary.
- Whether route-corridor matching is needed soon after MVP.
- How much location precision is safe before acceptance (resolved for the pickup leg via live "Start Driving" tracking; still open for whether tracking should extend to the full ride).
- How much further safety and moderation is required before launch, beyond the admin suspend/warn/report tooling that already exists.
- Whether any of the six tags (`airport`, `student`, `church`, `college`, `work`, `event`) deserve a dedicated flow, or whether Pools cover that need instead.
- Whether Pools and the request/trip/connection flow should eventually be unified, or remain two distinct models.
