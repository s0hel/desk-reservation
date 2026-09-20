import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useState } from "react";

import { AuthProvider, useAuth } from "@/lib/auth";
import { useHomeSite } from "@/lib/site";
import { type, useTheme } from "@/lib/theme";

export default function RootLayout() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Phase 1 persists this cache to disk for offline reads (TDD §13.2).
          queries: { staleTime: 30_000, retry: 1 },
        },
      }),
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          {/* Follows the system scheme; light is the default (see lib/theme.ts). */}
          <StatusBar style="auto" />
          <RootStack />
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Which routes exist is derived from whether we hold a token, rather than decided once
 * on mount in `index.tsx`.
 *
 * Deciding it once is not enough: signing out cleared the token but navigated nowhere,
 * so the app sat on the authenticated tabs with every field blanked and no way back to
 * sign-in short of relaunching. The same hole opens whenever the refresh token is
 * rejected mid-session. A guard closes both, because unmounting the screen you are on
 * is what forces the navigation.
 *
 * The same rule covers the first-run home-site step (FR-1.9): it is a guarded route,
 * not a redirect fired from an effect. `needsChoosing` stays false while the sites
 * are still loading, so a user who already has a home office never sees the picker
 * flash past on a cold start.
 *
 * Separate from AuthProvider on purpose — useAuth has to run under the provider.
 */
function RootStack() {
  const { token } = useAuth();
  const { needsChoosing } = useHomeSite();
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.ground },
        headerTintColor: theme.color.accentText,
        headerTitleStyle: { ...type.heading, color: theme.color.ink },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.color.ground },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Protected guard={!token}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      {/* Before the tabs, and mutually exclusive with them: the tabs are all about
          one site, and there is no honest thing for them to show until we know which.
          Ordered first so it wins the initial route when both could match. */}
      <Stack.Protected guard={!!token && needsChoosing}>
        <Stack.Screen name="pick-home-site" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!token && !needsChoosing}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pick-floor" />
        <Stack.Screen name="floor/[id]" />
        <Stack.Screen name="colleague/[id]" />
      </Stack.Protected>
    </Stack>
  );
}
