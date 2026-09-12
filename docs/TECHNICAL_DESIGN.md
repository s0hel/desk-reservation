# Technical Design — Flex Workspace Booking

**Companion to:** [PRD.md](./PRD.md) v0.1
**Status:** Draft v0.1
**Last updated:** 2026-09-11

Requirement references below (`FR-n.m`) point at the PRD. This document decides *how*; the PRD
decides *what*. Where this document constrains product behavior, it says so explicitly.

---

## 1. Decisions carried in from the PRD

The answers in PRD §5.3 resolve four architectural forks. Their consequences:

| Answer | Architectural consequence |
|---|---|
| **Q3 — rooms are booked in the app only** *(revised)* | No Microsoft 365 / Google Calendar integration in any direction. Our database is the only record of a room booking. Rooms use the same resource, policy, and conflict machinery as desks. The one surviving obligation is organizational: rooms must be made unbookable in the corporate directory, or they will be double-booked from Outlook. See §7. |
| **Q2 — no Intune/MAM** | Public App Store + Play Store distribution. Standard Keychain/Keystore token storage. No MAM SDK, no wrapped build variants, no separate enterprise release train. |
| **Q1 — design partner first, general model** | Single-region deployment at launch; multi-tenant from the first migration so we never retrofit it. Admin configuration depth can lag; the *data model* cannot. |
| **Q5 — assigned desks in v1 model, behavior in Phase 3** | `resources.assigned_to_user_id` and the release-on-absence rule land in the schema in Phase 0, gated off until Phase 3. |
| **Q4 — QR + geofence only** | No badge-system ingestion adapter. Check-in is a first-party subsystem (§8). |
| **Q6 — presence opt-out + org kill switch** | Visibility is enforced in the query layer, not the UI. A hidden user must be invisible in the API response, not filtered client-side. |

**Q3 was revised after the first draft**: rather than projecting bookings into the customer's
calendar, there is no calendar integration at all. This deletes the largest and highest-risk subsystem
in the design — see §7.1 for exactly what goes, and §7.2 for the one cost that does not go away.
Rooms become, architecturally, just another resource kind, which is the simplification that makes
them cheap enough to build alongside desks rather than as a separate phase.

---

## 2. System context

```
                     ┌──────────────────────┐
   iOS / Android ───▶│                      │◀─── Admin web (Next.js)
   (Expo RN app)     │   API  (FastAPI)     │
                     │   - REST + OpenAPI   │
                     │   - OIDC RP          │
                     └───────┬──────────────┘
                             │
          ┌──────────────────┼───────────────────┬──────────────────┐
          ▼                  ▼                   ▼                  ▼
   ┌─────────────┐   ┌──────────────┐    ┌──────────────┐   ┌─────────────┐
   │ PostgreSQL  │   │    Redis     │    │  Object store│   │  Workers    │
   │ (SoT, RLS)  │   │ cache+queue  │    │ plans / PDFs │   │  (ARQ)      │
   └─────────────┘   └──────────────┘    └──────────────┘   └──────┬──────┘
                                                                   │
                                                  ┌────────────────┴────────────────┐
                                                  ▼                                 ▼
                                        Expo Push (APNs/FCM)                   Email (SES)

       External dependencies stop there. The only other outbound integration is the
       customer's IdP (Entra ID / Google OIDC) during sign-in — §12.
```

Trust boundaries: the mobile app is untrusted; the admin web is untrusted; workers and API share the
database but run with distinct database roles (§18.2).

---

## 3. Technology choices

| Layer | Choice | Why this, here |
|---|---|---|
| Mobile | Expo SDK (latest stable) + React Native, TypeScript, **development builds via EAS** | PRD §8.1. Expo Go is not usable — we need custom native config from day one. |
| Navigation | Expo Router | File-based routing, typed routes, first-class deep links (FR-10.3). |
| Mobile server state | TanStack Query + persisted MMKV cache | Gives us the offline read cache (FR-10.1) without hand-rolling a sync layer. |
| Floor plan rendering | `react-native-svg` + `react-native-gesture-handler` + `reanimated` | Pan/zoom on the UI thread; see §13.3 for the perf design. |
| API | FastAPI (async) + Pydantic v2 + Uvicorn | PRD §8.2. OpenAPI generation is load-bearing — it produces the mobile client. |
| ORM / migrations | SQLAlchemy 2.0 (async) + Alembic | |
| Database | PostgreSQL 16+, extensions `btree_gist`, `pgcrypto`, `pg_stat_statements` | `btree_gist` is required for the booking exclusion constraint (§6.4) — this is the core correctness mechanism. |
| Cache / queue | Redis | ARQ job queue, rate limiting, short-TTL availability cache. |
| Background jobs | ARQ | Async-native, same event loop model as the API, far less ceremony than Celery for this workload. |
| Admin web | Next.js (App Router) + TypeScript + shadcn/ui | The floor-plan editor is the only demanding screen; everything else is forms and tables. |
| Object storage | S3-compatible + CDN | Floor plan images, generated QR label PDFs, report exports. |
| Push | Expo Push Service → APNs/FCM | Fast to ship. Abstract behind our own `PushSender` interface so moving to direct APNs/FCM later is a one-class change. |
| Email | Transactional provider (SES or Postmark) | Magic links, digests, invites. |
| Client generation | `openapi-typescript` + a thin fetch wrapper, generated in CI | The contract cannot drift silently. A schema change that breaks the app fails the build, not a user. |

### 3.1 Repository layout

```
desk-reservation/
├── apps/
│   ├── mobile/            # Expo app
│   └── admin/             # Next.js admin console
├── services/
│   └── api/               # FastAPI: app/, alembic/, tests/
├── packages/
│   ├── api-client/        # generated TS client (CI artifact, committed)
│   └── shared/            # shared enums, reason codes, i18n message keys
├── infra/                 # IaC, docker-compose for local dev
└── docs/
```

pnpm workspaces for JS/TS; `uv` for Python dependency management. One `docker compose up` brings up
Postgres, Redis, the API, and a mail catcher for local development.

---

## 4. Core domain concepts

Three concepts carry most of the complexity. Naming them precisely now prevents drift later.

**Resource.** Anything bookable. Desks and rooms are `resource_kind` discriminators over one table,
which is what lets parking and lockers arrive later without touching the booking engine (PRD §6).
Kind-specific attributes live in a JSONB column with a validated shape per kind, not in sparse columns.

**Booking.** A `(resource, user, tstzrange)` claim with a status. The range is the authority for
conflict; the denormalized `local_date` is the authority for quotas and day-oriented queries.

