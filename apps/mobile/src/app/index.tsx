import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";

export default function Index() {
  const { ready, token } = useAuth();

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  return <Redirect href={token ? "/(tabs)" : "/sign-in"} />;
}
