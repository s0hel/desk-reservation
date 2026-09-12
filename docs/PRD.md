# Product Requirements Document — Flex Workspace Booking

**Product codename:** `deskflow` (placeholder)
**Status:** Draft v0.1
**Owner:** TBD
**Last updated:** 2026-09-11

---

## 1. Summary

A mobile-first workplace booking product for employers that run flex-seating ("hot desking") corporate
offices. Employees use an iOS/Android app to see who's coming in, reserve a desk or a conference room,
check in on arrival, and find their colleagues. Workplace admins use a web console to model their
offices, set booking policies, and understand how space is actually used.

The competitive reference point is deskbird; the wedge is a genuinely good mobile experience plus
a fast, low-ceremony admin setup, targeted at mid-market employers (200–5,000 employees) who find
enterprise IWMS suites too heavy.

---

## 2. Problem statement

Employers moved to hybrid work and reduced desk-to-employee ratios. This creates three unsolved problems:

1. **Employees** don't know whether there will be a seat, whether their team will be in, or where to sit.
   Uncertainty pushes them to stop coming in, which defeats the purpose of the office.
2. **Workplace / facilities teams** have no reliable data on real occupancy. They over- or under-lease,
   and they can't justify either decision. Spreadsheets and Outlook room calendars don't reflect reality.
3. **Managers** can't coordinate in-office days for their team, so "coming to the office" produces
   an empty floor and a video call anyway.

Existing tooling is either (a) heavyweight IWMS/CAFM platforms with long implementations, or
(b) calendar room-booking that ignores desks, check-in, and utilization entirely.

---

## 3. Goals and non-goals

### 3.1 Goals

| # | Goal | Measured by |
|---|---|---|
| G1 | Make booking a desk take under 15 seconds from cold app open | p75 time-to-booking (instrumented) |
| G2 | Give employees a reason to come in (social/team signal) | % of bookings preceded by viewing a colleague/team view |
| G3 | Produce trustworthy utilization data | Check-in rate ≥ 70% of bookings; no-show auto-release working |
| G4 | Let an admin stand up a new office in under 60 minutes | Time from org creation to first published floor |
| G5 | Support both desks and rooms in one model | Both bookable from a single flow by GA |

### 3.2 Non-goals (v1)

- Not a full IWMS: no lease management, maintenance work orders, CAD round-tripping, or space planning.
- Not an access-control system: we do not open doors or replace badge readers (we may read their data later).
- Not a visitor-management product in v1 (v2 candidate — see §9.5).
- No parking, locker, or catering booking in v1 (v2 candidates; the resource model must not preclude them).
- No standalone web app for employees in v1 beyond a minimal responsive fallback. Mobile is the product.
- No on-premise / self-hosted deployment.

---

## 4. Personas

**P1 — Hybrid employee ("Priya", IC, in office 2–3 days/week).**
Books from her phone on the commute or the night before. Cares about: is my team in, is there a desk
near them, is it a sit/stand desk with a dock. Will abandon anything that takes more than a few taps.

**P2 — Team lead ("Marcus").**
Needs the team co-located on chosen days. Wants to set an anchor day, see who's booked, and book
on behalf of a report or a new joiner. Books rooms for team ceremonies.

**P3 — Workplace/Facilities manager ("Dana").**
Owns the floor plans, the policies, and the utilization report she presents to Finance quarterly.
Needs bulk operations, not per-desk clicking. Is not technical.

**P4 — IT admin ("Sam").**
Owns SSO, provisioning, and data-privacy sign-off. Will block the rollout if SCIM/SAML/OIDC and a
DPA aren't there. Rarely uses the product day to day.

**P5 — Receptionist / front-of-house (v2).**
Uses a kiosk/tablet to check walk-ins in and find a seat for a visitor.

---

## 5. Assumptions and open questions

### 5.1 Assumptions (stated, to be confirmed)