**Policy.** A set of rules resolved from org → site → group precedence, evaluated as a pipeline that
returns structured allow/deny results. Policy is *never* enforced in the client. The client may
pre-filter for UX, but the server re-evaluates every rule on write.

---

## 5. Time, timezones, and the definition of "a day"

This is the highest-frequency source of correctness bugs in booking systems, so it gets its own
section and one canonical implementation.

**Rules:**

1. All instants are stored as `timestamptz` (UTC). No naive datetimes anywhere, enforced by a lint rule.
2. A booking's *day* is defined by the **site's** IANA timezone, never the device's and never the
   server's. A 09:00–17:00 booking in `Europe/Berlin` and one in `America/Los_Angeles` are different
   UTC ranges for the same local day.
3. `bookings.local_date` (a plain `date`) is computed at write time from the site timezone and stored.
   It cannot be a Postgres generated column because deriving it requires joining to the site's
   timezone, and generated columns may not reference other rows. This denormalization is deliberate:
   quota counting, day availability, and analytics rollups all key on it.
4. Opening hours are stored per site as local wall-clock times plus a weekday mask, and materialized
   into concrete UTC ranges per date when needed. DST transitions are therefore handled by the
   materialization step, not by arithmetic on UTC offsets.
5. The API accepts and returns ISO-8601 with explicit offsets, and additionally returns
   `site_timezone` on every resource and booking payload so the client never has to guess.
6. The mobile app renders in site-local time (FR-2.14) with a subtle indicator when the device
   timezone differs — a user booking Berlin from a New York airport must not see 03:00.

**Canonical helpers** (`services/api/app/core/time.py`), the only code permitted to do this conversion:

```python
def site_day_bounds(site: Site, local_date: date) -> tuple[datetime, datetime]: ...
def to_local_date(site: Site, instant: datetime) -> date: ...
def materialize_opening_hours(site: Site, local_date: date) -> tuple[datetime, datetime] | None: ...
```

---

## 6. Data model

Every table below carries `organization_id uuid not null`, `created_at`, `updated_at`, and is
protected by row-level security (§18.2). Primary keys are UUIDv7 (time-ordered, index-friendly).
Omitted from the sketches for brevity.

### 6.1 Tenancy and identity

```sql
organizations(id, name, slug, primary_domain, status, settings jsonb, data_region)
org_domains(id, organization_id, domain, verified_at)          -- FR-1.3 email → tenant routing
identity_providers(id, organization_id, kind, issuer, client_id,
                   client_secret_enc, discovery_url, enabled)  -- kind: oidc_google|oidc_entra|magic_link

users(id, organization_id, email citext, external_id, display_name, avatar_url,
      locale, status, home_site_id, presence_visibility, deactivated_at)
  -- presence_visibility: 'everyone' | 'team_only' | 'nobody'   (FR-5.6, Q6)
  UNIQUE (organization_id, lower(email))

groups(id, organization_id, name, kind, parent_group_id)        -- kind: team|department|custom
group_members(group_id, user_id, role)                          -- role: member|lead   (FR-2.10)

role_assignments(id, organization_id, user_id, role, scope_type, scope_id)
  -- role: employee|team_lead|site_admin|org_admin ; scope: org|site   (FR-1.8)

devices(id, organization_id, user_id, platform, push_token, app_version,
        locale, timezone, last_seen_at, revoked_at)
```

### 6.2 Spatial hierarchy

```sql
sites(id, organization_id, name, address, timezone, geo_lat, geo_lng, geofence_radius_m,
      opening_hours jsonb, daily_capacity_cap int null, checkin_enabled bool, status)

floors(id, organization_id, site_id, name, ordinal,
       plan_asset_id, plan_width_px, plan_height_px, published_at)

floor_plan_assets(id, organization_id, original_key, rendered_key, width_px, height_px,
                  content_type, checksum)

zones(id, organization_id, floor_id, name, kind, polygon jsonb, color)
  -- polygon: normalized [[x,y],...] in 0..1 plan space (§14.2)

zone_permissions(id, zone_id, group_id, mode, opens_at_local time null)
  -- mode: exclusive | preferred | open_after   (FR-6.4)
```

### 6.3 Resources

```sql
resources(
  id, organization_id, site_id, floor_id, zone_id null,
  kind,                       -- 'desk' | 'room'  (extensible: parking, locker, booth)
  code,                       -- '4F-A-01', human-facing, unique per site
  name,
  position jsonb,             -- {x, y, rotation} normalized to plan space
  capacity int,               -- 1 for desks; seats for rooms
  attributes jsonb,           -- validated per kind (FR-2.5, FR-3.1)
  assigned_to_user_id null,   -- Q5: modeled now, behavior in Phase 3 (FR-6.7)
  bookable bool,
  out_of_service_reason text null,
  qr_key_id int,                    -- rotation generation for the printed label (§8.1)
  status
)
UNIQUE (site_id, code)
```

`attributes` shape is validated by a Pydantic model chosen on `kind`:

```python
class DeskAttributes(BaseModel):
    sit_stand: bool = False
    monitors: int = 0
    dock: Literal["none","usb_c","thunderbolt","dual"] = "none"
    window: bool = False
    quiet: bool = False
    accessible: bool = False

class RoomAttributes(BaseModel):
    display: bool = False
    video_conf: bool = False
    whiteboard: bool = False
    phone: bool = False
    photos: list[str] = []
```

Attribute filters (FR-2.5) are served by a GIN index on `attributes` plus a partial B-tree on the
two or three attributes that actually drive filtering, added once query patterns are measured.

### 6.4 Bookings — the correctness core

