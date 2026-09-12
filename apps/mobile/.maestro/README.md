# End-to-end flows

Maestro drives the real app in the iOS simulator. This is the only layer that catches
the bugs this app actually ships: every UI defect so far — an inert `<Link>`, a
double-corrected transform, a stretched date strip, a native crash on tap — passed
typecheck, lint and Jest, and was found by a person using the app. Component tests
can't close the gap either, because React Native Testing Library does not work under
Expo SDK 57 (see CLAUDE.md).

```bash
make up && make api          # Postgres + seed data, API on :8000
cd apps/mobile && npx expo start   # Metro on :8081
make test-e2e                # in another shell
```

`scripts/e2e.sh` checks each of those is actually up and names whichever is missing.
A single flow: `bash scripts/e2e.sh apps/mobile/.maestro/flows/02-book-a-desk.yaml`.

## What runs

| Flow | Covers |
| --- | --- |
| `01-sign-in` | Dev sign-in, token persistence, the sign-out route guard |
| `02-book-a-desk` | List view → book → the booking appears on Today → cancel |
| `03-floor-plan` | Tap-to-book on the plan: no native crash, and the hit test resolves to the right desk |

Flows are self-cleaning: each cancels what it booked, and `subflows/clear-day.yaml`
removes a leftover booking for the target day before booking again — without it a
half-finished run fails the next one with a one-desk-per-day policy refusal, which
reads like a broken test rather than dirty state.

The target day is derived at runtime (`subflows/pick-open-day.yaml`), because the
seeded site opens Mon–Fri: a hard-coded date would pass on Tuesday and fail on
Saturday.

## Not covered

**Hit testing at scale ≠ 1.** Maestro has no pinch, and its `doubleTapOn` arrives as
two separate taps far outside the gesture handler's double-tap window — the app's
single-tap handler runs twice and nothing zooms. That is exactly where one shipped bug
lived (the detector was attached to the transformed view, so the inverse transform ran
twice — the identity at scale 1, wrong after the first pinch), so the maths stays
covered by `src/lib/__tests__/plan.test.ts`. Zoomed tapping still needs a human.

**CI.** These do not run in GitHub Actions. A macOS runner would need a booted
simulator, Expo Go, Metro, Postgres and the API, and the whole thing would hinge on the
Expo Go fallback that Phase 2 removes anyway. Run them locally before shipping anything
that touches booking or the plan.

## Harness notes

Things that cost time to work out. All of them are Maestro/XCUITest behaviour, not app
bugs.

- **The app under test is Expo Go** (`appId: host.exp.Exponent`), loaded by
  `openLink: exp://127.0.0.1:8081`. Override the address with
  `-e EXPO_URL=exp://<lan-ip>:8081`.
- **`clearState` does not sign you out.** Tokens are in the Keychain via
  `expo-secure-store`, which survives app relaunch and reinstall. `clearKeychain` is
  what gets back to a signed-out app.
- **`eraseText` drops keystrokes.** The email field is a controlled `TextInput`, so
  every key round-trips through JS and XCUITest outruns it; the deletes that get
  dropped reappear behind whatever is typed next (typing `zzz` into a field that looked
  empty produced `zzzcom`). The placeholder is not a reliable "empty" signal either.
  Retype until the value reads back — `subflows/open-app.yaml` does.
- **`back` is a no-op here.** On iOS it is an edge swipe; it reports success and does
  nothing on the floor screen. Tap the header's back button (`"Spaces"` — the tab is
  `"Spaces, tab, 2 of 3"`).
- **The tab bar is native**, so its accessibility text is UIKit's
  `"<title>, tab, <n> of <m>"`, not the plain title.
- **SVG children are not in the accessibility tree.** Desk nodes and their labels are
  invisible to selectors — deliberately, since the list view is what screen-reader
  users get (FR-2.4). Tap the plan by `id: floor-plan` plus a `point` percentage
  instead; the viewport maps 1:1 onto normalized plan space at rest, so a desk seeded
  at `(x, y)` is at `(x%, y%)`.
- **Only what is on screen matches.** Use `scrollUntilVisible` for anything below the
  fold — the desk list is 60 rows.