- **A1.** Multi-tenant B2B SaaS. One deployment, many customer organizations, row-level tenant isolation.
- **A2.** Purchased by the employer; employees are provisioned, not self-signup. Per-seat or per-active-user pricing.
- **A3.** Company-managed identity exists (Google Workspace or Microsoft Entra ID covers the large majority
  of the target market). Email magic-link is the fallback for the long tail.
- **A4.** Employees use personal or corporate phones with the public App Store / Play Store build.
  No MDM-only private distribution required at launch (see R4 in §12).
- **A5.** Floor plans exist as images or PDFs. We place desks on top of them; we do not parse CAD/IFC.
- **A6.** Initial markets: US and EU. EU means GDPR, works-council sensitivity around presence data,
  and i18n from the start (English, German, French, Spanish).

### 5.2 Open questions

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| Q1 | Is the first customer a single design partner, or are we building for a market? | Prioritization of admin config depth | Build for a design partner, keep the model general |
| Q2 | Do we need Microsoft Intune / MAM app-protection wrapping? | Mobile stack (see §8.3) | No for v1 |
| Q3 | Do rooms need to be the source of truth, or mirror Exchange/Google Calendar? | Room architecture | Mirror the calendar; the calendar stays authoritative |
| Q4 | Is there an existing badge/access-control system whose swipe data we can ingest as check-in? | Check-in design | No; QR + geofence only |
| Q5 | Are assigned (permanently owned) desks in scope for v1? | Resource model | Yes — model it, ship the sharing behavior in Phase 3 |
| Q6 | Works-council / privacy posture on showing colleague presence | Colleague visibility features | Opt-out per user, org-level master switch |


### 5.3 Answer to Open Questions

Q1: Build for a design partner, keep the model general.
Q2: No for v1.
Q3: Rooms need to be the source of truth.
    **Revised 2026-09-11:** no Microsoft 365 / Google Calendar integration at all, in either
    direction. Room reservations happen only in the app. See TDD §7 — this removes the largest
    subsystem in the design; the one obligation that survives is making rooms unbookable in the
    corporate directory so they cannot also be booked from Outlook.
Q4: No; QR + geofence only.
Q5: Yes — model it, ship the sharing behavior in Phase 3.
Q6: Opt-out per user, org-level master switch.

---

## 6. Domain model (product-level, not schema)

```
Organization
 └── Site / Building              (address, timezone, opening hours, capacity cap)
      └── Floor                   (floor plan image, ordering)
           └── Zone / Neighborhood (a team's area; used for policies and search)
                ├── Desk          (bookable resource)
                └── Room          (bookable resource, has capacity + amenities)
```

- **Resource** is the generalization of Desk and Room, so parking spots, lockers and phone booths
  can be added later without a migration of the booking model.
- **Booking** is (resource, user, time range, status). Status: `pending` → `confirmed` → `checked_in`
  → `completed`, or `cancelled` / `released_no_show`.
- **Group** is a set of users (team, department, or arbitrary). Policies, zone permissions, and
  "who's in" views hang off groups.
- **Policy** attaches to an Organization, Site, or Group and constrains what bookings are legal.

---

## 7. Functional requirements

Requirements are labeled `FR-n.m`. Priority: **P0** = v1 must-ship, **P1** = v1 if time, **P2** = post-v1.

### 7.1 Identity, onboarding, access

| # | Requirement | Pri |
|---|---|---|
| FR-1.1 | SSO via OIDC with Google Workspace and Microsoft Entra ID, initiated from the mobile app | P0 |
| FR-1.2 | Email magic-link sign-in as fallback; domain-allowlist enforced per org | P0 |
| FR-1.3 | Domain-based org discovery: user enters work email, app resolves the tenant and routes to the right IdP | P0 |
| FR-1.4 | Session persists across app restarts; refresh-token rotation; remote session revoke by admin | P0 |
| FR-1.5 | Biometric re-auth (Face ID / fingerprint) to reopen the app, optional per org | P1 |
| FR-1.6 | SCIM 2.0 user/group provisioning and deprovisioning | P1 |
| FR-1.7 | SAML 2.0 for orgs whose IdP does not do OIDC well | P2 |
| FR-1.8 | Roles: Employee, Team Lead, Site Admin, Org Admin. Permissions are additive and site-scoped | P0 |
| FR-1.9 | First-run onboarding: pick home site, pick team, set default in-office days, enable notifications | P0 |