```sql
CREATE TYPE booking_status AS ENUM
  ('confirmed','checked_in','completed','cancelled','released_no_show');

CREATE TABLE bookings (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL,
  resource_id       uuid NOT NULL REFERENCES resources(id),
  site_id           uuid NOT NULL,
  user_id           uuid NOT NULL REFERENCES users(id),
  booked_by_user_id uuid NOT NULL,          -- delegation (FR-2.10)
  time_range        tstzrange NOT NULL,
  local_date        date NOT NULL,          -- site-local; see §5
  status            booking_status NOT NULL DEFAULT 'confirmed',
  slot              text NOT NULL,          -- 'full_day'|'am'|'pm'|'custom' (display only)
  series_id         uuid NULL,              -- recurrence grouping (FR-2.7)
  checkin_deadline  timestamptz NULL,
  checked_in_at     timestamptz NULL,
  checked_in_method text NULL,              -- 'qr'|'geofence'|'admin'|'walkup'
  released_at       timestamptz NULL,
  cancelled_at      timestamptz NULL,
  cancel_reason     text NULL,
  idempotency_key   text NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The mechanism that makes double-booking structurally impossible.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (resource_id WITH =, time_range WITH &&)
  WHERE (status IN ('confirmed','checked_in'));

CREATE INDEX bookings_resource_date  ON bookings (resource_id, local_date)
  WHERE status IN ('confirmed','checked_in');
CREATE INDEX bookings_user_date      ON bookings (user_id, local_date DESC);
CREATE INDEX bookings_site_date      ON bookings (site_id, local_date)
  WHERE status IN ('confirmed','checked_in');
CREATE INDEX bookings_checkin_sweep  ON bookings (checkin_deadline)
  WHERE status = 'confirmed' AND checkin_deadline IS NOT NULL;
CREATE UNIQUE INDEX bookings_idem    ON bookings (organization_id, booked_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Notes on the exclusion constraint, because it carries FR-2.13 on its own:

- Ranges are `[)` half-open, so a booking ending at 12:00 and one starting at 12:00 do not conflict.
- The partial `WHERE` means cancelled and released bookings do not block re-booking, and we keep
  history rather than deleting rows.
- A violation surfaces as `psycopg.errors.ExclusionViolation`, which the booking service maps to a
  `409 resource_unavailable` problem response. **No application-level locking is used.** Two phones
  tapping the same desk at the same millisecond resolve deterministically in the database.
- Consequence for the design: any feature that wants "soft holds" (waitlist claim windows, FR-2.11)
  must be a separate `booking_holds` table with its own exclusion constraint, not a booking status.

### 6.5 Policy, check-in, attendees, audit

```sql
policies(id, organization_id, scope_type, scope_id, rule_type, config jsonb, enabled, priority)
  -- scope_type: org|site|group ; resolution order group > site > org  (§9)

blackouts(id, organization_id, site_id null, floor_id null, starts_on, ends_on, reason, cancels_bookings bool)

absences(id, organization_id, user_id, local_date, kind)   -- remote|leave|travel  (FR-5.5, FR-6.7)
  UNIQUE (user_id, local_date)

checkin_events(id, organization_id, booking_id, method, occurred_at, client_ts,
               geofence_pass bool null, device_id, raw_distance_bucket text null)
  -- never store raw coordinates (PRD §9.4)

booking_attendees(id, organization_id, booking_id, user_id null, external_email null,
                  response, invited_at, responded_at)                 -- §7.4

notification_prefs(user_id, channel, type, enabled)
outbox(id, organization_id, aggregate_type, aggregate_id, event_type, payload jsonb,
       available_at, attempts, locked_until, processed_at)   -- §15.1

audit_log(id, organization_id, actor_user_id, action, target_type, target_id,
          before jsonb, after jsonb, ip_hash, occurred_at)   -- FR-8.8
