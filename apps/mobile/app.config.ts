import type { ConfigContext, ExpoConfig } from "expo/config";

// Everything static stays in app.json. This file exists for the two things a static
// config cannot express, both of them Android build concerns (TDD §13.5).
//
// 1. Cleartext HTTP. Android has refused plain-HTTP traffic by default since API 28,
//    and Expo only sets `usesCleartextTraffic` on the debug variant. Every EAS profile
//    but `development` builds the release variant, so an APK pointed at
//    `http://<lan-ip>:8000` installs, launches, loads its bundle — and then fails every
//    request. That is the same silent failure CLAUDE.md documents for `localhost` on a
//    physical device, wearing different clothes, and it reads as a broken app rather
//    than a build setting.
//
//    So the permission follows the address instead of standing open: it is granted
//    exactly when the configured API is itself cleartext. A production build against
//    https never carries it, and nobody has to remember to take it away.
//
// 2. A build that has no API address at all. `lib/api.ts` falls back to
//    `http://localhost:8000`, which is right on a simulator and meaningless in an APK —
//    localhost on a phone is the phone. On an EAS builder the variable comes from the
//    profile's `environment` (see eas.json), and if it is missing we fail the build
//    rather than ship the fallback: a named build failure costs minutes, an app that
//    signs in nowhere costs an afternoon.

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

if (process.env.EAS_BUILD === "true" && !apiBaseUrl) {
  throw new Error(
    `EXPO_PUBLIC_API_BASE_URL is not set for the "${process.env.EAS_BUILD_PROFILE}" build ` +
      `profile. It is inlined into the bundle at build time, so without it this build ` +
      `would ship pointed at http://localhost:8000 — which on a device means the device ` +
      `itself. Set it with:\n\n` +
      `  npx eas-cli env:create --environment ${process.env.EAS_BUILD_PROFILE} ` +
      `--name EXPO_PUBLIC_API_BASE_URL --value http://<your-lan-ip>:8000 --visibility plaintext\n`,
  );
}

// An unset value only reaches here off the builder, where lib/api.ts's localhost
// fallback is the correct guess — and is cleartext.
const usesCleartextTraffic = (apiBaseUrl ?? "http://localhost:8000").startsWith("http://");

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Deskflow",
  slug: config.slug ?? "deskflow",
  plugins: [
    ...(config.plugins ?? []),
    [
      "expo-build-properties",
      {
        android: {
          // TDD §13.5 puts the floor at Android 10; Expo's own default is API 24.
          minSdkVersion: 29,
          usesCleartextTraffic,
        },
      },
    ],
  ],
});
