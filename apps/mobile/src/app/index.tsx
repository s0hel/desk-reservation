import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

export default function Index() {
  const { ready, token } = useAuth();
  const theme = useTheme();

  if (!ready) {
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
  return <Redirect href={token ? "/(tabs)" : "/sign-in"} />;
}
