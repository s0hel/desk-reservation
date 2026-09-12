#!/usr/bin/env bash
# Drive the real app in the iOS simulator with Maestro (TDD §20).
#
# Unlike `make test` / `make test-mobile`, this needs the whole stack up: Postgres with
# seed data, the API, and Metro serving the bundle into Expo Go. It fails fast with the
# missing piece named rather than as an inscrutable flow timeout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOWS="$ROOT/apps/mobile/.maestro"

# The installer appends this to the shell profile, which a non-interactive shell has
# not sourced.
export PATH="$PATH:$HOME/.maestro/bin"

if ! command -v maestro >/dev/null 2>&1; then
  echo "maestro not found. Install it with:" >&2
  echo "  curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi

if ! xcrun simctl list devices booted | grep -q '('; then
  echo "No booted iOS simulator. Start one, e.g.:" >&2
  echo "  open -a Simulator" >&2
  exit 1
fi

# Expo Go, not a development build: Xcode 16.2 cannot compile SDK 57 (see CLAUDE.md).
if ! xcrun simctl listapps booted 2>/dev/null | grep -q 'host.exp.Exponent'; then
  echo "Expo Go is not installed on the booted simulator. Install it with:" >&2
  echo "  cd apps/mobile && npx expo start --ios --go" >&2
  exit 1
fi

# The bundle is fetched from Metro at launch; without it Expo Go opens to an error
# screen and every flow fails on the first assertion.
if ! curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:8081/status; then
  echo "Metro is not running on :8081. Start it with:" >&2
  echo "  cd apps/mobile && npx expo start" >&2
  exit 1
fi

if ! curl -fsS -o /dev/null --max-time 5 "${API_URL:-http://127.0.0.1:8000}/health"; then
  echo "The API is not answering on :8000. Start it with:  make up && make api" >&2
  exit 1
fi

exec maestro test "${@:-$FLOWS}"
