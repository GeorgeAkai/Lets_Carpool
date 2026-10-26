# Carpool Context

This document is the working product and architecture context for the Carpool app. It captures the MVP decisions from `AGENDA.md` so future planning, design, and implementation work can share the same vocabulary and constraints.

## Product Goal

Carpool helps passengers and drivers find each other for shared rides to similar destinations. The MVP focuses on general user-facing marketplace behavior: authentication, profiles, ride/trip listings, search, connections, chat coordination, and gas split confirmation.

The MVP is not trying to solve full trust, payments, live safety tracking, AI matching, or specialized logistics workflows yet.

## MVP Scope

In scope:

- Users sign in, create a profile, and can act as both passenger and driver.
- Each session, a user picks an explicit mode (passenger or driver) that gates the Discover feed and its primary actions; switchable anytime from the Find a ride / Offer a ride toggle on Home or from Profile.
- Passengers publish ride requests.
- Drivers publish driver trips.
- Either side can browse relevant opposite-side listings, with manual filters for date, tag, seats, car type, and luggage size.
- Either side can initiate a connection manually. Passengers with an open request (and drivers with an open trip) are also shown a system-proposed best match they can request/offer or skip. See Proposed Matches.
- Users coordinate through a limited pending chat flow and full chat after acceptance, delivered in real time over WebSocket.
- Users can confirm a gas split in app, while payment happens outside the app.
- Drivers provide self-declared vehicle and driving eligibility information.
- Listings support lightweight tags: `airport`, `student`, `church`, `college`, `work`, `event`.
- Organizers can publish one-off group trips ("Pools") that passengers join directly, alongside the primary request/trip/connection flow. See Group Trips (Pools).
- Once a connection is accepted, drivers can start live, GPS-based navigation to the passenger's pickup point, with a routed map, dynamically-refreshing ETA/distance, and a live position shared with the passenger. See Live Location & Navigation.
- Basic admin moderation tooling: suspend/unsuspend users, send warnings, review and action reports, remove listings, and an audit log. See Admin & Moderation.

Out of scope for MVP:

- Full ID, insurance, or driving record verification.
- Real card processing, card storage, refunds, or payment disputes. (The automatic fare is marked paid in-app when a ride completes; no money moves yet. See Fare & Payment Confirmation.)
- SOS or emergency workflows.
- Background tracking outside an active "Start Driving" session. Live position sharing covers the pickup leg and, once the driver confirms the passenger is on board, the leg to the drop-off — only while the driver is navigating.
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
- `RideRequest`: a passenger's request for a ride.
- `DriverTrip`: a driver's planned trip with available seats.
- `Connection`: an initiated relationship between one ride request and one driver trip.
- `ChatThread`: conversation attached to a connection.
- `Message`: chat content within a thread.
- `GasSplitConfirmation`: confirmed gas split amount and metadata.
- `Notification`: in-app or email notification for important marketplace events.
- `Pool`: an organizer-created, one-off group trip (community tag, date, departure time, pickup/destination, capacity) that passengers join directly. See Group Trips (Pools).
- `PoolMembership` / `PoolMessage`: a joined user's membership in a pool, and chat content within a pool.
- `DriverLocation`: a driver's latest live lat/lng/heading/speed, used both for nearby-driver browsing and for live navigation to a pickup.
- `Report`: a user-filed report against another user, reviewed and actioned by an admin.

## Listing Model

The MVP is two-sided:

- Passengers create `RideRequest` listings.
- Drivers create `DriverTrip` listings.

Both are first-class marketplace objects. This decision may be revisited later if the team decides to move toward suggestions-only matching, but the MVP should support symmetric manual discovery and initiation.

Listings are one-off ride occurrences only. Do not model recurring rides in the MVP.

Alongside this two-sided model, `Pool` is a separate, simpler group-trip listing: an organizer publishes it directly (no opposite-side match needed), and passengers join or leave up to `max_participants` without an accept/decline handshake. Pools do not go through `Connection`. See Group Trips (Pools).

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

