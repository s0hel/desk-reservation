# Admin console

Next.js App Router, TypeScript. A first-class API consumer with no database access of
its own (TDD §14.1) — any capability this has, an integration could have too.

```bash
cp .env.example .env.local     # API_BASE_URL
pnpm dev                       # http://localhost:3000
pnpm test                      # vitest, src/lib
pnpm typecheck
```

Needs the API up (`make up && make api` from the repo root) and an admin account:
`dana.okafor@example.com` (site_admin) or `sam.vasquez@example.com` (org_admin) from
`make seed`.

## The floor plan editor

`/floors/{id}` is a CAD-ish tool over one floor (TDD §14.3).

| | |
| --- | --- |
| Select (V) | Click, shift-click, marquee-drag; drag to move; arrow keys nudge (shift = coarse) |
| Place (P) | Click to drop one desk, named from the floor's own scheme |
| Grid (G) | Drag a rectangle, give rows/columns and a pattern, get a named block |
| Zone (Z) | Click points; Enter or click the start to close; assign group permissions |
| ⌘Z / ⇧⌘Z | Undo / redo, over a local command stack |
| ⌘S | Save the draft. Nothing autosaves |

Bulk creation is the primary path, not a shortcut: an admin placing 300 desks one at a
time abandons onboarding, and so does one who renames 300 afterwards (PRD risk R5). The
pattern's output and its clashes are shown before anything is created.

Nothing an admin does here is visible to employees until they press Publish. Publishing
shows what it would change first, including the bookings it would cancel, and cancels
those through the booking service so the people who lose a desk are told.

### Structure

`src/lib` holds everything that can be tested without a browser, and is where the real
logic lives — `naming.ts` (patterns), `geometry.ts` (plan-space maths), `editor-state.ts`
(the reducer and undo stack), `messages.ts` (reason codes → sentences). The components
under `src/components/editor` are presentational and thin on purpose. Every UI bug in
this repo so far passed typecheck, lint and unit tests and was found by a person driving
the app, so the split is deliberate: what can be tested, is.

The canvas sizes its element and lets the browser scroll it rather than applying a CSS
transform. A transformed surface needs an inverse transform to turn a click back into
plan coordinates, and that inverse is exactly what shipped wrong in the mobile viewer —
applied twice, which is the identity at zoom 1, so it looked perfect until the first
zoom.

### Not built

CSV import (FR-8.3), user and group management (FR-8.4), policy configuration (FR-8.5),
QR sheets (FR-8.7), and the audit log (FR-8.8). This is the floor plan editor and the
site/floor structure it needs (FR-8.1, FR-8.2), not the whole console.

## API it talks to

All under `/v1/admin`, requiring `site_admin` or `org_admin`:

```
GET    /v1/admin/floors/{id}            everything the editor needs, one round trip
PUT    /v1/admin/floors/{id}/layout     explicit batched save -> draft
DELETE /v1/admin/floors/{id}/draft      discard
POST   /v1/admin/floors/{id}/plan       multipart upload; rasterizes PDF, returns dimensions
GET    /v1/admin/floors/{id}/publish    preflight: what publishing would do, and break
POST   /v1/admin/floors/{id}/publish    {accept_orphans} -> applies in one transaction
GET    /v1/admin/floors/{id}/codes      codes taken elsewhere on this site
POST   /v1/admin/sites | sites/{id}/floors
GET    /v1/admin/groups                 for zone permissions
GET    /v1/plans/{asset_id}?t=<token>   the image, signed rather than bearer-authed
```

Two things about that contract worth knowing before writing the UI:

- **A draft is a whole document.** The editor reads one layout and writes one layout;
  there are no per-desk endpoints, deliberately (TDD §14.3 — the save is explicit and
  batched, which is also what makes undo coherent).
- **Nothing is live until publish.** Uploading a plan attaches it to the draft, not to
  the floor, so employees do not see a replacement plan before an admin has reviewed the
  aspect-ratio warning.
