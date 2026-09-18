#!/usr/bin/env bash
# Drive the real app with Maestro (TDD §20), on iOS or Android.
#
#   bash scripts/e2e.sh                 # iOS simulator (default)
#   bash scripts/e2e.sh android         # Android emulator or attached device
#   bash scripts/e2e.sh android flows/02-book-a-desk.yaml
#
# Unlike `make test` / `make test-mobile`, this needs the whole stack up: Postgres with
# seed data, the API, and Metro serving the bundle. It fails fast with the missing piece
# named rather than as an inscrutable flow timeout.
#
# The flows themselves are platform-agnostic. Everything that genuinely differs between
# the two is decided here and passed in as APP_ID and LAUNCH_URL, so a flow never has to
# ask which platform it is on except for the handful of gestures that really do differ.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOWS="$ROOT/apps/mobile/.maestro"

PLATFORM="ios"
if [[ "${1:-}" == "ios" || "${1:-}" == "android" ]]; then
  PLATFORM="$1"
  shift
fi

# The installer appends this to the shell profile, which a non-interactive shell has
# not sourced.
export PATH="$PATH:$HOME/.maestro/bin"

if ! command -v maestro >/dev/null 2>&1; then
  echo "maestro not found. Install it with:" >&2
  echo "  curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi

if [[ "$PLATFORM" == "ios" ]]; then
  # Expo Go, not a development build: Xcode 16.2 cannot compile SDK 57 (see CLAUDE.md).
  if ! xcrun simctl list devices booted | grep -q '('; then
    echo "No booted iOS simulator. Start one, e.g.:" >&2
    echo "  open -a Simulator" >&2
    exit 1
  fi
  if ! xcrun simctl listapps booted 2>/dev/null | grep -q 'host.exp.Exponent'; then
    echo "Expo Go is not installed on the booted simulator. Install it with:" >&2
    echo "  cd apps/mobile && npx expo start --ios --go" >&2
    exit 1
  fi
  APP_ID="host.exp.Exponent"
  # Expo Go loads the bundle straight from Metro. The simulator shares the Mac's
  # loopback, so 127.0.0.1 is the Mac.
  LAUNCH_URL="exp://${METRO_HOST:-127.0.0.1}:8081"
else
  ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
  export PATH="$PATH:$ANDROID_HOME/platform-tools"
  if ! command -v adb >/dev/null 2>&1; then
    echo "adb not found. Install the SDK with:" >&2
    echo "  brew install --cask android-commandlinetools   (see README)" >&2
    exit 1
  fi
  DEVICE="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
  if [[ -z "$DEVICE" ]]; then
    echo "No Android device or emulator attached. Start one with:" >&2
    echo "  \$ANDROID_HOME/emulator/emulator -avd deskflow_api36 &" >&2
    exit 1
  fi
  APP_ID="com.deskflow.app"
  # Android runs the real dev build from `expo run:android`, not Expo Go — which also
  # means this stays true in Phase 2, when Expo Go stops being able to load the app.
  if ! adb -s "$DEVICE" shell pm list packages 2>/dev/null | grep -q "$APP_ID"; then
    echo "$APP_ID is not installed on $DEVICE. Build and install it with:" >&2
    echo "  cd apps/mobile && npx expo run:android" >&2
    exit 1
  fi
  # An emulator's name for this machine is 10.0.2.2; localhost would be the emulator.
  # A physical device needs the LAN address in METRO_HOST instead.
  if [[ -n "${METRO_HOST:-}" ]]; then
    HOST="$METRO_HOST"
  elif [[ "$DEVICE" == emulator-* ]]; then
    HOST="10.0.2.2"
  else
    echo "A physical device cannot reach Metro on localhost. Re-run with your LAN address:" >&2
    echo "  METRO_HOST=\$(ipconfig getifaddr en0) bash scripts/e2e.sh android" >&2
    exit 1
  fi
  # Use the same address the dev client uses to reach the Expo CLI. Loading from any
  # other address for the same server still works, but the client then fails to reach
  # the CLI and raises a LogBox warning — whose banner sits over the tab bar and
  # swallows taps on it, which reads as "the tab did nothing" rather than as a warning.
  LAUNCH_URL="deskflow://expo-development-client/?url=http%3A%2F%2F${HOST}%3A8081"
fi

# The bundle is fetched from Metro at launch; without it the app opens to an error
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

echo "Running the $PLATFORM suite against $APP_ID"
exec maestro test -p "$PLATFORM" \
  -e APP_ID="$APP_ID" \
  -e LAUNCH_URL="$LAUNCH_URL" \
  "${@:-$FLOWS}"
