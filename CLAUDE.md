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
make test-e2e        # drive the real app in the iOS simulator (Maestro)
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

End-to-end flows live in `apps/mobile/.maestro` and drive the app in the simulator via
Expo Go; `apps/mobile/.maestro/README.md` covers what they cover, what they can't, and
the XCUITest behaviours that will otherwise look like app bugs. They need the whole
stack up (`make up && make api`, plus Metro) and are not part of CI — run them before
shipping anything that touches booking or the floor plan, because **every UI bug in
this app so far has been invisible to typecheck, lint and Jest.**

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

**A request handler must not `commit()` before it has finished reading.** `SET LOCAL
app.org_id` is scoped to the transaction, so a commit inside a handler ends the tenant
context — and every query after it runs with none, which under RLS returns nothing
rather than everything. The `db` dependency commits once the handler has returned, so
handlers should simply not commit at all (`api/v1/bookings.py` is the model). The two
in `admin.py` that do are safe only because they answer from objects already in memory.
This shipped as a bug in `admin_people.py`: every write route answers with the state it
just produced, and the early commit made each one 404 on the row it had itself written
— "group not found" for a group the same screen had just listed.
`tests/test_admin_people.py::test_a_write_route_can_read_back_what_it_just_wrote`
drives it over HTTP, which is the only layer that shows it: the service functions are
correct, and a test that calls them directly never commits mid-request.

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

**A rule that refuses a booking must also be visible to the availability query.** Zone
permissions (FR-6.4) and blackouts (FR-6.5) were modelled in Phase 0 and authored by the
floor plan editor, and for a long time bound nothing at all: an admin could mark a zone
exclusive to one team, publish it, and every employee could still book those desks. A
control that is written and never read is worse than none, because it is believed.

Both decisions now live as **pure functions** in `app/services/restrictions.py`, and the
two callers that matter go through them: `policy/rules.py::ZoneAccess` / `BlackoutWindow`
at booking time, and `api/v1/bookings.py::floor_availability` when colouring the plan. Do
not give either caller its own copy — the failure mode is a desk that renders green and
then refuses, which is the same bug wearing different clothes. `preferred` is a ranking
hint for auto-assign, deliberately *not* an access mode; the `open_after` cut-off is
wall-clock on the booked date at the site, so it goes through `local_time_to_utc` rather
than comparing naive times (which looks right all winter and releases zones an hour early
all summer).

Blackouts cancel through `cancel_booking`, never a bulk `UPDATE`: FR-6.5 says "cancels
existing bookings *with notice*", and the notice is the half a status update silently
skips. `POST /v1/admin/blackouts/preview` reports what a closure would break before it
breaks it, the same shape as the floor-plan publish preflight and for the same reason.

The mobile app consumes all of this in `app/(tabs)/team.tsx` (who is in, the team's
week, colleague search), `app/colleague/[id].tsx` (a fortnight, and the way in to
"sit near"), and the floor screen, which draws visible colleagues on the plan. Two
client-side consequences of the server invariants below are easy to undo by accident:
the Team tab's "N people in" is `presence.people.length` and must never be sourced from
anywhere else, and "nobody else has booked a desk yet" is what an empty list has to say
even when people have — saying "2 more you can't see" would hand back exactly what the
filter removed. `me.features.presence` gates the tab itself (`href: null`), not just
its contents, so a tenant with the kill switch off never sees a feature that 404s.

**Presence visibility is a query condition, never a serializer step.** Every query that
can name a colleague carries `app/services/presence.py::visible_to(viewer)`. A user with
`presence_visibility='nobody'` is *absent from the result set* — not returned with a
`hidden: true` flag for a well-behaved client to respect (PRD Q6, TDD §11). The client is
a binary we do not run, so a privacy control that depends on its cooperation is not a
control. Two corollaries that are easy to undo by accident:

- **Never return a count of people you will not also name.** "14 in the office" beside a
  list of 12 identifies the two who opted out. `/v1/presence` therefore has no total; the
  caller counts what it can see. Occupancy comes from the availability query, which names
  nobody.
- **A hidden colleague is a 404, not a 403.** Refusing by name confirms both that the
  person exists and that they chose to hide, which is the fact they hid.

