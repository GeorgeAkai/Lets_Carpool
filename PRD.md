# Carpool MVP PRD

## Problem Statement

People who need rides and people who are already driving to similar destinations lack a simple, trusted way to find each other, coordinate details, and agree on a fair gas split without turning the product into a full rideshare, payment, or safety platform too early.

Riders need to publish where they want to go, find drivers going to similar destinations, and coordinate a practical pickup. Drivers need to publish planned trips, discover relevant rider requests, manage available seats, and decide who to connect with. Both sides need enough structure to feel organized, but enough flexibility to coordinate real-world timing through chat.

The MVP should prove the core marketplace loop: sign in, create profile, publish listing, search, connect, coordinate, confirm gas split, and complete the ride.

## Solution

Build a two-sided carpool marketplace for mobile and web using React Native, FastAPI, PostgreSQL, and PostGIS.

The MVP supports two first-class listing types:

- Riders publish `RideRequest` listings.
- Drivers publish `DriverTrip` listings.

Users can act as both rider and driver from the same account. Matching is manual and symmetric: a rider can request to join a driver trip, or a driver can offer a ride on a rider request. Search uses tight destination-radius matching, pickup proximity, date/flexibility, and lightweight tags such as `airport` and `student`.

The product should keep the first version intentionally focused. It should not include full payments, real-time journey tracking, AI matching, full identity verification, ratings, or moving help.

## User Stories

1. As a new user, I want to sign in with Google or Apple, so that I can access the marketplace without creating a separate password.
2. As a new user, I want the app to create my profile from my verified identity, so that I can start using the product quickly.
3. As a user, I want to edit my display name, profile photo, and short bio, so that other people can understand who they are connecting with.
4. As a user, I want one account to support both riding and driving, so that I can drive on some days and ride on others.
5. As a user, I want my verified email domain stored, so that future student or organization trust features can be added without changing my account later.
6. As a driver, I want to add basic vehicle details, so that riders can understand the car they may be joining.
7. As a driver, I want to self-declare that I have a license, insurance, and a good driving record, so that riders get basic confidence without requiring document upload in MVP.
8. As a rider, I want to create a ride request, so that drivers can find me and offer a ride.
9. As a rider, I want to enter pickup and destination places through geocoded search, so that my request can be found with location-based matching.
10. As a rider, I want to set a target date and flexible timing, so that I do not need to know the exact departure minute before finding a driver.
11. As a rider, I want to declare passenger count, so that drivers know how many seats I need.
12. As a rider, I want to tag a request as `airport` or `student`, so that relevant drivers can filter or understand the use case.
13. As a rider, I want my request to expire after its relevant date passes, so that stale requests do not clutter search.
14. As a rider, I want to cancel my ride request, so that I can remove it if my plans change.
15. As a driver, I want to create a driver trip, so that riders going to a similar destination can find me.
16. As a driver, I want to enter trip pickup and destination places through geocoded search, so that my trip can be matched spatially.
17. As a driver, I want to set a target date and flexible timing, so that I can coordinate final details with interested riders.
18. As a driver, I want to declare seats available, so that the app can prevent overbooking.
19. As a driver, I want to tag my trip as `airport` or `student`, so that relevant riders can find it.
20. As a driver, I want my trip to expire after its relevant date passes, so that stale trips do not remain discoverable.
21. As a driver, I want to cancel my trip, so that riders are not matched with an unavailable ride.
22. As a rider, I want to search driver trips by destination radius, date/flexibility, tag, and pickup proximity, so that I can find practical rides.
23. As a driver, I want to search rider requests by destination radius, date/flexibility, tag, and pickup proximity, so that I can find riders I might be able to help.
24. As a user, I want approximate location information before acceptance, so that I can evaluate fit without exposing exact private locations too early.
25. As a user, I want exact agreed pickup and dropoff details after acceptance, so that I can complete the ride safely and practically.
26. As a rider, I want to request to join a driver trip, so that I can start the connection process.
27. As a driver, I want to offer a ride on a rider request, so that I can start the connection process.
28. As a connection recipient, I want to accept or decline pending interest, so that I stay in control of who I ride with.
29. As a user, I want pending connections to expire when the ride date passes, so that old offers and requests do not linger.
30. As a user, I want accepted connections to reserve seats, so that a driver cannot overbook a trip.
31. As a user, I want limited canned messages while a connection is pending, so that I can clarify timing without opening unrestricted pre-accept chat.
32. As a user, I want full chat after acceptance, so that we can coordinate pickup details and final timing.
33. As a user, I want to receive in-app and email notifications about offers, requests, acceptances, declines, cancellations, chat unlocks, messages, and gas split confirmations, so that I do not miss important activity.
34. As a rider, I want to see a suggested gas split, so that I understand a fair contribution before confirming the ride.
35. As a driver, I want to show or edit the suggested gas split, so that the final amount reflects the ride details.
36. As a user, I want to confirm the gas split in app, so that both parties have a shared record of the agreed amount.
37. As a user, I want the product to say "confirm split" instead of "sign agreement," so that the app does not imply legal contract behavior.
38. As a user, I want to pay outside the app for MVP, so that I can complete the ride without the product handling cards or payments.
39. As a user, I want to mark an accepted connection completed after the ride date, so that the app records the ride outcome.
40. As a user, I want the app to record who confirmed completion, so that future ratings or history features can build on this data.
41. As a user, I want to report another user, so that unsafe or inappropriate behavior can be flagged.
42. As a user, I want to block another user, so that I can avoid future interaction with them.
43. As a product team member, I want search and geocoding data normalized in our database, so that the app is not tightly coupled to a single map provider.
44. As a product team member, I want the MVP to avoid route-corridor matching, so that we can ship endpoint-radius matching first.
45. As a product team member, I want the MVP to avoid live tracking and SOS, so that safety features can be designed intentionally in a later phase.
46. As a product team member, I want completion data stored even before ratings exist, so that ratings can be added later without remodelling rides.

