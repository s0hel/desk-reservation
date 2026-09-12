# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Deskflow: mobile-first desk/room booking for employers running flex-seating offices.
**Status: Phase 0 complete** — schema, tenant isolation, the booking correctness mechanism,
auth, and an Expo app that signs in and lists seeded resources. Booking itself is Phase 1.

- [`docs/PRD.md`](docs/PRD.md) — what we're building and why (`FR-n.m` references)
- [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md) — how (`TDD §n` references). Code
  comments cite both docs directly — read the cited section before changing that code.

## Layout

```
apps/mobile/         Expo app (SDK 57, expo-router, TypeScript)
services/api/         FastAPI + PostgreSQL (the only backend that currently exists)
packages/shared/      Policy reason codes, mirrored into Python by hand (kept in sync by CI)
packages/api-client/  TypeScript client generated from the OpenAPI schema (committed)
docs/                 PRD and technical design
```

pnpm workspaces for JS/TS (`apps/*`, `packages/*`); `uv` for the Python API.

## Commands

```bash
cp .env.example .env && pnpm install
make up             # postgres, redis, mailpit (docker compose)
make migrate        # cd services/api && uv run alembic upgrade head
make seed           # Example Corp: Berlin HQ, 2 floors, 120 desks, 6 rooms
make api            # uvicorn --reload, http://localhost:8000 (docs at /docs)
make db-reset        # drop the volume, migrate, reseed
make test           # cd services/api && uv run pytest -q
make lint           # ruff check + ruff format --check
pnpm gen:client      # regenerate packages/api-client from the live OpenAPI schema
```

Single test: `cd services/api && uv run pytest tests/test_booking_concurrency.py -q` (or
`-k <name>`). Tests use one session-scoped event loop (see `pyproject.toml`
`asyncio_default_fixture_loop_scope`) because the async engine's connection pool is
module-level — do not add per-test event loop fixtures.

Mobile: `cd apps/mobile && npx expo start`. Sign in with any seeded address, e.g.
`priya.raman@example.com`. Needs a **development build**, not Expo Go (`npx expo run:ios` /
`run:android`) — Expo Go can't load the custom native config later phases need. On a
physical device, set `EXPO_PUBLIC_API_BASE_URL` in `apps/mobile/.env` to your LAN IP, not
`localhost`.

CI (`.github/workflows/ci.yml`) runs three independent jobs: `api` (lint, migrate, pytest —
against the non-superuser role, see below), `contract` (regenerates the client and fails if
the committed `packages/api-client/src` is stale), `mobile` (typecheck + `expo export` for
both platforms).

## Architecture invariants

These are deliberate design decisions, not incidental structure. Changing the pattern they
describe requires touching the invariant, not routing around it.

**Double-booking is prevented by the database, not application code.** `bookings` carries a
GiST exclusion constraint over `(resource_id, time_range)`, partial on active statuses
(`confirmed`, `checked_in` — see `ACTIVE_STATUSES` in `app/models/booking.py`; it must stay
in sync with the partial `WHERE` on the `bookings_no_overlap` constraint from migration
0001). There is no locking in the booking path; two simultaneous bookings for the same desk
resolve via constraint violation → `ResourceUnavailable` (409). Never add
`SELECT ... FOR UPDATE` or application-level locking here — extend the exclusion constraint
instead. `tests/test_booking_concurrency.py` fires 8 simultaneous bookings at one desk and
asserts exactly one wins.

**Tenant isolation is structural, not a filter.** Every tenant-scoped table mixes in
`OrgScopedMixin` (`app/db/base.py`), which adds `organization_id` and has
`FORCE ROW LEVEL SECURITY` with a policy keyed on `current_setting('app.org_id')`. The one
dependency that's allowed to open a tenant session is `app/api/deps.py::db`, via
`_apply_tenant` (`SET LOCAL app.org_id`) — there is no other code path that opens a session
with tenant context set, and a session with none set returns nothing, not everything.
`anon_db` (pre-auth, e.g. tenant discovery by email domain) never sets it. A new table that
forgets `OrgScopedMixin`/`FORCE RLS` fails `tests/test_tenant_isolation.py`, which asserts
every table has RLS forced. The one deliberate exception is `org_domains`
(`domain → organization_id` only), which needs a global SELECT-only policy because
email→tenant routing happens before a tenant is known.