### 7.2 Finding and booking a desk

| # | Requirement | Pri |
|---|---|---|
| FR-2.1 | Home screen shows the next 7 days with per-day availability at the user's home site and their own bookings | P0 |
| FR-2.2 | Book a desk for a whole day, morning, afternoon, or a custom time range within opening hours | P0 |
| FR-2.3 | Interactive floor plan: pan, pinch-zoom, tap a desk to see details and book. Desks colored by state (free / booked / mine / unavailable / assigned) | P0 |
| FR-2.4 | List view as an equal alternative to the floor plan, sorted by relevance (near my team, my favorites, matching attributes) | P0 |
| FR-2.5 | Filter by attributes: sit/stand, monitor count, dock type, window, quiet zone, accessible, dual-screen | P0 |
| FR-2.6 | Multi-day booking in one flow (e.g. "Tue + Thu for the next 4 weeks") | P0 |
| FR-2.7 | Recurring bookings with an end date and an exceptions list; conflicts surfaced before confirmation | P1 |
| FR-2.8 | Favorite desks and zones; one-tap "book my usual" | P0 |
| FR-2.9 | Auto-assign: "just give me a seat" picks the best desk using team proximity + past preference | P1 |
| FR-2.10 | Book on behalf of another user (Team Lead and Admin only), with the delegate recorded | P1 |
| FR-2.11 | Waitlist when a day/zone is full; auto-offer on release with a time-boxed claim window | P2 |
| FR-2.12 | Modify or cancel a booking; cancellation free until the configured cut-off | P0 |
| FR-2.13 | Bookings must never double-allocate a resource; concurrent requests resolve deterministically | P0 |
| FR-2.14 | All times display in the site's local timezone, regardless of the phone's timezone | P0 |

### 7.3 Conference rooms

| # | Requirement | Pri |
|---|---|---|
| FR-3.1 | Browse rooms by site/floor with capacity, amenities (display, VC, whiteboard, phone), and photos | P0 |
| FR-3.2 | Book a room for a time range; show a day timeline of existing bookings | P0 |
| FR-3.3 | Invite attendees in-app: internal users get a push and an accept/decline invitation; the meeting appears on their home screen for that day. Guests may be invited by email | P0 |
| FR-3.4 | No external calendar integration. Rooms are bookable only in this product. Onboarding must make rooms unbookable in the customer's directory (remove or restrict the resource mailbox), because a room bookable in both systems will be double-booked and we cannot detect it (see TDD §7.2) | P0 |
| FR-3.5 | Find-a-room: "3 people, next 30 minutes, this floor" → instant-book the best fit | P1 |
| FR-3.6 | Room check-in; auto-release the room after N minutes without check-in | P1 |
| FR-3.7 | Extend or end a meeting early from the app, releasing the room | P1 |
| FR-3.8 | Room display / kiosk mode on a tablet outside the room | P2 |

### 7.4 Check-in and no-shows