```

---

## 7. Rooms

Rooms are `resources` with capacity and amenities. They are booked by the same engine, under the same
policies, with the same conflict guarantee as desks. **There is no integration with Microsoft 365 or
Google Calendar.** The app is the only place a room is booked.

### 7.1 What this removes

Deleting the calendar subsystem removes, in full: app registrations and service principals, OAuth
consent flows, domain-wide delegation, per-tenant provider credentials, change-notification
subscriptions and their renewal job, delta/sync-token handling, the nightly reconciliation loop, the
foreign-event conflict queue, provider rate limiting and circuit breakers, `etag` concurrency handling
on every room mutation, and three database tables.

It also removes the highest-risk item in the PRD (R1) and roughly two to three weeks from Phase 2,
plus ongoing operational load that would never have gone away — expiring subscriptions and silently
dead notification channels are a permanent maintenance tax, not a one-time build cost.

The design is meaningfully simpler for it. Several things that were awkward become trivial:
find-a-room (FR-3.5) is now a query against our own data rather than free/busy federation; room
check-in and auto-release (FR-3.6) have no calendar race to lose; extend and end-early (FR-3.7) are
plain updates instead of optimistic-concurrency retries against a provider.

### 7.2 What it costs, stated plainly

**One problem does not go away, and it is the important one.** If the customer's rooms still exist as
bookable resource mailboxes in Exchange or Google, employees will keep booking them in Outlook — and
we will have no idea. Two people arrive at the same room. Our data says it is free; Outlook says it is
taken. Nothing in our system can detect this, because we are no longer reading the calendar.

The mitigation is organizational, and it is a required onboarding step, not a recommendation:

> **Rooms managed in this product must be made unbookable in the corporate directory.** Either remove
> the room resource mailbox, or restrict its booking policy so end users cannot book it. Any room left
> bookable in both systems will be double-booked.

This is the same mailbox lockdown the integrated design required — it is the one piece that survives,
because it is what makes "the app is the only place" true rather than aspirational. The difference is
that previously we could detect regressions automatically (the foreign-event queue); now we cannot.
Onboarding must verify it, and the admin console should state the requirement prominently.

Two smaller costs:

- Room bookings do not appear on attendees' work calendars automatically. §7.4 covers what replaces that.
- Employees who live in Outlook adopt a second tool for rooms. **This is the adoption risk to validate
  with the design partner in the first two weeks** — it is a behavior question, not a technical one,
  and it is much cheaper to learn early than to discover at rollout.

### 7.3 Booking model — no new machinery

```sql
-- resources.kind = 'room'; capacity = seats; attributes = RoomAttributes (§6.3)
-- resources.external_calendar_id is dropped.
-- Tables dropped: calendar_connections, calendar_channels, calendar_conflicts, calendar_projections.
```

The exclusion constraint (§6.4) already covers rooms — it keys on `resource_id`, not on kind, so room
double-booking is prevented by the same mechanism with no additional code.

Room-specific policy rules join the pipeline in §9:

| Rule | Purpose |
|---|---|
| `MaxRoomDuration` | cap a single booking (e.g. 4 hours) |
| `RoomAdvanceLimit` | separate horizon from desks — rooms are typically booked days, not weeks, ahead |
| `RoomCapacityFit` | warn (not block) when booking a 12-seat room for 2 people |

`RoomCapacityFit` is deliberately a `warn` severity: the policy engine already supports non-blocking
results (§9), and telling someone their meeting is too small for the room is advice, not a rule.

The room day timeline (FR-3.2) is the same availability query as §10.1, windowed by hour instead of
by day and grouped by resource.

### 7.4 Attendees, in-app

Since there is no calendar to carry the invitation, attendance is a first-class concept in our data:

```sql
booking_attendees(
  id, organization_id, booking_id,
  user_id null,                 -- internal attendee
  external_email null,          -- guest, invited by email only
  response,                     -- invited | accepted | declined | tentative
  invited_at, responded_at
)
UNIQUE (booking_id, user_id), UNIQUE (booking_id, external_email)
```

- Internal attendees get a push and an in-app invitation with accept/decline (FR-3.3). The meeting
  appears on their home screen for that day alongside their desk booking.
- External guests get an email only. Guest handling stays minimal in v1; visitor management is out of
  scope (PRD §13).
- Cancelling or moving the room notifies every attendee automatically via the outbox (§15.1).

**This is better than a calendar invite for the product's core loop, not merely a substitute.** An
attendee who accepts a room booking has declared they will be on site that day. The app can say so in
the team view (FR-5.4), and it can offer to book them a desk in one tap — a prompt no calendar invite
could produce. Design the accept flow around that: *"You're in the Berlin office Thursday. Want a desk
near the room?"*

Two small, optional, **one-way** conveniences remain. Neither is an integration: no OAuth, no service
account, no sync, no reconciliation, nothing to maintain.

1. **`.ics` attachment** on the notification email, so an attendee who wants the meeting on their work
   calendar can add it in one click. A generated file on an outbound email.
2. **"Add to phone calendar"** in the app, writing a local event via `expo-calendar` on the device.
   Nothing leaves the phone.

Both are `P1` and independently removable. If you want the app to be the only surface, delete them and
nothing else in the design changes. Keeping them is a judgment call in favor of attendees actually
seeing the meeting where they habitually look; they are recorded here as a distinct decision rather
than smuggled in as part of "calendar support".

### 7.5 If integration is ever required

Do not pre-build for it, and do not keep dead abstraction in the codebase waiting for it. The re-entry
point is well defined: a one-way projection worker consuming `booking.confirmed` / `booking.cancelled`
from the existing outbox (§15.1), writing to the provider, with `calendar_projections` reintroduced.
Because the outbox already exists for notifications, that is an additive feature against a stable seam
rather than a re-architecture. The full design is in this document's git history at v0.1.

---

## 8. Check-in subsystem

### 8.1 QR codes

A printed label is inherently static, so the QR's job is **authenticity**, not freshness.

Encoded value is a universal/app link so the phone's native camera also works:

```
https://qr.<domain>/c/<payload>
payload = base64url( "1" | resource_short_id | key_id | hmac_sha256(secret_org, "1|resource|key_id")[:10] )
```

- `secret_org` is a per-organization key in the secret store, so one tenant's codes are meaningless
  in another's.
- `key_id` is the rotation generation. Reprinting labels for a floor bumps `resources.qr_key_id`;
  codes with a stale `key_id` are rejected with a clear "this label is out of date" message.
- The HMAC prevents forging or enumerating codes for resources the user cannot see. It does **not**
  prevent a user photographing the label and scanning the photo from home.

Replay is mitigated, not eliminated, by: the check-in window (FR-4.3), an optional geofence assertion
required alongside the scan, and an anomaly rule (the same device checking in at two sites within an
implausible interval). We should say this honestly in the admin console rather than implying the QR
proves presence. Genuinely tamper-resistant check-in needs a powered display with a rotating code —
that arrives with the room kiosk in Phase 4 (FR-3.8), where it is achievable.

Label sheets (FR-8.7) are generated server-side as a PDF into object storage, produced by a worker
because a floor of 300 labels is not a request-response workload.

### 8.2 Geofence check-in

`expo-location` foreground permission only, requested contextually — on the day of a booking, when the
user opens the app — never at first launch. The device computes distance to `sites.geo_lat/lng` and
sends **a boolean plus a coarse distance bucket**, never coordinates (PRD §9.4).

The honest limitation: a client-asserted geofence is spoofable, and the server cannot verify it.
It is a convenience path that raises check-in rates (the G3 metric), not a presence proof. Sites that
need assurance disable geofence check-in and require QR; that toggle is per site (FR-4.7 extends to
per-method).

Background geofencing is explicitly **not** in v1: the battery, permission-prompt, and privacy costs
are real and the benefit over a well-timed push notification is small.

### 8.3 Auto-release

`checkin_deadline` is computed at booking time from the site's policy. A sweeper runs every 60
seconds:

```sql
SELECT id FROM bookings
WHERE status = 'confirmed' AND checkin_deadline < now()
ORDER BY checkin_deadline
FOR UPDATE SKIP LOCKED
LIMIT 500;
```

Each claimed row transitions to `released_no_show`, which removes it from the exclusion constraint's
partial index and returns the desk to the pool atomically. `SKIP LOCKED` lets the sweeper run in
multiple workers without coordination. A warning push goes out 15 minutes before the deadline
(FR-4.5) via the scheduled-notification path, and the release itself emits a notification and an
outbox event that notifies the user.

---

## 9. Policy engine

Policy must be explainable (FR-6.9), server-authoritative, and cheap enough to run on every
availability query. Design: a pure-function rule pipeline over an immutable context.

```python
@dataclass(frozen=True)
class BookingContext:
    org: Organization; actor: User; subject: User        # differ when delegating (FR-2.10)
    site: Site; resource: Resource | None
    time_range: Range; local_date: date
    existing_bookings: Sequence[Booking]                 # pre-loaded, no N+1 in rules
    resolved_policies: PolicySet
    now: datetime

class RuleResult(NamedTuple):
    allow: bool
    code: str | None            # e.g. "policy.horizon_exceeded"
    params: dict                # {"max_days": 14} — the client localizes
    severity: Literal["block","warn"]

class Rule(Protocol):
    id: str
    def evaluate(self, ctx: BookingContext) -> RuleResult: ...
```

**Resolution order** is group → site → org, most specific wins per `rule_type`. Multiple groups are
resolved by `policies.priority`, then by group specificity, deterministically.

**Every rule is evaluated**, even after the first denial, so the API can return all reasons at once —
a user blocked by both the horizon and their weekly quota should learn both in one round trip.

| Rule | Backs | Notes |
|---|---|---|
| `OpeningHours` | FR-2.2 | materialized per date (§5) |
| `BookingHorizon` | FR-6.1 | |
| `MaxConcurrentBookings` | FR-6.2 | |
| `SiteCapacityCap` | FR-6.3 | counts confirmed+checked_in for `local_date` |
| `ZonePermission` | FR-6.4 | includes `open_after` time-based release |
| `Blackout` | FR-6.5 | |
| `HybridQuota` | FR-6.6 | min/max days per rolling week or calendar month |
| `AssignedDesk` | FR-6.7 | owner always allowed; others only when owner has an `absences` row |
| `CancellationCutoff` | FR-6.8 | evaluated on the cancel path |
| `NoShowRestriction` | FR-6.8 | warn first, then block |
| `OneDeskPerDay` | implicit | a user holds at most one desk per site per local date |
| `DelegationAllowed` | FR-2.10 | actor must lead the subject's group or be an admin |

Reason codes live in `packages/shared/reason-codes.ts` and are mirrored into Python, so the mobile
app can render a localized, specific message (FR-10.4) without the server ever sending English prose.
Adding a rule without adding its message key fails CI.

Rules are ordinary functions with no I/O, which makes the policy matrix exhaustively unit-testable —
and it should be, because this is where customer-specific requirements will accumulate.

---

## 10. Availability and booking flows

### 10.1 Availability query

One query serves the floor plan, the list view, and the filter UI:

```sql
SELECT r.id, r.code, r.position, r.attributes, r.assigned_to_user_id,
       b.user_id AS occupied_by, b.status AS booking_status
