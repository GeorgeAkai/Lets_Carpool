# Carpool — Design agenda (team discussion)

Living document from product/design grill sessions. Use this in team meetings to align, challenge, or revise decisions before they land in `CONTEXT.md`.

**Scope for MVP:** General user-facing features (auth, listings, connect, gas split basics). Security/trust and AI features are out of scope unless noted.

**Tech stack (agreed):** React Native (mobile + web), FastAPI, PostgreSQL + PostGIS.

---

## Resolved (current session)

| # | Topic | Decision | Notes |
|---|--------|----------|--------|
| 1 | Primary listing model | **Two-sided** | Riders publish **ride requests**; drivers publish **trips**. Both are first-class in MVP. |
| 2 | Departure time | **Date + flexibility** | e.g. “Friday, flexible”, “ASAP today”. Finer scheduling via **in-app chat**, not rigid datetime in the listing. |
| 3 | How connections are created | **A — Symmetric, manual** | Rider can request to join a driver trip *or* driver can offer on a rider request; other party accepts/declines. **May revisit** after team discussion (suggestions-only, one-way browse, etc.). |
| 4 | When is chat available? | **C — Hybrid** | Canned/quick messages while connection is **pending**; full chat after **accept**. |
| 5 | One account, two roles? | **A — Single account** | Same user can post ride requests or trips (e.g. driver may prefer to ride instead of driving their own car). |
| 6 | “Same destination” matching | **A — Tight endpoint match** | Destinations must be within a small radius (e.g. 500 m–1 km); pickup proximity is evaluated separately. Corridor matching can follow later. |
| 7 | Pickup / dropoff representation | **A — Geocoded exact addresses or places** | Store `lat/lng` as source of truth for PostGIS and distance estimates; show user-friendly address/place labels. |
| 8 | Gas money split in MVP | **B — In-app agreement, offline payment** | App calculates/displays a proposed split; both parties can agree in app, but money changes hands outside the app. Product wording should be **confirm split**, not “sign agreement.” Store amount, confirmer, and timestamp. |
| 8a | Gas split agreement wording | **C — No signing language** | Avoid implying a legal contract; implement lightweight confirmation under the hood. |
| 9 | Driver verification in MVP | **B — Self-declared** | Driver confirms license/insurance/good driving record in profile; no document upload or review until Security + Trust phase. |
| 10 | Real-time journey tracking | **A — Not in MVP** | Use static pickup/dropoff/listing locations only; live tracking moves to Security + Trust with journey sharing/SOS. |
| 11 | Verticals | **B — Tags/filters only** | Support lightweight tags such as `airport` and `student` within the same core carpool flow. **Remove moving help** from MVP scope. |
| 12 | Platforms for MVP | **B — Mobile + web from day one** | Use the shared React Native / React Native Web stack for iOS, Android, and web. |
| 13 | Auth / identity | **B — OAuth first** | Use Google/Apple OAuth with optional email fallback. Backend verifies provider tokens and creates app sessions/JWTs. |
| 14 | Profile minimum | **Recommended MVP default** | Store display name, profile photo, short bio, verified email/domain, and driver-only vehicle/self-declaration fields when relevant. |
| 15 | Identity groups | **B — Store verified email domain only** | Capture verified email domain from OAuth for future `.edu` / organization grouping, but do not build special matching or badges yet. |
| 16 | Listing recurrence | **A — One occurrence only** | Ride requests and driver trips represent a single planned ride; recurring carpools are deferred. |
| 17 | Listing lifecycle states | **B — Add expiry** | Listings use `open`, `expired`, `matched`, `cancelled`, and `completed`; `draft` and `paused` are deferred. |
| 18 | Connection lifecycle states | **B — Add expiry** | Connections use `pending`, `expired`, `accepted`, `declined`, `cancelled`, and `completed`. Keep gas split confirmation separate from connection state. |
| 19 | Core data entities | **Recommended MVP default** | Model `User`, `Profile`, `Vehicle`, `RideRequest`, `DriverTrip`, `Connection`, `ChatThread`, `Message`, `GasSplitConfirmation`, and `Notification`. |
| 20 | Seats / passenger count | **Recommended MVP default** | Driver trips declare seats available; ride requests declare passenger count. Accepted connections reserve seats and prevent overbooking. |
| 21 | Search and sorting | **Recommended MVP default** | Authenticated users search the opposite listing type by destination radius, target date/flexibility, tag, and pickup proximity. No route-corridor matching yet. |
| 22 | Location privacy | **Recommended MVP default** | Store exact geocoded points, but show approximate area/place labels before accept. Reveal exact agreed pickup/dropoff details after accept. |
| 23 | Gas split calculation | **Recommended MVP default** | Show a suggested split from estimated distance and editable cost assumptions. Let participants override before confirming. No live gas-price API required for MVP. |
| 24 | Notifications | **Recommended MVP default** | Use in-app and email notifications for offers/requests, accept/decline/cancel, chat unlock/messages, and split confirmations. Push notifications can follow later. |
| 25 | Completion flow | **Recommended MVP default** | After the ride date, accepted connections can be marked completed. Record who confirmed completion; no disputes/refunds in MVP. |
| 26 | Ratings and reviews | **Recommended MVP default** | Defer ratings/reviews to Security + Trust. Keep completion data so ratings can be added later without remodelling rides. |
| 27 | Basic safety controls | **Recommended MVP default** | Authenticated-only marketplace with block/report controls. Full moderation workflows, SOS, and journey sharing remain post-MVP. |
| 28 | Maps / geocoding provider | **Recommended MVP default** | Use a managed maps/geocoding provider behind a replaceable integration. Persist coordinates and display labels as app data, not provider response blobs as the source of truth. |