| # | Requirement | Pri |
|---|---|---|
| FR-4.1 | QR check-in: scan a code on the desk or room to confirm arrival. Codes are per-resource and signed | P0 |
| FR-4.2 | Geofence check-in: if the user is inside the site geofence within the check-in window, offer one-tap check-in | P0 |
| FR-4.3 | Check-in window is configurable (default: from 30 min before start to 2 hours after) | P0 |
| FR-4.4 | Auto-release a booking not checked into by the deadline; notify the user; return the desk to the pool | P0 |
| FR-4.5 | Push reminder to check in, and a warning before auto-release | P0 |
| FR-4.6 | Scanning a QR on a free desk books it on the spot (walk-up booking) | P1 |
| FR-4.7 | Admin can disable check-in entirely per site (some cultures/works councils reject it) | P0 |
| FR-4.8 | Check out / end early, freeing the desk for the rest of the day | P1 |
| FR-4.9 | NFC tag check-in as an alternative to QR | P2 |

### 7.5 People, teams, and coordination

| # | Requirement | Pri |
|---|---|---|
| FR-5.1 | "Who's in" — see, per day, which colleagues are booked at a site | P0 |
| FR-5.2 | Search a colleague and see their upcoming office days (subject to their privacy setting) | P0 |
| FR-5.3 | Book a desk next to a specific colleague ("sit near Marcus") | P0 |
| FR-5.4 | Team view: a week grid of the team's planned presence, with the team's anchor days highlighted | P0 |
| FR-5.5 | Declare a working-from-home / remote / leave day without booking a desk, so the team grid is complete | P0 |
| FR-5.6 | Per-user privacy control: hide my presence from everyone except my team, or from everyone | P0 |
| FR-5.7 | Find a colleague on the floor plan once they're checked in | P1 |
| FR-5.8 | Team lead can set an anchor day and nudge the team to book it | P1 |

### 7.6 Policies and constraints

| # | Requirement | Pri |
|---|---|---|
| FR-6.1 | Booking horizon: how far ahead a user may book (e.g. 14 days), configurable per group | P0 |
| FR-6.2 | Max concurrent future bookings per user | P0 |
| FR-6.3 | Site capacity cap: hard limit on bookings per day, below physical desk count if desired | P0 |
| FR-6.4 | Zone permissions: a zone bookable only by named groups, or bookable by anyone after a cut-off time | P0 |
| FR-6.5 | Blackout dates and site closures (holidays, maintenance) block booking and cancel existing bookings with notice | P0 |
| FR-6.6 | Hybrid quota: minimum or maximum in-office days per week/month, with progress shown to the user | P1 |
| FR-6.7 | Assigned desks: a desk owned by a user, released to the pool automatically when the owner marks a day away | P1 |
| FR-6.8 | Cancellation cut-off and repeated-no-show consequences (warn, then restrict) | P1 |
| FR-6.9 | Policy evaluation is explainable: when a booking is refused, the app states which rule refused it | P0 |

### 7.7 Notifications

| # | Requirement | Pri |
|---|---|---|
| FR-7.1 | Push: booking confirmed, reminder the evening before, check-in reminder, auto-release warning, booking cancelled by admin | P0 |
| FR-7.2 | Email equivalents for users who have not installed the app | P0 |
| FR-7.3 | Optional one-way conveniences only: an `.ics` attachment on notification emails, and an in-app "add to my phone calendar" that writes a local device event. Neither syncs, and both are independently removable | P1 |
| FR-7.4 | Per-channel, per-type notification preferences | P0 |
| FR-7.5 | Slack and Microsoft Teams app: book, see the team's day, and receive reminders without leaving chat | P2 |
| FR-7.6 | Quiet hours honoring the user's site timezone | P1 |

### 7.8 Admin console (responsive web)

| # | Requirement | Pri |
|---|---|---|
| FR-8.1 | Create sites, floors, zones; upload a floor plan image or PDF | P0 |
| FR-8.2 | Visual floor-plan editor: drop desks onto the plan, name them in bulk (`4F-A-01..24`), set attributes, draw zones | P0 |
| FR-8.3 | CSV import for resources and for users | P0 |
| FR-8.4 | User and group management; role assignment; deactivate a user and release their bookings | P0 |
| FR-8.5 | Policy configuration UI, scoped to org / site / group, with a preview of who is affected | P0 |
| FR-8.6 | View and override any booking; create a booking for anyone; take a desk out of service with a reason | P0 |
| FR-8.7 | Generate, regenerate, and print QR codes as a sheet of labels (PDF) | P0 |
| FR-8.8 | Audit log of admin actions, exportable | P1 |
| FR-8.9 | Announcements pushed to employees at a site (e.g. "3rd floor closed Friday") | P2 |