FROM resources r
LEFT JOIN LATERAL (
    SELECT user_id, status FROM bookings
    WHERE resource_id = r.id
      AND status IN ('confirmed','checked_in')
      AND time_range && tstzrange(:window_start, :window_end, '[)')
    LIMIT 1
) b ON TRUE
WHERE r.floor_id = :floor_id
  AND r.kind = 'desk'
  AND r.bookable
  AND (:filters IS NULL OR r.attributes @> :filters);
```

The GiST index on `(resource_id, time_range)` created by the exclusion constraint serves the lateral
join directly. Policy rules are then applied to annotate each resource as bookable/blocked **with a
reason**, so the floor plan can grey a desk and explain why on tap rather than silently hiding it.

Results for a floor-day are cached in Redis for 30 seconds, keyed by
`(floor_id, window, filter_hash)` and invalidated on any booking write touching that floor. During the
Monday spike this converts a thundering herd of identical reads into one query (§19).

### 10.2 Booking write path

1. Resolve and validate the request; reject unknown fields.
2. Idempotency: look up `(org, actor, Idempotency-Key)`. A hit replays the stored response verbatim.
3. Load the context in one round trip (resource, site, policies, the subject's bookings for the window).
4. Evaluate the rule pipeline. Any `block` → `422` with the full list of reason codes.
5. `INSERT`. An `ExclusionViolation` → `409 resource_unavailable` with the suggested next-best
   resource, computed from the same availability query so the client can offer a one-tap alternative.
6. Write the outbox event in the same transaction (§15.1). Commit.
7. Return `201` with the booking. Push notifications and attendee invitations follow asynchronously.

Multi-day and recurring bookings (FR-2.6, FR-2.7) expand to N individual bookings sharing a
`series_id`, inserted in one transaction with `ON CONFLICT DO NOTHING` semantics per day: the response
reports exactly which days succeeded and which were unavailable, rather than failing the whole batch.
Partial success is the correct behavior here — a user booking four Tuesdays does not want all four
rejected because the second is full.

### 10.3 Auto-assign (FR-2.9)

Scored selection, not clever optimization: `score = w1·team_proximity + w2·past_preference +
w3·attribute_match + w4·quiet_neighborhood`, where team proximity is the plan-space distance to the
nearest colleague already booked that day. Weights are constants in config so they can be tuned per
customer without a deploy. Ties break deterministically by resource code to keep the result stable
across retries.

---

## 11. API design

REST over HTTPS, JSON, versioned by path prefix (`/v1`). OpenAPI 3.1 generated by FastAPI is the
contract of record and generates the mobile client in CI.

**Conventions**

- `Idempotency-Key` required on all booking mutations; 24-hour replay window.
- Cursor pagination (`?cursor=&limit=`), never offset — floor and booking lists grow.
- Errors are RFC 9457 `application/problem+json`, extended with the fields the client localizes:

```json
{
  "type": "https://api.<domain>/errors/policy-violation",
  "title": "Booking not permitted",
  "status": 422,
  "detail": "Booking exceeds the 14 day horizon",
  "violations": [
    {"code": "policy.horizon_exceeded", "params": {"max_days": 14}, "severity": "block"},
    {"code": "policy.quota_reached",    "params": {"used": 3, "max": 3, "period": "week"}, "severity": "block"}
  ],
  "trace_id": "01J..."
}
```

`detail` is a developer-facing English string. The app renders from `code` + `params` only — no
server-generated prose ever reaches a user, which is what makes FR-10.4 and FR-6.9 compatible.

**Representative surface**

```
POST   /v1/auth/discover              {email} → tenant + idp hint       (FR-1.3)
POST   /v1/auth/token                 authorization_code + PKCE → tokens
POST   /v1/auth/refresh               rotating refresh token
POST   /v1/auth/magic-link            request | verify                  (FR-1.2)

GET    /v1/me                         profile, roles, home site, feature flags
PATCH  /v1/me                         locale, presence_visibility, defaults
PUT    /v1/me/devices/{id}            push token registration

GET    /v1/sites                      GET /v1/sites/{id}/floors
GET    /v1/floors/{id}/availability   ?date=&slot=&filters=             (§10.1)
GET    /v1/floors/{id}/plan           signed CDN url + dimensions

POST   /v1/bookings                   single, multi-day, or series      (FR-2.2, 2.6, 2.7)
GET    /v1/bookings                   ?from=&to=&user_id=
PATCH  /v1/bookings/{id}              move, resize, reassign
DELETE /v1/bookings/{id}              cancel (cut-off enforced)
POST   /v1/bookings/{id}/checkin      {method, geofence_pass, client_ts} (FR-4.1, 4.2)
POST   /v1/bookings/{id}/checkout
POST   /v1/checkin/scan               {qr_payload} → check in or walk-up book (FR-4.6)

GET    /v1/rooms/availability         ?site=&from=&to=&capacity=&amenities=
POST   /v1/rooms/{id}/bookings        with attendees                    (FR-3.2, 3.3)
GET    /v1/rooms/{id}/timeline        ?date= → day timeline             (FR-3.2)
GET    /v1/rooms/find                 ?capacity=&within_minutes=        (FR-3.5)
POST   /v1/bookings/{id}/attendees    invite internal users or guests   (§7.4)
PUT    /v1/bookings/{id}/attendees/me accept | decline | tentative      (§7.4)

GET    /v1/presence                   ?site=&date= → who's in           (FR-5.1)
GET    /v1/users/{id}/presence        subject to visibility             (FR-5.2, 5.6)
PUT    /v1/absences/{date}            remote | leave | travel           (FR-5.5)
GET    /v1/groups/{id}/week           team grid                         (FR-5.4)

