# Implementation Checklist — Production Hardening & Role-Aware Matching

Tracks work against `ISSUES.md` issues 24–34 (the 2026-08-28 initiative) plus the
approved workflow/UI proposal. Updated as work lands; see `PRD.md` for the
decisions behind each item.

## 🔴 Post-ship fix: sign-in was hanging on "Loading…" forever

Found after the initial Phase 0–3 pass shipped, from a real user report. Root cause was in the issue 24 JWT work, and turned out to be two stacked bugs, both now fixed and **verified against the real, live Neon Auth server** (I have network access to it, so this isn't guesswork this time):

1. **Frontend was calling the wrong endpoint.** `authClient.getJWTToken()` (the SDK's generic method) maps method names to URL paths (`getJWTToken` → `/get-j-w-t-token`) — confirmed live that this 404s. The real endpoint is `GET {authUrl}/token` (confirmed via the SDK's own OpenAPI type schema, response shape `{ token: string }`, and a live request returning 401-not-404, i.e. it exists and just needs credentials). Fixed: `fetchNeonJWT()` in `frontend/src/lib/auth.ts` now calls `/token` directly with `credentials: 'include'`.
2. **No failure path.** `NeonAuthSync` had no retry/timeout/error handling — any failure left `authLoading` `true` forever with nothing to re-trigger the effect. Fixed: retries 3x with backoff, then surfaces a "Could not verify your session" screen with Retry/Sign-out buttons instead of hanging forever. New regression test asserts this.

**Also caught and fixed the backend equivalent of the same mistake before it could cause the identical incident on the verification side**: my assumed JWKS path (`/jwks`, the better-auth-plugin-specific route) also 404s live. The real path is the standard OAuth/OIDC well-known discovery endpoint, `/.well-known/jwks.json` — confirmed live (`curl` returns a real JWKS document with the EdDSA key), and confirmed my exact `PyJWKClient` code successfully fetches and parses it. Changed the default in `backend/app/main.py` and `.env.example`. Also **removed the `issuer=neon_auth_url` auto-guess** (issuer/audience checks are now off by default, signature+expiry still always enforced) — since I can't verify the real `iss`/`aud` claims without a live signed token, guessing wrong there would silently reproduce this exact "everyone locked out" failure mode again. Set `NEON_AUTH_ISSUER`/`NEON_AUTH_AUDIENCE` once you've decoded a real token and confirmed the actual values.

30/30 backend tests, 24/24 frontend tests passing (backend suite has occasional single-test flakiness from this sandbox's clock jumping mid-session, documented above — not a code issue, reruns clean).

## Phase 0 — Design system foundation
- [x] 34. Apply navy/sky-blue design tokens (`frontend/src/styles/theme.css`); reskinned `TopBar`/`Sidebar` to navy structural surfaces via the existing `--sidebar-*` token family

## Phase 1 — Workflow & UI (issues 30–33, plus finishing 16–18/21 frontend)
- [x] 30. Algorithmic Best-Matches card deck (Passenger mode home) — ranks on real signals only (shared profile interests, verified status, date/flexibility closeness to the user's own open listing); does NOT fabricate pickup distance/ETA since exact coordinates are deliberately withheld pre-connection (privacy design). Enriches top candidates via `getUserProfile` (bounded to 8 requests).
- [x] Driver-mode home: route publish card + requests-along-route list (`DriverHomeView`, same ranking engine, symmetric)
- [x] 31. Auto-fill vehicle specs + dynamic driver/rider-only fields on post form — driver/rider field visibility was already dynamic (pre-existing); added the vehicle auto-fill from the saved `vehicles` row (editable, with an "auto-filled from your profile" note), 1 new test
- [x] 32. Block/report `...` overflow menu — inbox/chat headers already had it (`ConnectionCard`); added it to pool roster members (no separate public-profile screen exists, so match cards will get their own menu when built)
- [x] 33. Notification deep-linking, unread state, mark-all-read, dismiss, category filters — backend gap found+fixed: no endpoint existed for `Store.mark_notifications_read`, and no dismiss method or `related_id` column existed at all. Added `POST /notifications/read`, `DELETE /notifications/{id}`, `Store.dismiss_notification`, threaded `related_id` (connection/pool id) through all 6 `notify()` call sites, added deep-link-and-scroll-to-card in `ConnectionsView`/`ConnectionCard`, category pills (All/Connections/Chat/Payments), real unread/read visual states, per-item dismiss, persisted mark-all-read.
- [x] 16/17. Pool card: departure_time + named roster + organizer badge (`PoolView.tsx` rewritten; typechecks clean)
- [x] 18. Pool group chat UI (`PoolChat` in `PoolView.tsx`, reuses the inbox chat visual pattern) — also folded in issue 32's block/report menu on each roster member
- [x] 21. Profile editor: interests + nationality fields — also fixed a pre-existing bug where "Save profile" always sent `photo_url: null`, silently wiping any uploaded photo on every profile edit

## Phase 2 — Auth & authorization hardening
- [x] 24. Verify Neon Auth JWT server-side in `/auth/login` — see the post-ship fix note above; the JWKS path and frontend token-fetch call are now both confirmed against the live Neon Auth server, not just assumed
- [x] 25. Authorize `/ride-requests/expire`, `/driver-trips/expire`, `/connections/expire`, `/messages`, `/profile`; add Vercel Cron — `/messages` (connection + pool) and `/profile` were already correctly authorized on audit, no change needed. The real gap was the three expire endpoints: any signed-in user could trigger a global expiry sweep. Now gated behind a `CRON_SECRET` shared-secret check (Vercel's own standard Cron Job auth convention — it auto-sends this header when the env var is set, so no extra wiring). Added `GET /cron/expire` since Vercel Cron only sends GET (can't hit the existing POST+body endpoints); wired hourly in `vercel.json`. 4 new backend tests, 27/27 passing.

## Phase 3 — Data & matching infra
- [x] 27. Persist driver location durably — `driver_locations` is now a real Postgres/PostGIS table (was an in-memory dict, wiped every cold start), with a 5-minute staleness TTL enforced at query time. Test proves persistence across two independent `Store()` instances (the exact cold-start scenario this replaces).
- [x] 28. Adopt PostGIS for matching queries — `locations.geog` (persisted geography column + GiST index) and `ST_DWithin` now do destination/pickup radius filtering in SQL, replacing the old fetch-everything-then-Python-haversine-filter loop. Also fixed a real bug found along the way: `Store.__init__` was replacing the global connection pool without closing the old one, leaking connections on every new `Store()`.
- [ ] 26. Move photo uploads to object storage — **needs a Blob/S3/R2 credential from you; will scaffold behind an env var**
- [ ] 29. Hybrid real-time strategy (polling fallback now; hosted realtime service needs a vendor key from you later)

## ⚠️ Still worth confirming before relying on issuer/audience checks
Signature verification, expiry, the JWKS path, and the frontend token fetch are all now confirmed against the real live Neon Auth server (see the post-ship fix note above) — that part isn't guesswork. The one thing still unconfirmed is the exact `iss`/`aud` claim values, since I don't have a real signed user token to decode (no test credentials for actual sign-in). Issuer/audience checks are deliberately left off by default so this doesn't turn into another silent lockout — set `NEON_AUTH_ISSUER`/`NEON_AUTH_AUDIENCE` in `backend/.env.example` once you've decoded one real token and confirmed the values, if you want that extra check enabled.

## Notes / blockers
- Issue 34 palette: treating "the proposal looks good" as approval to ship the navy/sky-blue tokens shown in the canvas.
- Issue 26 and the hosted-realtime half of issue 29 need real external credentials I don't have — I'll build the code path behind config so it's a drop-in once you provide them, and use a safe local default in the meantime.
- **Default Passenger/Driver mode changed from `'driver'` to `'rider'`** (`pages/home.tsx`, the `sessionStorage.getItem('carpool_mode') || '...'` fallback). Before issue 30/driver-home, `mode` didn't affect which view rendered, so this default was cosmetic. Now it decides the whole landing view, so I picked `'rider'` to match the spec's primary flow and to keep "browse the marketplace" as the first-run experience. Updated 5 existing tests in `App.test.tsx` that had baked in the old default's behavior — flagging this since it's a real behavior change, not just a test fix.
- Found and fixed a real duplicate-listing bug while wiring this up: with Best Matches shown above the flat feed, the same listing could appear twice on screen. Fixed by excluding matched listing ids from the flat feed below (`matchedListingIds` in `pages/home.tsx`).
- **Test suite status**: 30/30 backend tests, 24/24 frontend tests. While adding the PostGIS tests I chased down an intermittent backend test flake — root cause was this sandbox's clock jumping during the session (confirmed independently: the system date itself rolled over mid-session) combined with tight test-JWT expiry windows; widened those windows in `test_mvp_api.py`. Also fixed the real (if minor) connection-pool leak noted under issue 28 while investigating. Both are artifacts of this sandboxed dev environment and its test harness, not the deployed app — occasional single-test 401s that clear on rerun can still show up here, but that's this environment's clock, not a code bug.

## Ready when you are
Everything except issue 26 (object storage) and the hosted-realtime half of issue 29 is done and tested. Send me a Blob/S3/R2 credential and/or an Ably/Pusher key whenever you're ready and I'll finish those — they're the only remaining items.