### 7.9 Analytics

| # | Requirement | Pri |
|---|---|---|
| FR-9.1 | Utilization dashboard: bookings vs capacity vs checked-in, by site/floor/zone/day | P0 |
| FR-9.2 | Peak-day analysis and day-of-week patterns | P0 |
| FR-9.3 | No-show rate, by site and over time | P0 |
| FR-9.4 | Desk-level heat map on the floor plan showing frequency of use | P1 |
| FR-9.5 | Team attendance summary for a manager, aggregated — never a per-person timesheet | P1 |
| FR-9.6 | CSV / scheduled-email export of any report | P1 |
| FR-9.7 | Data retention control: purge identifiable booking history after N months, keep aggregates | P0 |

### 7.10 Cross-cutting app behaviors

| # | Requirement | Pri |
|---|---|---|
| FR-10.1 | Offline read: today's and upcoming bookings, plus the QR scanner, work with no connectivity. Check-in queues and syncs when back online | P0 |
| FR-10.2 | Optimistic UI on booking, with a clear rollback message if the server rejects | P0 |
| FR-10.3 | Deep links: a push or an email opens the exact booking or floor | P0 |
| FR-10.4 | Localization: en, de, fr, es at launch; all dates/times localized | P1 |
| FR-10.5 | Accessibility: WCAG 2.2 AA equivalent — screen-reader labels on every control, the floor plan has a fully usable list alternative, 4.5:1 contrast, dynamic type | P0 |
| FR-10.6 | Home-screen widget showing today's desk and a check-in button | P2 |
| FR-10.7 | Over-the-air updates for JS-only fixes without an app-store cycle | P1 |

---

## 8. Technical direction (constraints for the technical design)

The full technical design is a separate document. This section records the platform decisions the
product requirements depend on, and the constraints the design must respect.

### 8.1 Mobile: Expo is the right choice — with conditions

**Recommendation: build with Expo (React Native), using EAS Build development builds.**

Why it fits this product:

- Every native capability we need is available as a maintained Expo module or a config plugin:
  camera + barcode/QR scanning (`expo-camera`), push (`expo-notifications`), background geofencing
  (`expo-location` + `expo-task-manager`), secure token storage (`expo-secure-store`),
  biometrics (`expo-local-authentication`), calendar writes (`expo-calendar`), file/PDF handling,
  and OIDC/PKCE sign-in (`expo-auth-session`).
- The floor plan — the only genuinely demanding UI — is a pan/zoom SVG scene with a few hundred nodes.
  `react-native-svg` + `react-native-gesture-handler` + `reanimated` handle this on the UI thread
  at 60fps. This is not a case where we need a native rendering engine.
- One codebase for iOS and Android matters more than usual here, because the surface area is wide
  (booking, plans, scanning, admin overrides) and the team will be small.
- EAS Update gives us same-day JS fixes, which is valuable during an enterprise rollout where a bug
  blocks a customer's Monday morning.

**Conditions:**

1. **Use development builds, not Expo Go.** Expo Go cannot load the custom native code we need
   (QR scanning config, background location, push entitlements, any third-party module).
   Adopt Continuous Native Generation (`expo prebuild`) from day one and treat `ios/` and `android/`
   as build artifacts.
2. **Verify NFC and BLE only if they become requirements.** NFC check-in (FR-4.9) needs
   `react-native-nfc-manager` via a config plugin — it works, but it is a dev-build-only, entitlement-
   sensitive path and iOS background NFC reading is limited. Keep NFC as P2 and do not let it
   drive the architecture.
