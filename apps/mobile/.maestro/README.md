# End-to-end flows

Maestro drives the real app, on **both** iOS and Android, from one set of flows. This is
the only layer that catches the bugs this app actually ships: every UI defect so far — an
inert `<Link>`, a double-corrected transform, a stretched date strip, a native crash on
tap — passed typecheck, lint and Jest, and was found by a person using the app. Component
tests can't close the gap either, because React Native Testing Library does not work under
Expo SDK 57 (see CLAUDE.md).

```bash
make up && make api                 # Postgres + seed data, API on :8000
cd apps/mobile && npx expo start    # Metro on :8081

make test-e2e                       # iOS simulator, via Expo Go
make test-e2e-android               # Android emulator or device, via the dev build
```

`scripts/e2e.sh` checks each of those is actually up and names whichever is missing.
A single flow: `bash scripts/e2e.sh android apps/mobile/.maestro/flows/02-book-a-desk.yaml`.

## One suite, two platforms

The flows are platform-agnostic. Everything that genuinely differs is decided by
`scripts/e2e.sh` and passed in, so a flow never asks what it is running on except for the
few gestures that really do differ:

| | iOS | Android |
| --- | --- | --- |
| `APP_ID` | `host.exp.Exponent` (Expo Go) | `com.deskflow.app` (the dev build) |
| `LAUNCH_URL` | `exp://127.0.0.1:8081` | `deskflow://expo-development-client/?url=…10.0.2.2:8081` |
| Signing out | `clearKeychain` | `clearState` |
| Leaving a pushed screen | the header button | the real back affordance |

iOS runs Expo Go because Xcode 16.2 cannot compile SDK 57 (CLAUDE.md); Android runs the
actual dev build, which is also what survives into Phase 2 when Expo Go stops being able
to load this app at all.

Two mechanisms carry the rest:

- **`when: platform:`** on a `runFlow`, for steps with no shared spelling
  (`subflows/go-back.yaml` is the whole of it, plus the sign-out in `open-app.yaml`).
- **Full-match regex with an optional group**, for labels that differ only in trailing
  platform chrome — `"Spaces(, tab.*)?"` matches Android's `Spaces` and UIKit's
  `Spaces, tab, 2 of 3`.

## What runs

| Flow | Covers |
| --- | --- |
| `01-sign-in` | Dev sign-in, token persistence, the sign-out route guard |
| `02-book-a-desk` | List view → book → the booking appears on Today → cancel |
| `03-floor-plan` | Tap-to-book on the plan: no native crash, and the hit test resolves to the right desk |

Flows are self-cleaning: each cancels what it booked, and `subflows/clear-day.yaml`
removes a leftover booking for the target day before booking again — without it a
half-finished run fails the next one with a one-desk-per-day policy refusal, which reads
like a broken test rather than dirty state.

The target day is derived at runtime (`subflows/pick-open-day.yaml`) because the seeded
site opens Mon–Fri: a hard-coded date would pass on Tuesday and fail on Saturday. It is
seeded from **the site's** current date, read back out of the floor header, not from this
machine's clock — a day is defined by the site's timezone and nothing else (TDD §5), and a
Mac an hour behind Berlin would otherwise aim a whole flow at yesterday.

Both flows book on **Floor 3**, because Floor 4 cannot be booked at all by the test user:
its zone is `exclusive` to a group Priya is not in, so every desk there answers
`policy.zone_not_permitted`. Worth knowing before reading a failure as a test bug — and
worth knowing that `make seed` creates no bookings whatsoever, so which desks are free is
whatever the database has accumulated. A `make db-reset` before a run makes these flows a
good deal more reproducible.

## Not covered

**Hit testing at scale ≠ 1.** Maestro has no pinch, and its `doubleTapOn` arrives as two
separate taps far outside the gesture handler's double-tap window — the app's single-tap
handler runs twice and nothing zooms. That is exactly where one shipped bug lived (the
detector was attached to the transformed view, so the inverse transform ran twice — the
identity at scale 1, wrong after the first pinch), so the maths stays covered by
`src/lib/__tests__/plan.test.ts`. Zoomed tapping still needs a human.

**CI.** These do not run in GitHub Actions. A runner would need an emulator or simulator,
Metro, Postgres and the API. Run them locally before shipping anything that touches
booking or the plan.

## Harness notes

Things that cost time to work out. None of them are app bugs.

- **Maestro matches the whole string, not a substring.** `"BERLIN HQ"` does not match an
  element reading `TUESDAY · BERLIN HQ`; `".*BERLIN HQ.*"` does. Every wildcard in these
  flows is load-bearing.
- **`clearState` signs you out on Android but not on iOS.** `expo-secure-store` uses the
  Keychain on iOS, which survives app relaunch *and* `clearState` — `clearKeychain` is the
  only way back to a signed-out app there. On Android the same library uses app storage,
  and `clearKeychain` does not exist.
