# Carpool Context

This document is the working product and architecture context for the Carpool app. It captures the MVP decisions from `AGENDA.md` so future planning, design, and implementation work can share the same vocabulary and constraints.

## Product Goal

Carpool helps riders and drivers find each other for shared rides to similar destinations. The MVP focuses on general user-facing marketplace behavior: authentication, profiles, ride/trip listings, search, connections, chat coordination, and gas split confirmation.

The MVP is not trying to solve full trust, payments, live safety tracking, AI matching, or specialized logistics workflows yet.

## MVP Scope

In scope:

- Users sign in, create a profile, and can act as both rider and driver.
- Riders publish ride requests.
- Drivers publish driver trips.
- Either side can browse relevant opposite-side listings.
- Either side can initiate a connection manually.
- Users coordinate through a limited pending chat flow and full chat after acceptance.
- Users can confirm a gas split in app, while payment happens outside the app.
- Drivers provide self-declared vehicle and driving eligibility information.
- Listings support lightweight tags such as `airport` and `student`.

Out of scope for MVP:

- Full ID, insurance, or driving record verification.
- In-app payments, card storage, refunds, or payment disputes.
- Live journey tracking, SOS, or emergency workflows.
- Ratings and reviews.
- AI matching, dynamic pricing, flight alerts, or luggage/vehicle-size ML.
- Moving help. This is not a carpool use case for the MVP.
- Recurring carpools.

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

## Listing Model

The MVP is two-sided:

- Riders create `RideRequest` listings.
- Drivers create `DriverTrip` listings.

Both are first-class marketplace objects. This decision may be revisited later if the team decides to move toward suggestions-only matching, but the MVP should support symmetric manual discovery and initiation.

Listings are one-off ride occurrences only. Do not model recurring rides in the MVP.

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

## Matching and Search

MVP search is based on tight endpoint matching:

- Destinations must be within a small radius, such as 500 m to 1 km.
- Pickup proximity is evaluated separately.
- Authenticated users search the opposite listing type.
- Search filters can include destination radius, date/flexibility, tag, and pickup proximity.

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
- report controls

Moderation workflows, ID verification, SOS, and journey sharing remain post-MVP.

## Notifications

Use in-app and email notifications for:

- offer/request received
- offer/request accepted
- offer/request declined
- connection cancelled
- chat unlocked
- relevant chat messages
- gas split confirmation

Push notifications can be added later.

## Completion

After the ride date, accepted connections can be marked completed.

Record who confirmed completion. Do not implement disputes, refunds, or payment enforcement in MVP.

Keep completion data so ratings and reviews can be added later without remodelling rides.

## Tags and Verticals

Support lightweight listing tags within the same core flow:

- `airport`
- `student`

Do not create separate vertical-specific flows in MVP. Do not include moving help.

## Key Invariants

- A user can be both rider and driver.
- A listing represents exactly one planned ride occurrence.
- Exact geocoded points are stored, but precise locations should be revealed carefully.
- Search uses endpoint radius matching first, not route-corridor matching.
- A connection links one ride request and one driver trip.
- Accepted connections reserve driver seats.
- Gas split confirmation is not payment.
- "Confirm split" is the product term; avoid "sign agreement."
- Security/trust features should not be quietly pulled into MVP unless explicitly reprioritized.

## Revisit Candidates

These decisions are likely to change after team feedback or user testing:

- Whether symmetric manual connection remains the default, or whether suggestions-only matching becomes primary.
- Whether route-corridor matching is needed soon after MVP.
- How much location precision is safe before acceptance.
- How much safety and moderation is required before launch.
- Whether airport and student tags deserve dedicated flows.