3. **Intune / MAM is out of scope (Q2 answered: no).** Public App Store and Play Store distribution
   only. If an enterprise customer later mandates Intune app-protection policies, treat the MAM SDK
   integration as a scoped engineering project, not a dependency install — it is the one genuinely
   painful path in this stack.

Where Expo would have been the wrong call — heavy 3D/AR, real-time video processing, deep OS
integration — is not where this product lives.

Supporting choices: Expo Router for file-based navigation, TanStack Query for server state and
offline cache, MMKV or SQLite for the offline store, and TypeScript throughout.

### 8.2 Backend: FastAPI + Postgres is a good fit

Also endorsed. The specific reasons it suits this problem, and the constraints that follow:

- **Booking is a reservation problem, and Postgres is unusually good at reservation problems.**
  `tstzrange` columns plus a `GIST` exclusion constraint make double-booking structurally impossible
  at the database level, rather than something the application has to get right under concurrency.
  This should be a non-negotiable in the technical design — FR-2.13 is enforced by the schema, not by
  application locks.
- Async FastAPI handles the notification fan-out and scheduled-sweep workload well; SQLAlchemy 2.0 async +
  Alembic for migrations; Pydantic v2 for the contracts.
- The OpenAPI schema FastAPI generates should drive a **generated TypeScript client** for the app, so
  the API contract cannot silently drift from the mobile code.
- Background work (reminders, auto-release sweeps, analytics rollups, report generation) needs a
  real worker and scheduler — Celery or ARQ with Redis — not in-process background tasks.
- Multi-tenancy: `organization_id` on every table, enforced centrally (Postgres row-level security is
  the strongest option and worth the setup cost given this is presence data about named employees).

### 8.3 Other platform constraints

- **Timezones:** store UTC, render in the *site's* timezone (FR-2.14). A booking's day boundary is
  defined by the site, not the device. This is a common source of correctness bugs; the design should
  call out a single canonical helper.
- **There is no calendar integration** (Q3, revised). Rooms are ordinary bookable resources in our
  own system. This removes what would have been the largest and highest-risk subsystem, and makes
  rooms cheap enough to build alongside desks rather than as a separate phase. The residual risk is
  organizational rather than technical: any room left bookable in Outlook or Google will eventually
  be double-booked, and we will not know. Directory lockdown is therefore an onboarding requirement
  (FR-3.4), and Outlook-habituated employees adopting a second tool for rooms is an adoption risk to
  validate with the design partner early.
- **Idempotency keys** on all booking-mutating endpoints, because mobile clients retry.
- **Observability from Phase 1:** structured logs, traces, and a booking-funnel event stream — we cannot
  measure G1/G3 retroactively.

---

## 9. Non-functional requirements

### 9.1 Performance

- Cold app start to interactive home screen: < 2.0s on a mid-tier Android device (p75).
- Floor plan first render with 300 desks: < 1.0s; pan/zoom sustained at 60fps.
- Booking write API p95 < 300ms; read endpoints p95 < 200ms.
- Support 5,000 concurrent users per org during the Monday 08:00 booking peak, which is the real
  load pattern: traffic is not uniform, it is a spike at the start of the workweek in each timezone.

### 9.2 Availability and reliability

- 99.9% monthly availability target for the API.
- Degraded mode: if push or email delivery is down, booking and check-in still work.
- RPO 5 minutes / RTO 1 hour; automated restore test quarterly.
- No booking is ever lost silently: every rejected write returns a reason the app can display (FR-6.9).

### 9.3 Security