## Implementation Decisions

- Build the app as a greenfield product with a shared mobile and web frontend using React Native with web support.
- Use FastAPI for the backend API.
- Use PostgreSQL with PostGIS for geospatial storage and radial queries.
- Use OAuth-first authentication with Google/Apple and optional email fallback.
- The backend verifies OAuth provider tokens, creates or fetches users, stores verified email/domain, and issues the app's own session or JWT.
- One authenticated `User` can act as both rider and driver.
- `Profile` stores display name, profile photo, short bio, verified email, and verified email domain.
- `Vehicle` stores driver-owned vehicle details and self-declared license, insurance, and driving-record eligibility.
- `RideRequest` and `DriverTrip` are separate first-class listing types.
- Listings represent one ride occurrence only. Recurring carpools are not supported in MVP.
- Listings use date plus flexibility instead of exact departure datetime.
- Listing states are `open`, `expired`, `matched`, `cancelled`, and `completed`.
- Connections link one `RideRequest` and one `DriverTrip`.
- Connections are symmetric and manual: riders can request to join trips, and drivers can offer rides on requests.
- Connection states are `pending`, `expired`, `accepted`, `declined`, `cancelled`, and `completed`.
- Pending connections expire if no response occurs before the relevant ride date.
- Accepted connections reserve seats and must prevent overbooking.
- Gas split confirmation is separate from connection state.
- `ChatThread` is attached to a connection.
- Pending connections allow only canned or quick messages.
- Accepted connections unlock full chat.
- `GasSplitConfirmation` records amount, confirmer, timestamp, and relevant cost assumptions or overrides.
- Product copy must use "confirm split," not "sign agreement."
- Payments happen outside the app. Do not store cards or process payments.
- Location input uses geocoded exact addresses or place search results.
- Persist latitude, longitude, display label, optional structured address/place metadata, provider identifier where useful, and timestamps.
- Provider response blobs are not the source of truth.
- Before acceptance, expose approximate area or place labels rather than exact private location details.
- After acceptance, reveal exact agreed pickup and dropoff details.
- Search uses endpoint destination radius, pickup proximity, target date/flexibility, and tags.
- Route-corridor or "on the way" matching is deferred.
- Tags are lightweight metadata inside the same core flow. MVP tags are `airport` and `student`.
- Moving help is removed from scope.
- Notifications support in-app and email delivery in MVP. Push notifications can follow later.
- Basic safety controls include authenticated-only access, blocking, and reporting.
- Ratings and reviews are deferred, but completion data should support adding them later.