- **Nearby-driver browsing**: passengers in browse mode see nearby sharing drivers as animated markers on the map, polled periodically.
- **"Start Driving" pickup navigation**: once a connection is `accepted`, the driver can start navigation to the passenger's (now-revealed) pickup point. The map draws a routed line to the pickup, and the ETA/distance panel refreshes as the driver moves — enough movement or elapsed time triggers a fresh route, not every GPS tick. The driver ends this by marking arrival.

This is scoped to the pickup leg of one accepted connection, not a standing background service or full-ride tracking, and it is distinct from SOS/emergency journey sharing, which remains out of scope.

## Fare & Payment Confirmation

The passenger never types a gas amount. The fare is calculated automatically from the passenger's pickup → destination distance (gas cost per passenger × party size) and shown as `fare` on every connection: `estimated` until the ride completes, then `paid`. Completing a ride records the fare (a `GasSplitConfirmation` with `method: auto_fare`) and notifies both sides ("Payment processed" / "Payment received"). This is a confirmation, not a processor — no card is charged.

After completion both people are prompted to rate each other (1–5 stars); the ride moves to past trips in My Rides.

## Trip Lifecycle on the Day

`accepted` → passenger checks in at pickup (optional) → driver taps "in the car" (`picked_up_at`, the ride is en route; the destination route shows for both) → driver marks complete. The passenger's trip-day screen shows a live "car approaching" Google Map, then the route to the destination.

## Matching and Search

MVP search is based on tight endpoint matching:

- Destinations must be within a small radius, such as 500 m to 1 km.
- Pickup proximity is evaluated separately.
- Authenticated users search the opposite listing type.
- Search filters can include destination radius, date/flexibility, tag, pickup proximity, car type, and luggage size. These are exact-match filters over self-declared fields, not ML-based matching.

Driver trips store their OSRM route, and passenger searches that carry both a pickup and destination match on a direction-aware 1000 m route corridor, returning `detour_minutes` (see `docs/adr/0001-proposed-matches-on-route-corridor.md`). Trips without a stored route fall back to the endpoint-radius filters above.

## Connection Flow

Connections are symmetric and initiated by a person (a proposal is only a suggestion; accepting it creates a normal connection):

- A passenger can request to join a driver trip.
- A driver can offer a ride on a passenger request.
- The other party accepts or declines.

Connection states:

- `pending`
- `expired`
- `accepted`
- `declined`
- `cancelled`
- `completed`

Pending connections should expire if nobody responds before the relevant ride date.

## Proposed Matches

- A passenger with an open `RideRequest` is shown one **proposed match**: the best open `DriverTrip` on their route corridor, ranked by detour, then date/flexibility. Trips with too few free seats, more than a day off, already skipped, or already connected to that request are never proposed.
- The passenger **requests** it (a normal `pending` `Connection` the driver accepts/declines) or **skips** it (recorded per request in `match_skips`; the next-best is proposed).
- Drivers get the mirror image for an open `DriverTrip`: the best open `RideRequest` along their route (both points in the corridor, destination ahead of pickup, enough seats for the passenger count). They **offer a ride** (a driver-initiated `pending` `Connection`) or **skip** it (`driver_match_skips`). Passenger and driver skips are independent.
- There is no `proposed` connection state.

Gas split confirmation is separate from connection state. Do not add payment or split states directly into the connection state machine.

## Chat Rules

Chat is hybrid:

- While a connection is `pending`, allow canned or quick messages only.
- After a connection is `accepted`, unlock full chat.

The reason is product safety: users need enough communication to coordinate flexible timing before accepting, but unrestricted pre-accept chat increases spam and harassment risk.

## Listing Lifecycle

Listing states:

- `open`
- `paused` (driver trips only)
- `expired`
- `matched`
- `cancelled`
- `completed`

Use automatic expiry after the target date/flexibility window has passed. `draft` is not used. Driver trips can be `paused` (hidden from search and proposals, existing bookings kept; resumable), edited (date, flexibility, seats, note — not the route) or cancelled from Discover and My Rides.