**The API must never connect as a superuser or BYPASSRLS role.** Either ignores RLS silently
while every policy stays listed. Two guards: `app/main.py::assert_rls_enforceable` refuses to
boot in staging/production under such a role (warns in development), and
`tests/test_tenant_isolation.py` asserts the precondition so the rest of that suite can't
pass vacuously. Local and CI both provision two Postgres roles via
`services/api/scripts/init-roles.sql`: `deskflow_owner` (migrations) and `deskflow_app`
(runtime, `NOSUPERUSER NOBYPASSRLS`). When running anything against the DB by hand, use the
`deskflow_app` role/`DATABASE_URL`, not `MIGRATION_DATABASE_URL`/`deskflow_owner`, or you'll
silently defeat RLS for that session.

**A "day" is defined by the site's timezone, never the device's or the server's.**
`app/core/time.py` is the *only* module allowed to convert between instants and site-local
days; everything else treats instants as opaque timezone-aware UTC `datetime`s (naive
datetimes are banned — ruff's `DTZ` rule is enabled specifically for this). Opening hours are
wall-clock + weekday mask, materialized per-date via `materialize_opening_hours` rather than
offset arithmetic, so DST is handled correctly for both 23- and 25-hour local days (see
`tests/test_time.py`).

**There is no calendar integration, in either direction.** Rooms are ordinary `Resource` rows
(same table as desks — `kind` discriminates), booked only in this app. This was a deliberate
simplification (TDD §1, revised from an earlier calendar-sync design) that is what makes
rooms cheap to build alongside desks. The one obligation that doesn't go away: rooms must be
made unbookable in the customer's own directory/calendar system, or they'll be double-booked
from Outlook/Google Calendar and this app cannot detect it.

**Errors are RFC 9457 `problem+json` with machine-readable violations, everywhere.**
`app/core/errors.py::ProblemError` subclasses (`NotFound`, `Unauthorized`, `Forbidden`,
`PolicyViolation`, `ResourceUnavailable`) carry a `detail` (developer-facing English) and a
list of `Violation{code, params, severity}`. Clients render user-facing messages from `code`
+ `params` only — never from `detail` — which is what keeps refusals explainable and
localizable. Policy reason codes live in `packages/shared/src/reason-codes.ts` and are
hand-mirrored in `app/policy/codes.py`; keep both in sync when adding one (there's a comment
in each pointing at the other). `422` validation errors get the same shape via the
`RequestValidationError` handler in `app/main.py`, so the mobile client has exactly one error
contract.

## Backend structure (`services/api/app`)

- `api/deps.py` — `Principal` (decoded JWT claims), the `db`/`anon_db` session dependencies
  described above, `current_user`, `require_role(*roles)`.
- `api/v1/` — routers (`auth`, `me`, `spaces`), mounted under `/v1` in `api/v1/router.py`.
- `core/` — `config.py` (pydantic-settings `Settings`, with `assert_safe()` run at startup to
  fail fast on a dev-login or weak JWT key outside development), `security.py` (JWT),
  `time.py` (see above), `errors.py`, `ids.py` (UUIDv7 PKs — see `PKMixin`), `logging.py`
  (structlog, request-id bound per request in `main.py` middleware).
- `models/` — SQLAlchemy 2.0 mapped classes, grouped by domain: `org.py` (org/user/auth),
  `space.py` (site/floor/zone/resource — desks and rooms share `Resource`), `booking.py`,
  `policy.py` (policy/zone-permission/blackout), `ops.py` (outbox, audit log). Every
  tenant-scoped model mixes in `PKMixin`, `TimestampMixin`, `OrgScopedMixin` from
  `db/base.py`.
- `services/` — `oidc.py`, `tokens.py` (refresh token rotation with reuse detection: a
  replayed refresh token revokes the whole token family — see `RefreshToken.family_id`).
- `seed.py` — the `make seed` fixture data described in the README/Makefile.

Dev-only sign-in (`POST /v1/auth/dev-login`) exists so Phase 0 is usable before a customer
IdP is configured. It's gated by `ENABLE_DEV_LOGIN` + `ENVIRONMENT=development`, a startup
assertion refuses to boot with it enabled outside development, and it's excluded from the
OpenAPI schema (tested). The real flow is OIDC with the API as relying party (TDD §12.1) —
don't build against dev-login as if it were permanent.

## Mobile structure (`apps/mobile/src`)

- `lib/api.ts` is **the only module permitted to call `fetch`** — all API access funnels
  through it. It currently hand-declares response types; Phase 1 replaces those with
  `@repo/api-client` generated from the OpenAPI schema, so don't invest in hand-written types
  here beyond what's needed now.
- `lib/auth.tsx` — `AuthProvider`/`useAuth`, tokens in `expo-secure-store` (Keychain/Keystore).
- `app/` — expo-router file-based routes: `sign-in.tsx`, `(tabs)/` (index, spaces, me),
  `floor/[id].tsx`.

## Cross-cutting contract

The OpenAPI schema generated from the FastAPI app is the single source of truth for the
mobile/API contract. `scripts/gen-client.sh` dumps it (no running server needed) and runs
`openapi-typescript` into `packages/api-client/src`. The output is committed, and CI's
`contract` job fails the build if regenerating produces a diff — so after any change to a
router's request/response models, run `pnpm gen:client` and commit the result in the same
change.

## Environment gotchas

Facts that cost real time to establish. Read before debugging the toolchain.

**Xcode 16.2 cannot build this app.** `expo-modules-jsi` and
`@expo/expo-modules-macros-plugin` declare `// swift-tools-version: 6.2`; Xcode 16.2 ships
Swift 6.0.3. `expo run:ios` fails with `xcodebuild` error 65 and a truncated message —
the real one is `package 'apple' is using Swift tools version 6.2.0 but the installed
version is 6.0.0`. Building the dev client requires a current Xcode. Everything short of
the Swift compile works fine on 16.2: `expo prebuild` and `pod install` both succeed.

**Expo Go is the interim way to run the app**, and it needs no local compilation because
Expo ships it prebuilt: `npx expo start --ios --go`. This works only while the app's
native dependencies stay inside what Expo Go bundles — today just `expo-secure-store`.
**It stops working in Phase 2**, when camera/QR, push and geofencing arrive (TDD §8.1);
those need a development build and therefore a current Xcode. Do not treat "it runs in
Expo Go" as evidence the dev-build path works.

**Running on a physical phone needs the LAN address in two places, and one of them
fails silently.** `apps/mobile/.env` must set `EXPO_PUBLIC_API_BASE_URL` to the Mac's LAN
address (`ipconfig getifaddr en0`), not `localhost` — on a device localhost is the phone,
so the bundle loads fine and then every request fails, which reads like a broken app
rather than a config problem. The value is inlined at bundle time, so Metro must be
restarted after changing it. The LAN address also works for the simulator, so prefer it
always. It is a DHCP lease: after a router reboot it can go stale and reproduce the same
silent failure.

Expo Go's "signed in to the CLI but not to Expo Go" notice is a red herring — signing in
only makes the project appear under Development servers. Opening `exp://<lan-ip>:8081`
directly works either way. If the phone genuinely cannot reach the Mac (different network,
or client isolation), use `npx expo start --go --tunnel`.

**CocoaPods comes from Homebrew** (`brew install cocoapods`). System Ruby is 2.6, too old
to run a modern CocoaPods.

**`<Link asChild>` needs a pressable child.** It forwards `onPress` to its child, and a
`View` cannot receive it — the result looks interactive and does nothing, which neither
typecheck nor tests catch. Use `Pressable`, and keep its `style` **static**: the function
form (`({ pressed }) => [...]`) does not survive `asChild` and silently drops the styling.

**Tests never touch the development database.** `tests/conftest.py` derives
`<name>_test` from the configured URLs and drops and recreates it on every run; it refuses
to start if that resolves back to the development database. Override with
`TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL`. `make test-db-drop` removes it.

**React Native Testing Library does not work here.** `@testing-library/react-native`
14.0.1 returns an empty object from `render()` under Expo SDK 57 / React 19.2, with or
without a matching `react-test-renderer`. Component tests are therefore absent; the Jest
suite covers pure logic only (`src/lib`), and UI behaviour is verified by driving the
simulator. Re-check on the next SDK upgrade before assuming a component test will run.

**Simulator screenshots are scaled.** The tap coordinate space is device points
(402x874 on an iPhone 16 Pro), not screenshot pixels — scale coordinates before tapping.