`presence.py::_days_for` is the one helper with no filter of its own — it trusts the
caller to pass an already-visible set, and must stay unreachable from anything else. The
`visible_to` subqueries are explicitly `aliased`: two unaliased references to
`group_members` let SQLAlchemy correlate the inner one away, which would compare a
candidate's memberships against themselves and return true for everyone.
`organizations.settings.presence_enabled` is the org-level kill switch — it defaults on,
`require_presence` gates every colleague route, and `/v1/me` reports it under `features`
so the app can drop the feature rather than offer it and fail. Absences are deliberately
*not* gated: they are the user's own record and also feed assigned-desk release (FR-6.7).

**Nothing may delete the last administrator, or a group a zone depends on** (FR-8.4).
Both live in `app/services/people.py`, and both exist because the failure is silent and
unrecoverable. An organization with no `org_admin` cannot appoint one — there is no
break-glass path in this product — so the guard counts *distinct active* users holding
the role, excluding the one being changed (counting rows would read one person's two
scopes as two administrators and wave the last one through). And
`zone_permissions.group_id` is `ON DELETE CASCADE`, so deleting a group that holds a
zone's only `exclusive` rule succeeds and quietly turns a restricted neighbourhood into
open seating: no error, no audit line, the desks simply go green one morning. The
refusal names the zones so an admin knows where to go and clear it.

Role assignment (`PUT /v1/admin/users/{id}/roles`) requires `org_admin` specifically,
not merely an admin role: a site admin who can grant roles can grant themselves
`org_admin`. Changing someone's roles bumps their `token_version`, because their
current access token still carries the old list.

**Errors are RFC 9457 `problem+json` with machine-readable violations, everywhere.**
`app/core/errors.py::ProblemError` subclasses (`NotFound`, `Unauthorized`, `Forbidden`,
`PolicyViolation`, `ResourceUnavailable`) carry a `detail` (developer-facing English) and a
list of `Violation{code, params, severity}`. Clients render user-facing messages from `code`
+ `params` only — never from `detail` — which is what keeps refusals explainable and
localizable. Policy reason codes live in `packages/shared/src/reason-codes.ts` and are
hand-mirrored in `app/policy/codes.py`; keep both in sync when adding one (there's a comment
in each pointing at the other). `tests/test_reason_codes.py` parses the TypeScript and fails
if the two diverge — until it was written, the "kept in sync by CI" claim was not true of
anything. `422` validation errors get the same shape via the
`RequestValidationError` handler in `app/main.py`, so the mobile client has exactly one error
contract.

## Backend structure (`services/api/app`)

- `api/deps.py` — `Principal` (decoded JWT claims), the `db`/`anon_db` session dependencies
  described above, `current_user`, `require_role(*roles)`.
- `api/v1/` — routers (`auth`, `me`, `spaces`, `bookings`, `presence`, `plans`, `admin`,
  `admin_people`), mounted under `/v1` in `api/v1/router.py`. `admin` edits the
  building, `admin_people` edits the directory; they share a prefix and role gate.
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
  replayed refresh token revokes the whole token family — see `RefreshToken.family_id`),
  `presence.py` (see the visibility invariant above), `people.py` (users, groups, roles
  and deactivation — see the last-administrator invariant above).
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
- `lib/theme.ts` — the "Daylight" design system: a light and a dark `Palette`, the type
  scale, radii, and card elevation. **Light is the default**; dark follows the system via
  `useColorScheme`. Two rules it exists to enforce. `accent` (a fill) and `accentText`
  (the same idea as text on the ground) are separate tokens, because the light-mode fill
  is unreadable as text on a dark ground — the dark palette is re-solved, never inverted.
  And `state.*` (free/taken/yours/closed/zone) is independent of `accent`, so "selected"
  and "your booking" can never collide again; every state also carries a distinct *shape*
  at the call site, so colour alone never means anything.
  Components take styles from `useThemedStyles(makeStyles)` with the `makeStyles` factory
  at **module scope** — its identity has to be stable or the sheet rebuilds every render.
- `components/Sheet.tsx` — the bottom sheet, and **the replacement for `Alert.alert`**.
  An alert is a dead end by construction: one line and a dismiss button. Every refusal
  carries a code, typed params and enough context to offer a way forward (TDD §11), and
  none of that survives being flattened into an alert string. Built on `Modal`, not a
  pan gesture, deliberately — a drag handler would mean worklets, and the worklet rule
  below has already been paid for once.