- SSO-first; no password storage for SSO orgs.
- Encryption in transit (TLS 1.3) and at rest; secrets in a managed secret store.
- Tenant isolation verified by automated tests that attempt cross-tenant reads on every endpoint.
- Signed, rotatable QR payloads — a photographed QR code must not be replayable indefinitely from home.
- Rate limiting per user and per org; abuse protection on the magic-link endpoint.
- Annual penetration test; SOC 2 Type II readiness as a Phase 4 goal (enterprise buyers will ask).
- Mobile: tokens in the Keychain/Keystore, certificate pinning optional per org, no PII in logs.

### 9.4 Privacy and compliance

Presence data is data about where a named employee physically is, which makes this product more
privacy-sensitive than its feature list suggests. Requirements:

- GDPR: lawful basis documented, DPA available, EU data residency option, data-subject export and
  erasure flows, sub-processor list.
- Location is used only for geofence check-in, only while the app is in use unless the user opts into
  background, and the raw coordinates are never stored — only the boolean "inside the fence".
- Colleague visibility is opt-out per user and killable org-wide (FR-5.6), because European works
  councils will require it.
- Manager-facing analytics are aggregated; the product does not provide per-person attendance
  reporting for performance-management purposes (FR-9.5). This is a deliberate product position.
- Configurable retention with a default of 13 months for identifiable booking rows (FR-9.7).

### 9.5 Accessibility, i18n, and quality bars

- WCAG 2.2 AA-equivalent behavior in the mobile app; the floor plan always has an equivalent list path.
- Four launch languages; all strings externalized from the first line of code.
- Crash-free sessions ≥ 99.5%.
- Supported OS: iOS 16+, Android 10+ (covers >95% of corporate devices at launch).

---

## 10. Success metrics

**Adoption**
- ≥ 60% of invited employees activate (sign in + complete onboarding) within 30 days of an org going live.
- ≥ 45% weekly active among activated users after 8 weeks.

**Core loop**
- p75 time-to-booking < 15s (G1).
- ≥ 3 bookings per active user per fortnight.
- Booking abandonment (flow started, not completed) < 15%.

**Data quality**
- Check-in rate ≥ 70% of bookings within 60 days of enabling check-in.
- No-show auto-release reclaims ≥ 80% of uncheck-in desks before 11:00 local.

**Admin**
- Time from org creation to first published floor < 60 min (G4).
- ≥ 1 report exported per admin per month (proxy for the data being trusted).

**Business**
- Design-partner NPS ≥ 40; logo retention ≥ 90% at 12 months.

---

## 11. Phased delivery plan

Each phase ends in something shippable to a real user. Durations assume a small team
(2 mobile, 2 backend, 1 design, shared PM) and are estimates to be re-baselined after Phase 0.

### Phase 0 — Foundations (~3 weeks)
Repo and CI/CD for both app and API; Expo dev build running on both platforms; FastAPI skeleton with
Postgres and migrations; the tenant/site/floor/zone/resource/booking schema including the exclusion
constraint; OIDC sign-in end to end for one IdP; generated TS client; observability wired.
**Exit:** a developer can sign in on a real phone and read a seeded site from the real API.

### Phase 1 — Desk booking MVP (~7 weeks)
FR-1.1–1.4, 1.8, 1.9 · FR-2.1–2.6, 2.8, 2.12–2.14 · FR-5.1, 5.5, 5.6 · FR-6.1–6.3, 6.9 ·
FR-7.1–7.4 · FR-8.1–8.4, 8.6 · FR-10.1–10.3, 10.5.
The floor-plan editor and the floor-plan viewer are the long poles — start them in week 1.
**Exit:** a design-partner office runs on it for two weeks with no spreadsheet fallback.

### Phase 2 — Check-in, rooms, and trust in the data (~4 weeks)
FR-4.1–4.5, 4.7 · FR-3.1–3.4 · FR-8.7 · FR-9.1–9.3 · FR-2.9 · FR-5.3.
Shortened from six weeks: with no calendar integration, rooms reuse the desk booking engine entirely
and the remaining cost is UI (timeline view, attendee list, three policy rules). Basic room booking
could reasonably move into Phase 1.
**Exit:** utilization numbers the workplace manager is willing to show Finance.

