import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";

export default function Today() {
  const { token, me } = useAuth();

  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: () => api.sites(token!),
    enabled: !!token,
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing(2) }}>
      <Text style={styles.hello}>Hi {me?.display_name?.split(" ")[0] ?? "there"}</Text>
      <Text style={styles.sub}>Phase 0 skeleton — booking arrives in Phase 1.</Text>

      {sites.data?.map((s) => (
        <View key={s.id} style={styles.card}>
          <Text style={styles.cardTitle}>{s.name}</Text>
          <Text style={styles.cardMeta}>{s.address}</Text>
          {/* All times render in the SITE's timezone, never the device's (TDD §5). */}
          <Text style={styles.cardMeta}>Timezone {s.timezone}</Text>
          <Text style={styles.cardMeta}>
            Check-in {s.checkin_enabled ? "enabled" : "disabled"}
          </Text>
          <Link href={{ pathname: "/(tabs)/spaces" }} style={styles.link}>
            Browse floors →
          </Link>
        </View>
      ))}

      {sites.isLoading ? <Text style={styles.sub}>Loading sites…</Text> : null}
      {sites.isError ? <Text style={styles.error}>{String(sites.error)}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hello: { color: colors.text, fontSize: 28, fontWeight: "700" },
  sub: { color: colors.muted, marginTop: spacing(0.5), marginBottom: spacing(2) },
  card: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 14, padding: spacing(2), marginBottom: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: "600", marginBottom: spacing(0.5) },
  cardMeta: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  link: { color: colors.accent, marginTop: spacing(1), fontWeight: "600" },
  error: { color: colors.danger },
});