- `components/Icon.tsx` — the icon set, hand-drawn on `react-native-svg` (already a
  dependency) rather than an icon font. A shared stroke weight is what makes a set look
  like a set, and that is the first thing lost to a third-party pack.
- `app/` — expo-router file-based routes: `sign-in.tsx`, `(tabs)/` (index, spaces,
  team, me), `floor/[id].tsx`, `colleague/[id].tsx`, `pick-floor.tsx`.
- `components/Avatar.tsx` — a person as a monogram. The tint is hashed from the **user
  id**, not the name, so it survives a rename; see the plan-colour invariant above for
  the one surface that overrides it.

**No screen may derive "today" from the device.** `GET /v1/sites/{id}/availability`
returns the site's own `today` along with the week, and that is the only correct source
(TDD §5) — a phone an hour behind Berlin will otherwise open the plan on a day the
office was shut. The floor screen takes its day from a route param when it arrives from
a booking, and from the site's `today` otherwise; `toLocalDate(new Date())` is gone from
the screens for this reason.

**On the floor plan, colour means availability — and nothing else.** Presence puts
colleagues on the plan as monograms (FR-5.1, FR-5.3), and the obvious way to draw them
is in the same per-person tint the Team tab uses. That shipped for about ten minutes:
`avatarTints` contains a green a shade off `state.free` and a violet a shade off
`state.zone`, so a colleague rendered as a free desk. Occupied desks therefore use
`state.person` — deliberately in the `taken` hue family, because that is what such a
desk is — and identity on the plan is carried by the monogram, which no palette can
collide with. `DeskSheet` passes the same tint for the same reason: it sits directly
over the plan, and one person in two colours on one screen reads as two people. The
personal tints are for lists, where no state vocabulary competes.

**Overriding a type role's `fontSize` requires `at()`.** `type.code` and friends carry a
`lineHeight` matched to their size, so spreading one and changing only `fontSize`
crams a 26pt glyph into a 20pt line box and clips it. `at(type.code, 26)` scales both.

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