## Seats and Passenger Count

Driver trips declare seats available.

Ride requests declare passenger count.

Accepted connections reserve seats and must prevent overbooking. If one driver trip accepts multiple ride requests, available seats must decrement consistently.

## Gas Split

(Superseded for the passenger flow by Fare & Payment Confirmation; the suggestion endpoint is still the fare calculator.)

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

## Preferences, Receipts and Safety

- **Ride preferences** (per user): max walk to pickup (narrows the pickup radius and route corridor at 80 m/min), ride vibes (`quiet`, `music_ok`, `chatty`, `pets_ok`, `room_for_bags`, `no_smoking`), verified drivers only, women-only rides, coworkers first, and route check-ins. Preferences apply to driver-trip search by default; `apply_preferences=false` turns them off for one search. Vibes only rank results, never filter them out.
- A driver's vibes are copied onto each trip they post. **Coworkers** share a non-public email domain (two Gmail users are not coworkers). **Ride buddies** are people a user chose to "ride with again"; they can only be added after a completed ride together.
- **Women-only rides** rely on an optional, self-declared `gender` on the profile. It is never shown to other users, and only a user who declared `woman` can turn the preference on. The filter keeps trips whose driver, and every rider already accepted, declared `woman`.
- **Saved places**: one Home, one Work, and a few named extras.
- **Settling up** stays outside the app. A user records how they like to be paid back (`cash`, `venmo`, `zelle`, `paypal`, `cash_app`, `other` plus an optional handle). Partners see it once a ride is accepted. No card or bank data is stored.
- **Ride PIN**: accepting a connection generates a 4-digit PIN that only the rider sees. The driver confirms it before pickup.
- **Trip receipt**: an immutable snapshot of the cost split, written when a connection completes and numbered `CP-00001`. Both participants can read it. **Impact** (shared trips, gas saved, regular buddies) is derived from receipts.
- **Emergency contacts** (up to 5) have a share mode of `every_trip`, `night_only` or `off`. Trip reports carry the connection and a category (`safety`, `driving`, `no_show`, `payment`, `conduct`, `other`).

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

Use this model for organized/community group trips (e.g. an event or campus group going to the same place); use the `RideRequest`/`DriverTrip`/`Connection` flow for one-to-one passenger/driver matching.

## Key Invariants

- A user can be both passenger and driver, but picks one mode per session for the Discover feed.
- A listing represents exactly one planned ride occurrence.
- Exact geocoded points are stored, but precise locations should be revealed carefully.
- Search uses endpoint radius matching first, not route-corridor matching.
- A connection links one ride request and one driver trip.
- Accepted connections reserve driver seats.
- Live position tracking is scoped to the pickup leg of one accepted connection (the driver's "Start Driving" session), not a standing background service or full-ride tracking.
- A `Pool` is joined directly (no accept/decline) and is not modeled as a `Connection`.
- The fare is calculated by the app; passengers do not enter or negotiate an amount. Paid status is in-app only until a payment processor exists.
- Security/trust features should not be quietly pulled into MVP unless explicitly reprioritized — the admin/moderation tooling that exists today (suspend, warn, report review, audit log) was an explicit, scoped exception, not a precedent for e.g. ID verification or SOS.

## Revisit Candidates

These decisions are likely to change after team feedback or user testing:

- Whether symmetric manual connection remains the default, or whether suggestions-only matching becomes primary.
- Whether route-corridor matching is needed soon after MVP.
- How much location precision is safe before acceptance (resolved for the pickup leg via live "Start Driving" tracking; still open for whether tracking should extend to the full ride).
- How much further safety and moderation is required before launch, beyond the admin suspend/warn/report tooling that already exists.
- Whether any of the six tags (`airport`, `student`, `church`, `college`, `work`, `event`) deserve a dedicated flow, or whether Pools cover that need instead.
- Whether Pools and the request/trip/connection flow should eventually be unified, or remain two distinct models.
