import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/lib/auth";
import { useHomeSite } from "@/lib/site";
import { useTheme } from "@/lib/theme";

/**
 * The entry route: a spinner, then one redirect into whichever stack the guards in
 * `_layout.tsx` have opened. It does not decide anything the guards do not — it names
 * the same three states in the same order, and a route it sent someone to that the
 * guard has closed would simply fail to resolve.
 */
export default function Index() {
  const { ready, token } = useAuth();
  const { needsChoosing, loading } = useHomeSite();
  const theme = useTheme();

  // Held here rather than redirecting early: sending someone to the tabs and then
  // yanking them to the picker one frame later is the flash the guard exists to
  // avoid, and `index` is the one screen that can wait without showing anything wrong.
  if (!ready || (token && loading)) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.color.ground,
        }}
      >
        <ActivityIndicator color={theme.color.accentText} />
      </View>
    );
  }
  if (!token) return <Redirect href="/sign-in" />;
  return <Redirect href={needsChoosing ? "/pick-home-site" : "/(tabs)"} />;
}