Recommended deep modules:

- Auth and identity module: provider token verification, session issuing, user/profile creation, verified email-domain capture.
- Geocoding and location module: provider abstraction, normalized location persistence, privacy-aware presentation.
- Listing module: creation, update, expiry, cancellation, lifecycle transitions, tag handling.
- Matching/search module: destination-radius matching, pickup proximity, filters, ordering.
- Connection module: symmetric initiation, state transitions, expiry, seat reservation, overbooking prevention.
- Chat module: pending canned-message constraints, accepted full-chat behavior, thread/message lifecycle.
- Gas split module: suggested calculation, override handling, confirmation records.
- Notification module: event-driven in-app/email notifications.
- Safety module: block/report behavior and enforcement in search/chat surfaces.

## Testing Decisions

Tests should validate externally visible behavior and domain invariants, not implementation details. The most important tests are around state transitions, geospatial filtering, seat reservation, and privacy boundaries.

Backend tests should cover:

- OAuth callback/token verification behavior using mocked providers.
- User/profile creation and verified email-domain capture.
- Ride request and driver trip creation.
- Listing expiry after target date/flexibility has passed.
- Listing cancellation and completed transitions.
- Destination-radius search with PostGIS-backed points.
- Pickup proximity filtering.
- Tag filtering.
- Connection initiation from rider to driver and driver to rider.
- Connection state transitions: pending, expired, accepted, declined, cancelled, completed.
- Seat reservation on accepted connections.
- Overbooking prevention.
- Pending connection expiry.
- Chat permission rules for pending vs accepted connections.
- Gas split suggestion and confirmation behavior.
- Location privacy rules before and after acceptance.
- Block/report effects where they affect discovery or interaction.
- Notification event creation for connection, chat, and split-confirmation events.

Frontend tests should cover:

- OAuth-first sign-in flows with mocked auth responses.
- Profile creation and editing.
- Rider request creation.
- Driver trip creation.
- Search filter behavior.
- Connection request/offer UI.
- Accept/decline/cancel flows.
- Pending canned-message UI.
- Full chat unlock after acceptance.
- Gas split confirmation UI using "confirm split" language.
- Approximate location display before acceptance and exact details after acceptance.

End-to-end tests should cover:

- Rider creates a request, driver finds it, driver offers, rider accepts, chat unlocks, split is confirmed, ride is completed.
- Driver creates a trip, rider finds it, rider requests to join, driver accepts, seats are reserved, split is confirmed, ride is completed.
- A driver trip with limited seats cannot accept connections beyond capacity.
- A stale listing or pending connection expires and disappears from active discovery.

There is no prior test suite in the current greenfield repo. Establish backend domain tests first because the marketplace invariants are more important than screen-level behavior at the start.

## Out of Scope

- Full ID verification.
- Document upload or review for license, insurance, or driving record.
- In-app payments.
- Credit card storage.
- Refunds or payment disputes.
- Real-time driver or rider tracking.
- Journey sharing.
- SOS or emergency services integration.
- Ratings and reviews.
- AI matching.
- Dynamic pricing beyond simple editable gas split estimates.
- Flight data integration.
- Luggage or vehicle-size ML.
- Route-corridor matching.
- Recurring carpools.
- Push notifications.
- Dedicated airport or student flows.
- Moving help.

## Further Notes

This PRD is based on the decisions in `CONTEXT.md`.

The largest team-review risks are:

- Whether symmetric manual connection should remain primary, or whether suggestions-only matching should eventually replace it.
- Whether endpoint-radius matching is sufficient for early users, or whether route-corridor matching becomes necessary quickly.
- Whether approximate pre-accept location display provides enough privacy without hurting match quality.
- Whether self-declared driver verification is acceptable for launch, given the safety expectations around carpooling.
- Whether in-app/email notifications are enough without push notifications for mobile behavior.

The MVP should protect its boundary aggressively. Adding payments, live tracking, ID verification, ratings, or AI matching too early will change the product from a focused marketplace validation into a trust/safety/payment platform before the core matching loop is proven.