# admin
POST   /v1/admin/sites | floors | zones | resources        (+ bulk variants)
POST   /v1/admin/resources/bulk       CSV or JSON array    (FR-8.3)
POST   /v1/admin/floors/{id}/plan     upload + place
GET    /v1/admin/policies             PUT /v1/admin/policies/{id}
POST   /v1/admin/qr/sheets            → async job → PDF    (FR-8.7)
GET    /v1/admin/analytics/utilization ?group_by=          (FR-9.1)
GET    /v1/admin/audit                                     (FR-8.8)
```

**Presence visibility is enforced in the query, not the serializer.** A user with
`presence_visibility='nobody'` is absent from `/v1/presence` results entirely — they are not returned
with a `hidden: true` flag for the client to respect. This is a privacy control (Q6), and privacy
controls that depend on client cooperation are not controls.

---

## 12. Identity, authentication, and permissions

### 12.1 Flow

The API acts as the OIDC **relying party**; the app never talks to the customer's IdP directly. This
keeps multi-tenant IdP configuration server-side, avoids shipping per-customer client secrets in a
binary, and means adding SAML later (FR-1.7) changes nothing in the app.

```
app → POST /v1/auth/discover {email}         → {org_id, idp_kind, authorize_url}
app → system browser (expo-auth-session, PKCE)
    → /v1/auth/authorize?org=…&code_challenge=…
    → customer IdP (Entra / Google)
    → /v1/auth/callback  (server validates ID token, provisions/links user)
    → redirect to deskflow://auth/callback?code=…
app → POST /v1/auth/token {code, code_verifier} → access + refresh
```

- Access token: JWT, 15 minutes, claims `{sub, org_id, roles[], site_scopes[], ver}`.
- Refresh token: opaque, 30 days, **rotating with reuse detection** — a replayed refresh token
  revokes the whole family and forces re-auth (FR-1.4).
- Stored in `expo-secure-store` (Keychain / Android Keystore). With no MAM requirement (Q2), this is
  the appropriate ceiling.
- Admin revocation bumps `users.token_version`; the `ver` claim mismatch invalidates live access
  tokens within their 15-minute window.
- Magic link (FR-1.2): single-use, 10-minute TTL, hashed at rest, rate-limited per email and per IP,
  and it must not reveal whether an address exists.

### 12.2 Authorization

Two layers, both mandatory:

1. **Tenant isolation** — Postgres RLS (§18.2). Structural, not conditional on application code.
2. **Role and scope checks** — a FastAPI dependency `require(permission, scope)` resolving
   `role_assignments`. Permissions are named capabilities (`booking.create_for_others`,
   `resource.manage`, `analytics.view`, `policy.manage`), mapped from roles in one table so customer-
   specific role variations do not become scattered `if role ==` checks.

Site-scoped admin is real: a Site Admin for Berlin gets nothing in London. Scope is checked against
the target object's `site_id`, resolved server-side from the object — never from the request body.

---

## 13. Mobile application architecture

### 13.1 Structure

```
apps/mobile/src/
├── app/                  # expo-router routes
│   ├── (auth)/           # discover, idp handoff, magic link
│   ├── (tabs)/           # home · book · team · me
│   ├── booking/[id].tsx
│   ├── floor/[id].tsx    # floor plan viewer
│   └── scan.tsx          # QR check-in
├── features/             # booking, presence, checkin, rooms — hooks + components per feature
├── lib/                  # api client, auth, offline queue, time, analytics
├── ui/                   # design system primitives
└── i18n/                 # en, de, fr, es
```

Server state is TanStack Query only. There is no Redux-style global store; the small amount of true
client state (filters, selected date, map viewport) lives in Zustand or React context per feature.
The generated `@repo/api-client` is the only module permitted to call `fetch`.

### 13.2 Offline behavior — a deliberate asymmetry

**Reads are cached; writes are not queued, with exactly one exception.**

- Cached and available offline: today's and upcoming bookings, the user's sites/floors/plans,
  the resource list for cached floors, the user's profile (FR-10.1).
- **Booking is never performed offline.** Availability is a contended, server-arbitrated resource
  (§6.4). An offline "booking" would show a confirmation we cannot honor, and the user discovers
  the lie when they arrive at an occupied desk. Offline, the booking button explains why it is
  disabled. This is a product decision made on technical grounds and it belongs in the PRD's
  behavior spec.
- **Check-in is queued.** It is idempotent, it is scoped to a booking the user already holds, and
  poor connectivity is at its worst exactly where check-in happens (lift lobbies, car parks, basements).
  Queued check-ins carry `client_ts`, replay on reconnect, and the server accepts any within the
  check-in window (FR-4.3) based on `client_ts` rather than arrival time.

The queue is a small persisted FIFO in MMKV with capped retries and a visible pending state — not a
general-purpose sync engine. Resisting the urge to build one is the point.

### 13.3 Floor plan renderer

The one performance-sensitive screen. Target: 300+ desks, 60fps pan/zoom, <1s first render (PRD §9.1).

- The plan image is a pre-rendered raster (PDFs are rasterized server-side at upload into 1x/2x/3x
  tiles-or-single-image variants) served from the CDN and cached on device. The client never parses PDF.
- One `<Svg>` scene; the whole scene is transformed by a single `reanimated` shared value driving a
  group `transform`. **Per-node React re-renders during gesture are forbidden** — the gesture never
  crosses the JS bridge.
- Desks render as primitive shapes from a flat array, memoized, keyed by id. Labels and amenity icons
  are culled below a zoom threshold; below that, desks are dots.
- **Hit testing is not per-node `onPress`.** A single tap handler on the canvas inverse-transforms the
  touch point into plan space and queries a uniform spatial grid (bucket size ≈ 3 desk widths) built
  once per floor. This is O(1) per tap and keeps the SVG tree free of hundreds of touch responders.
- State-driven fill colors come from a palette with a non-color redundancy (shape/icon), because
  colour alone cannot carry availability state accessibly.
- **The list view (FR-2.4) is a first-class equal, not a fallback.** It is what screen-reader users
  get, and it is what renders while the plan image is still downloading. Every action reachable on
  the plan is reachable in the list (FR-10.5).

### 13.4 Native integration points

| Capability | Module | Notes |
|---|---|---|
| QR scan | `expo-camera` | Contextual permission at first scan, with a clear purpose string |
| Push | `expo-notifications` + Expo Push | Token registered per device (§6.1); categories for actionable check-in |
| Geofence | `expo-location`, foreground only | §8.2; no background location in v1 |
| Secure storage | `expo-secure-store` | Tokens only |
| Biometrics | `expo-local-authentication` | FR-1.5, optional per org, gates app reopen only |
| Calendar | `expo-calendar` | Optional local "add to my phone calendar" (§7.4). Device-local write; no server integration exists |
| Deep links | `expo-router` + universal/app links | `deskflow://` plus verified `https://` links for QR and email |