- **Android: load the bundle from the same address the dev client uses for the CLI**
  (`10.0.2.2:8081` on an emulator). Loading from another address for the same server works,
  but the client then cannot reach the Expo CLI and raises a LogBox warning — whose banner
  sits across the bottom of the screen, over the tab bar, and silently swallows taps on it.
  Maestro reports the tap as COMPLETED and the app just stays where it was, which reads as
  a broken selector for as long as you let it.
- **The Android tab-tap swallow is intermittent across a whole-suite run, and it moves.**
  Each of the three flows passes on its own; a full `make test-e2e-android` run has been
  seen to drop one tab tap — a different flow's each time (`Me` in one run, `Spaces` in
  the next), always with the tap reported COMPLETED and the app still on the previous
  screen. That is the LogBox banner above: its height varies with how many lines the
  message wraps to, so whether a given tap lands in the overlap is luck. The `repeat`
  wrappers retry three times and usually absorb it. A single flow failing on a tab tap
  is this, not a regression — re-run that flow alone before believing otherwise. iOS has
  gone 3/3 every time, because Expo Go does not draw the banner.
- **`eraseText` drops keystrokes.** The email field is a controlled `TextInput`, so every
  key round-trips through JS and synthetic input outruns it; the deletes that get dropped
  reappear behind whatever is typed next (typing `zzz` into a field that looked empty
  produced `zzzcom`). The placeholder is not a reliable "empty" signal either. Retype until
  the value reads back — `subflows/open-app.yaml` does.
- **`back` is a no-op on iOS.** It is an edge swipe there: it reports success and does
  nothing on the floor screen, so the header button is the only way — and UIKit labels
  that button `"Back"`, not the previous screen's title. Android has a real back
  affordance. `subflows/go-back.yaml` holds both.
- **The tab bar is native**, so its accessibility text is the platform's own: UIKit's
  `"<title>, tab, <n> of <m>"`, Android's plain title.
- **A sheet's "Close" is its backdrop, and iOS hides it.** `components/Sheet.tsx` makes the
  whole backdrop a `Pressable` labelled "Close" and sets `accessibilityViewIsModal` on the
  sheet — which is correct, and means iOS drops every sibling, the backdrop included, from
  the accessibility tree. So that label is selectable on Android and invisible on iOS. Tap
  the backdrop *region* instead: the sheet is capped at 82% of the screen height, so a tap
  near the top always lands on it.
- **The floor screen's day strip is collapsed on arrival**, and its header doubles as the
  toggle — so expanding it is conditional (`subflows/select-day.yaml`). Tapping the header
  when the strip is already open closes it again, which presents as "the day was never
  there".
- **SVG children are not in the accessibility tree.** Desk nodes and their labels are
  invisible to selectors — deliberately, since the list view is what screen-reader users
  get (FR-2.4). Tap the plan by `id: floor-plan` plus a `point` percentage instead.
- **The plan does NOT map 1:1 onto that element**, whatever an older version of this file
  said. It opens at `fitScale = max(1, height / planHeight)`, which on a portrait phone is
  close to 2.8, scaled about the element's centre — so a desk seeded at `(x, y)` is nowhere
  near `(x%, y%)`, and the inherited coordinates were tapping empty space. The derivation
  and the worked numbers for both devices are in the header of `flows/03-floor-plan.yaml`.
  They agree to within half a percent because the two screens have nearly the same aspect;
  a very different screen needs its own.
- **`point` is element-relative with `id`, and does not work with a text selector.**
  `tapOn: {id: floor-plan, point: "37%,47%"}` measures within the element. The same `point`
  beside a `text:` selector does not activate the element at all — the tap reports
  COMPLETED and nothing happens.
- **`point` is never interpolated.** It is parsed before variables resolve, so
  `point: "${output.somePoint}"` reaches the coordinate parser verbatim and dies as
  `NumberFormatException`. Anything the plan is tapped by has to be a literal.
- **`evalScript` cannot hold a regex literal with an end-of-string anchor.** Maestro
  substitutes its own placeholders in the script body first, and the pattern dies as
  `SyntaxError: Expected an operand but found /` before a line of it runs. Parse by
  splitting instead — `subflows/pick-open-day.yaml` does.
- **Only what is on screen matches**, and `scrollUntilVisible` wants the match *fully*
  visible by default. A row that comes to rest against the bottom edge is found and never
  accepted, so the command scrolls forever past a desk it can already see. Pass
  `visibilityPercentage: 60` with `centerElement: true`.
- **A dev build's LogBox banner overlaps the tab bar** and silently swallows taps on it —
  Maestro reports COMPLETED and the app stays put, which reads as a broken selector. The
  banner's height varies with how many lines the message wraps to, so this is intermittent
  rather than consistent. Tab taps therefore retry until the destination appears. The
  banners come from a real render-phase state update in the app; once that is fixed, the
  retries can go back to single taps.