### Phase 3 — Coordination and policy depth (~6 weeks)
FR-5.2, 5.4, 5.7, 5.8 · FR-6.4–6.8 · FR-2.7, 2.10 · FR-3.5–3.7 · FR-4.6, 4.8 · FR-9.4–9.6 ·
FR-8.5, 8.8 · FR-10.4, 10.7.
**Exit:** teams coordinate anchor days in-app; admins self-serve policy without support tickets.

### Phase 4 — Enterprise readiness and expansion (~8 weeks)
FR-1.5–1.7 (SCIM, SAML, biometrics) · FR-7.5 (Slack/Teams) · FR-2.11 (waitlist) · FR-3.8 (room kiosk) ·
FR-10.6 (widgets) · SOC 2 Type II program · EU data residency · visitor management and parking as the
next resource types.
**Exit:** passes an enterprise IT security review without custom engineering.

### Sequencing notes
- Ship check-in (Phase 2) before analytics depth: utilization data without check-in is booking data,
  and booking data overstates occupancy by 20–40%. Selling the earlier number damages trust.
- Do not let room booking slip past Phase 2. Buyers evaluate desks and rooms together even though
  employees use them separately.
- The admin floor-plan editor is consistently underestimated. It is a small CAD-ish tool and deserves
  its own design review.

---

## 12. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Rooms stay bookable in Outlook/Google, so the same room is booked in two systems | Physical double-booking we cannot detect, and blame lands on us | Directory lockdown is a hard onboarding gate (FR-3.4), verified and signed off before go-live; admin console states the requirement; validate Outlook-habit adoption with the design partner in week one |
| R2 | Employees don't check in, so utilization data stays unreliable | Kills the core value prop for the buyer | Make check-in one tap and hard to miss; geofence as the default path; measure weekly |
| R3 | Works councils or privacy reviews block presence features in EU | Loses the coordination differentiator in a core market | Opt-out and org kill-switch built in from Phase 1; aggregate-only manager analytics as a product stance |
| R4 | ~~Intune MAM~~ *(resolved: out of scope, §5.3)*. Residual: a later customer mandates MDM-only distribution | Weeks of unplanned mobile work | Re-open as a scoped project if it appears; do not pre-build for it |
| R5 | Floor-plan authoring friction stalls onboarding | Long time-to-value, churn before habit forms | Invest in bulk desk placement and CSV import; offer a white-glove first-office setup |
| R6 | Monday-morning booking spike causes contention or double-book bugs | Visible failure at the worst moment | DB-level exclusion constraints; load-test the spike shape specifically, not average load |
| R7 | Commoditization — deskbird and incumbents are established | Pricing pressure | Compete on mobile quality and setup speed; stay out of full IWMS scope |

---

## 13. Out of scope for v1 (recorded so it stays out)

**Microsoft 365 / Google Calendar integration in any direction** · lease/portfolio management ·
CAD/BIM import · maintenance ticketing · door access control · badge hardware · sensor-based
occupancy (IoT) · catering · cleaning workflows · parking · lockers · visitor management ·
desk-level environmental data · self-serve credit-card signup · on-premise deployment · a full
employee web app.

Several of these (parking, lockers, visitors, sensors) are natural extensions and the resource
and booking model must be general enough to absorb them without a rewrite.

---

## 14. Next steps

1. ~~Answer Q1–Q6~~ — answered in §5.3, with Q3 subsequently revised to "no calendar integration".
2. Confirm priorities in §7; anything marked P0 that isn't truly must-ship should be demoted now.
3. Produce the Technical Design Document: data model and constraints, API surface, auth flows,
   floor-plan rendering and authoring, offline/sync strategy, infrastructure and environments.
   *(Done — see [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md).)*
4. Build the Phase 0 skeleton and re-baseline the estimates against real velocity.
