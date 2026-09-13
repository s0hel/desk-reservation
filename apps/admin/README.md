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

## Status — the floor plan editor is HALF BUILT

The backend is finished and tested (96 API tests). The console's pure logic is finished
and tested (41 vitest tests). **No pages or React components exist yet** — `pnpm dev`
will not start until `src/app/layout.tsx` and `src/app/page.tsx` are written.

Done, in `src/lib`:

| File | What it holds |
| --- | --- |
| `naming.ts` | `4F-A-{01..24}` pattern expansion, clash detection — the bulk-create path |
| `geometry.ts` | Plan-space maths: marquee rects, grid placement, group-clamped drags, polygon hit tests |
| `editor-state.ts` | The reducer and the snapshot-based undo stack |
| `types.ts` | Mirrors `services/api/app/services/layout.py` |

All three are pure and tested without a browser, deliberately: every UI bug in this repo
so far has been invisible to typecheck, lint and unit tests, so the logic that *can* be
tested is kept outside the components (see CLAUDE.md).

## What is left

1. **Session and API plumbing** — `src/lib/session.ts` (httpOnly cookie holding the
   access token), `src/app/api/session/route.ts` (POST → `/v1/auth/dev-login`, DELETE →
   clear), `src/app/api/proxy/[...path]/route.ts` (forward browser calls with the bearer
   token so no token ever reaches JS), `src/lib/api.ts` (server-side fetch),
   `src/lib/client.ts` (browser fetch through the proxy).
2. **Pages** — `layout.tsx`, `globals.css`, `sign-in/page.tsx`, `page.tsx` (sites and
   floors), `floors/[id]/page.tsx` (server component fetching `GET /v1/admin/floors/{id}`
   and rendering the editor).
3. **Editor components** — `Canvas` (plan image + desks + zones, pointer handling),
   `Toolbar` (select/place/zone/bulk tools, undo/redo, save, publish), `Inspector`
   (multi-select attribute editing), `BulkDialog` (drag a rect → rows/cols + pattern),
   `PublishDialog` (preflight, orphaned-booking count, aspect-ratio warning).
4. **Mobile** — render the published plan image behind the desks in
   `apps/mobile/src/components/FloorPlan.tsx`. It currently draws on a plain grey
   ground; `GET /v1/floors/{id}/availability` does not yet return the plan URL.

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