**Anything called from a gesture or animation handler must be a worklet.** Those run on
the UI thread, and Reanimated cannot call an ordinary JS function there — it aborts the
process: no red box, nothing in the Metro log, the app just quits ("Expo Go quit
unexpectedly"). The trap is refactoring: moving inline worklet maths into a shared module
for testability silently drops the `"worklet"` directive, and nothing in typecheck, lint,
Jest or `expo export` notices. `src/lib/plan.ts:viewportToPlan` carries the directive and
a test asserts it stays; apply the same rule to anything new that a handler calls.

Corollary: a crash with no JS error is native. Read the reason from
`~/Library/Logs/DiagnosticReports/Expo Go-*.ips` rather than guessing, and isolate render
from interaction before theorising — the plan rendering fine while tapping crashed is what
pointed at the gesture path.

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

**Android builds locally and in the cloud; unlike iOS, nothing blocks either.** There is no
separate Android app — same Expo project, and `android` has always been a declared target in
`app.json` and in CI's `expo export` job. EAS is the path to a *distributable* artifact
(`make build-android` → `eas build -p android --profile preview` → APK; TDD §13.5 named the
three profiles). For a dev loop, `npx expo run:android` works on this machine — verified
end-to-end: sign-in against the seeded API, the Today screen, and the floor plan with pan
gestures, on an API 36 emulator. Cold Gradle build 4m27s, 338 tasks.

The toolchain is self-contained — no Xcode coupling, so the Swift-version standoff that
blocks `expo run:ios` has no Android equivalent. Four things cost time to establish:

- **The SDK came from `brew install --cask android-commandlinetools`**, not the
  `android-studio` cask. Studio installs its SDK through an interactive GUI wizard, which is
  unscriptable; `sdkmanager` is not. Root is
  `/opt/homebrew/share/android-commandlinetools` — export it as `ANDROID_HOME`, and put
  `$ANDROID_HOME/platform-tools` on `PATH` for `adb`. The IDE is not needed to build.
- **`JAVA_HOME` must be pinned to 17.** The default `java` here is **22**
  (`/usr/libexec/java_home` resolves to `jdk-22.jdk`), and Gradle 9.3.1 + AGP want 17. Two
  17s are installed, so it is one line — `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`
  — but skipped, it fails deep in Gradle rather than at the door.
- **The AVD must be API 29 or newer**, because `app.config.ts` pins `minSdkVersion=29`
  (TDD §13.5's Android 10 floor). Expo SDK 57 compiles and targets 36, so
  `system-images;android-36;google_apis;arm64-v8a` is the matching pick and runs natively on
  Apple Silicon. `avdmanager create -d pixel_7` prints a `Could not load devices from
  …/devices.xml` error and applies the profile anyway — the AVD is fine; the error is noise.
- **`expo run:android --device` wants the AVD name, not the adb serial.** Passing
  `emulator-5554` fails with `Could not find device with name` — and *exits 0*, so it reads
  as a successful build that silently did nothing. With one emulator attached, omit the flag.

`expo run:android` starts Metro as a child, so it dies with the command; run
`npx expo start --dev-client` separately for a persistent bundler.

`apps/mobile/app.config.ts` exists **only** for what a static config cannot decide, and
both halves are Android release-build traps that produce a working-looking app:

- Android refuses cleartext HTTP in release builds (API 28+), and Expo sets
  `usesCleartextTraffic` on the *debug* variant only. Every EAS profile but `development`
  is a release build, so an APK aimed at `http://<lan-ip>:8000` installs, launches, loads
  its bundle and then fails every request. The grant therefore follows the address rather
  than standing open: it is on exactly when `EXPO_PUBLIC_API_BASE_URL` is itself `http://`,
  so a production build against https never carries it and nobody has to remember to
  revoke it. Verified by reading the generated `AndroidManifest.xml`, not by inspection.
- `.env` is gitignored, so an EAS builder never sees it and `lib/api.ts` falls back to
  `http://localhost:8000` — on a phone, the phone. The config throws on a builder with no
  `EXPO_PUBLIC_API_BASE_URL` rather than inlining that fallback: the address comes from the
  profile's `environment` (`eas env:create`), and a named build failure costs minutes where
  an app that signs in nowhere costs an afternoon. Same failure the LAN-address note above
  describes, one layer earlier.

`minSdkVersion` is pinned to 29 there too — TDD §13.5 puts the floor at Android 10, and
Expo's own default is 24.

**Three dependencies are Apple-only, and Android will not tell you.** `expo-glass-effect`
declares `"platforms": ["apple"]`, so it is simply not autolinked on Android — importing it
there is a runtime crash, and `expo-symbols` is SF Symbols. Neither is imported anywhere in
`src/` today (`@expo/ui` does ship Android). Typecheck, lint, Jest and `expo export` all
pass on a file that imports any of them, so the guard is knowing, not tooling. This is what
`components/Icon.tsx` already avoids by hand-drawing the set on `react-native-svg`.

**On an emulator, `localhost` is the emulator** — the host is `10.0.2.2`. The LAN address
works for the emulator as well as a physical device, so prefer it always, which is the same
conclusion the iOS note reaches by a different road.

**`make test-e2e` is iOS-only.** `scripts/e2e.sh` gates on `xcrun simctl` and Expo Go's iOS
bundle id, so the Maestro flows cover one platform. Maestro itself drives Android over
`adb` and the flows are platform-neutral, but the launcher is not — anything shipped on the
strength of those flows is unverified on Android, and CLAUDE.md's standing warning applies
with more force there: every UI bug in this app so far has been invisible to typecheck,
lint and Jest.

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

**Route changes must be driven by the route guard, not by `router.replace`.**
`app/_layout.tsx` wraps the authenticated screens in `<Stack.Protected guard={!!token}>`
and the sign-in screen in the inverse. Deciding the route once on mount is what shipped
first and it was wrong: signing out cleared the token and navigated nowhere, leaving the
app on the tabs with every field blank and no way back short of relaunching. Adding an
imperative `replace` to the sign-out button would have left the same hole open for a
refresh token rejected mid-session. Do not reintroduce navigation on either side.

**React Native Testing Library does not work here.** `@testing-library/react-native`
14.0.1 returns an empty object from `render()` under Expo SDK 57 / React 19.2, with or
without a matching `react-test-renderer`. Component tests are therefore absent; the Jest
suite covers pure logic only (`src/lib`), and UI behaviour is verified by driving the
simulator. Re-check on the next SDK upgrade before assuming a component test will run.

**Simulator screenshots are scaled.** The tap coordinate space is device points
(402x874 on an iPhone 16 Pro), not screenshot pixels — scale coordinates before tapping.