### 13.5 Build and release

- EAS Build; Continuous Native Generation (`expo prebuild`) — `ios/` and `android/` are build
  artifacts and are gitignored.
- Channels: `development`, `preview` (internal TestFlight / Play internal), `production`.
- **EAS Update policy (FR-10.7):** JS-only fixes ship over the air on the production channel;
  anything touching native config goes through the stores. Updates are gated on a runtime-version
  match so an OTA can never land on an incompatible binary. Every OTA is logged and reversible.
- Minimum supported: iOS 16, Android 10. Sentry for crash reporting, with source maps uploaded per build.

---

## 14. Admin console and the floor plan editor

### 14.1 Console

Next.js App Router, server components for the data-heavy tables, the same generated API client.
Auth reuses the API's OIDC flow with a browser session cookie. Nothing in the admin console talks to
the database directly — it is a first-class API consumer, which keeps the API honest.

### 14.2 Plan coordinate space

Desk positions are stored as **normalized floats in `[0,1]`** relative to the plan image's intrinsic
dimensions, not pixels. Re-uploading a higher-resolution scan of the same floor therefore does not
invalidate placements. `floors.plan_width_px/height_px` are retained for aspect-ratio correction, and
a plan replacement that changes aspect ratio prompts the admin to re-verify rather than silently
distorting positions.

### 14.3 Editor

The editor is a small CAD-ish tool and is consistently the most underestimated part of this product
(PRD §11 sequencing note). Minimum viable feature set:

- Upload image or PDF → server rasterizes and returns dimensions.
- Place desks by click; drag to move; shift-drag to marquee-select; arrow keys to nudge.
- **Bulk creation is the primary path**, not a convenience: drag a rectangle, specify rows/columns and
  a naming pattern (`4F-A-{01..24}`), and get a grid of correctly named desks in one action. An admin
  placing 300 desks individually will abandon onboarding (PRD risk R5).
- Multi-select → set attributes on all selected.
- Draw zone polygons; assign group permissions.
- Draft vs published state per floor: edits are invisible to employees until published, and
  publishing a floor that would orphan existing bookings warns with the affected count.
- Undo/redo over a local command stack; save is an explicit, batched `PUT`.

---

## 15. Background work and notifications

### 15.1 Transactional outbox

Every side effect that must follow a state change — push, email, attendee invitation — is written to
the `outbox` table **in the same transaction as the change**, then delivered by workers. This is what
prevents the classic failure of a booking that exists but whose notifications silently never happened.
It is also the seam a calendar projection would re-enter through if it were ever required (§7.5). Delivery is at-least-once; every consumer is idempotent.

Workers claim with `FOR UPDATE SKIP LOCKED`, exponential backoff on failure, and a dead-letter state
that raises an alert rather than retrying forever.

### 15.2 Scheduled jobs

| Job | Cadence | Purpose |
|---|---|---|
| `no_show_sweeper` | 60s | §8.3 auto-release |
| `checkin_reminders` | 5 min | pre-start and pre-deadline pushes (FR-4.5, FR-7.1) |
| `evening_digest` | hourly, fires per site at local 18:00 | tomorrow's booking reminder |
| `analytics_rollup` | nightly per site, after local midnight | §16 |
| `retention_purge` | daily | PRD FR-9.7 |
| `assigned_desk_release` | nightly | release owned desks for declared absences (FR-6.7) |

Anything "per site at local time" is scheduled by computing the next UTC instant from the site's
timezone, never by assuming a fixed offset (§5).

### 15.3 Notification delivery

One `Notification` domain event → a fan-out resolver that consults `notification_prefs` (FR-7.4) and
quiet hours in the user's site timezone (FR-7.6), then dispatches per channel. Push and email senders
sit behind interfaces so the Expo Push Service can be swapped for direct APNs/FCM without touching
business logic. The email sender optionally attaches a generated `.ics` for room bookings (§7.4). Every notification carries a deep link (FR-10.3).

---

## 16. Analytics

Dashboards never query the `bookings` table directly. A nightly rollup produces:

```sql
fact_daily_resource_usage(organization_id, site_id, floor_id, zone_id, resource_id, local_date,
                          booked_minutes, checked_in_minutes, booking_count, no_show_count)
fact_daily_site_usage(organization_id, site_id, local_date, capacity, booked, checked_in,
                      unique_users, no_show_rate)
```

Three reasons this matters beyond speed:

1. Dashboards stay fast as history grows (FR-9.1–9.4).
2. **Retention purge (FR-9.7) can delete identifiable booking rows while the aggregates survive**,
   which is what makes a 13-month default retention compatible with multi-year utilization trends.
3. Manager-facing views (FR-9.5) read from aggregates by construction, so the "no per-person
   attendance reporting" product stance is enforced by the data path, not by discipline.

Product telemetry (time-to-booking for G1, funnel abandonment) is a separate client event stream —
the funnel cannot be reconstructed from the database after the fact, so it ships in Phase 1, not later.

---

## 17. Infrastructure, environments, CI/CD

- Containerized API and workers; managed Postgres with PITR; managed Redis; S3 + CDN.
- Environments: `dev` (ephemeral per PR for the API), `staging` (full, seeded, the demo environment),
  `production`. Mobile maps to the three EAS channels.
- IaC in `infra/`; no console-made production changes.
- Migrations run as a separate pre-deploy step under a migration role. **Expand/contract only**: add
  nullable, backfill, switch reads, then drop in a later release. A migration that locks `bookings`
  during the Monday peak is an outage.
- CI on every PR: lint, typecheck, Python tests, JS tests, **OpenAPI diff** (a breaking change fails
  unless the PR declares it), regenerate and verify the TS client, build the Expo app for both platforms.
- EU data residency (PRD Phase 4) is a regional data-plane deployment with `organizations.data_region`
  routing. Designing the tenant router now costs nothing; retrofitting it later is a migration.

---

## 18. Security and privacy implementation

### 18.1 Baseline

TLS 1.3 everywhere; secrets in a managed store, never in env files in the repo; per-user and per-org
rate limits in Redis; strict CSP on the admin console; dependency and container scanning in CI;
PII scrubbed from logs by a structured-logging filter with an allowlist of loggable fields.

### 18.2 Tenant isolation

Row-level security is the primary control, because presence data about named employees leaking across
customers is the failure this product cannot survive.