---

## Team Review Focus

- Total decision count is **28**, staying under the requested limit of 30.
- Q1–Q18 were discussed directly or resolved from your explicit answers.
- Q19–Q28 are recommended MVP defaults added to close the remaining design surface for team review.
- The biggest revisit candidates are Q3 connection creation, Q21 search/corridor matching, Q22 location privacy, and Q27 safety controls.

## Parking lot (post-MVP / other PRD sections)

- Security + Trust: ID verification, identity groups (.edu, neighborhood), PII masking (Twilio), payments, SOS, ratings
- AI: student matching, dynamic pricing, flight data, luggage/vehicle size ML
- Connection model may move from symmetric browse (**Q3 A**) to suggestions-only (**Q3 C**) — note for team
- Out of scope: moving help (not a carpool use case)

---

## Changelog

| Date | Change |
|------|--------|
| 2026-05-24 | Initial agenda from grill session (Q1–Q3 resolved; Q4–Q13 open). |
| 2026-05-24 | Q4 resolved: hybrid chat (pending templates + full chat after accept). |
| 2026-05-24 | Q5 resolved: single account for rider + driver roles. |
| 2026-05-24 | Q6 resolved: tight endpoint destination matching for MVP. |
| 2026-05-24 | Q7 resolved: geocoded exact addresses or places for pickup/dropoff. |
| 2026-05-24 | Q8 resolved: in-app gas split agreement with offline payment. |
| 2026-05-24 | Q8a resolved: use “confirm split” wording, not “sign agreement.” |
| 2026-05-24 | Q9 resolved: self-declared driver verification for MVP. |
| 2026-05-24 | Q10 resolved: no live journey tracking in MVP. |
| 2026-05-24 | Q11 resolved: airport/student tags only; moving help removed from scope. |
| 2026-05-24 | Q12 resolved: mobile + web from day one using shared React Native stack. |
| 2026-05-24 | Q13 resolved: OAuth-first auth with backend token/session handling. |
| 2026-05-24 | Q14 added: recommended MVP profile minimum. |
| 2026-05-24 | Q15 resolved: store verified email domain for future identity groups. |
| 2026-05-24 | Q16 resolved: one-off ride requests and trips only; no recurring listings in MVP. |
| 2026-05-24 | Q17 resolved: listing states include automatic expiry. |
| 2026-05-24 | Q18 resolved: connection states include automatic expiry. |
| 2026-05-24 | Q19–Q28 added as recommended MVP defaults per user request. |