```sql
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bookings
  USING (organization_id = current_setting('app.org_id')::uuid);
```

- The API connects as a role **without** `BYPASSRLS`; migrations use a separate owner role.
- A single FastAPI dependency opens the session and issues `SET LOCAL app.org_id = …` from the
  validated JWT, inside the request transaction. There is no code path that opens a session without it.
- Connection pooling: `SET LOCAL` is transaction-scoped, so a returned connection cannot leak tenant
  context to the next request. This constraint dictates transaction-mode pooling.
- **Automated cross-tenant tests**: a test fixture creates two orgs and asserts that every route
  returns 404/403 for the other tenant's object ids. New routes are added to this matrix
  automatically by enumerating the OpenAPI paths — an untested route fails CI.

### 18.3 Privacy mechanics

- Geofence: boolean + coarse bucket only; raw coordinates never transmitted or stored (§8.2).
- Presence visibility enforced in queries (§11).
- `org.settings.presence_enabled = false` removes the colleague features entirely for that tenant —
  the org-level kill switch from Q6, checked server-side and reflected as a feature flag in `/v1/me`.
- Retention: `retention_purge` deletes identifiable booking and check-in rows past the configured
  window, preserving aggregates (§16). Default 13 months.
- GDPR subject requests: an export endpoint assembling everything keyed to a user, and an erasure path
  that anonymizes historical bookings (`user_id` → a tombstone) rather than deleting rows, so
  utilization history stays correct.
- `audit_log` covers every admin action on another user's data.

---

## 19. Performance and scale

The load shape is not uniform traffic — it is a **spike at the start of the workweek in each timezone**,
plus a smaller one each morning at check-in time. Design and load-test for that shape specifically.

| Concern | Approach |
|---|---|
| Monday 08:00 availability reads | 30s Redis cache per (floor, window, filters) (§10.1); CDN for plan images; the cache converts the herd into one query |
| Booking write contention | No app locks; the exclusion constraint arbitrates. Losers get a 409 with a next-best suggestion, which is a better UX than a queue |
| Connection exhaustion | PgBouncer in transaction mode; the API holds connections only inside transactions |
| Sweeper and workers | `SKIP LOCKED` batching; workers scale independently of the API |
| Mobile cold start | Hermes, lazy routes, a skeleton home screen rendered from the persisted cache before the network resolves |

Load test before Phase 1 exit: 5,000 users in one org, 60% of the week's bookings inside a 10-minute
window, verifying p95 latency (PRD §9.1) **and** zero double-bookings under sustained contention.

---

## 20. Testing strategy

| Layer | Coverage |
|---|---|
| Policy rules | Exhaustive unit tests per rule; a table-driven matrix of rule combinations. This is where customer requirements accumulate, so it is where regression risk concentrates |
| Booking concurrency | Integration test firing N parallel bookings at one resource, asserting exactly one success. Runs on every PR, not nightly |
| Timezone correctness | Property tests across DST boundaries for every site-timezone helper (§5), including the 23- and 25-hour days |
| Tenant isolation | Automated cross-tenant matrix over all OpenAPI routes (§18.2) |
| API contract | OpenAPI diff gate + generated client compiles against the app |
| Mobile | Jest for logic; React Native Testing Library for flows; Maestro E2E on the critical path (sign in → book → check in) against a seeded staging environment |
| Accessibility | Automated checks plus a manual screen-reader pass on the booking and floor-plan flows each release (FR-10.5) |

---

## 21. Build order

Phase 0 and Phase 1 in dependency order. Items on the same line are parallelizable.

**Phase 0 — foundations (~3 weeks)**

1. Monorepo, docker-compose, CI skeleton.
2. Postgres schema through §6.4 including `btree_gist` and the exclusion constraint; RLS on from the
   first migration; seed script generating a realistic site (2 floors, 120 desks, 6 rooms).
3. FastAPI skeleton: session dependency with `SET LOCAL app.org_id`, problem+json error handler,
   OpenAPI export, generated TS client in CI.
4. OIDC RP flow end to end against one IdP ‖ Expo dev build installing on both platforms.
5. Observability: structured logs, traces, `/health`, error tracking.

*Exit:* a real phone signs in against the real API and lists seeded resources.

**Phase 1 — desk booking MVP (~7 weeks)**

6. Policy engine + the six P0 rules ‖ availability query + cache.
7. Booking service: create, cancel, multi-day, idempotency, 409 handling ‖ outbox + worker.
8. **Floor plan viewer and floor plan editor — start in week 1 and run the whole phase.** These are
   the long poles and they share the coordinate space (§14.2).
9. Mobile: home, date strip, list view, booking flow, my bookings, offline read cache.
10. Presence + absences + visibility enforcement.
11. Push and email notifications.
12. Admin: sites/floors/zones/resources CRUD, CSV import, user management, booking override.
13. Product telemetry for G1 and the booking funnel.
14. Load test at the spike shape; cross-tenant test matrix green.

*Exit:* a design-partner office runs on it for two weeks with no spreadsheet fallback.

With calendar integration gone, rooms are no longer a separate subsystem — they are the same booking
engine with a timeline view, an attendee list, and three extra policy rules (§7.3). The room *backend*
is days of work, not weeks; the remaining cost is UI. Consider pulling basic room booking forward into
Phase 1 alongside desks, and reserving Phase 2 for check-in (§8), find-a-room, and analytics.

---

## 22. Technical decisions still open

| # | Decision | Needed by | Leaning |
|---|---|---|---|
| T1 | Cloud provider and managed-Postgres vendor | Phase 0 day 1 | Whatever the team operates best; nothing here is vendor-specific |
| T2 | Expo Push Service vs direct APNs/FCM at launch | Phase 1 | Expo Push behind our own interface; revisit at scale |
| T3 | PDF rasterization service (server-side) | Phase 1, floor plan upload | A worker using a maintained library; keep it off the request path |
| T4 | Keep or drop the optional `.ics` email attachment and local "add to phone calendar" (§7.4) | Phase 2 | Keep both — one-way, zero maintenance, and attendees look at their calendar. Removing them changes nothing else |
| T5 | Recurrence representation: expanded rows vs RRULE + exceptions | Phase 3 (FR-2.7) | Expanded rows with `series_id` — simpler conflict semantics, and horizons are short |
| T6 | Waitlist holds table design | Phase 4 (FR-2.11) | Separate `booking_holds` with its own exclusion constraint (§6.4) |
| T7 | Analytics store: rollup tables in Postgres vs a separate OLAP store | Phase 3 | Postgres rollups; revisit only if a customer exceeds ~50 sites |
