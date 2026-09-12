import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { FlatList, StyleSheet, Text, View } from "react-native";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";

export default function Spaces() {
  const { token } = useAuth();

  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api.sites(token!), enabled: !!token });
  const siteId = sites.data?.[0]?.id;

  const floors = useQuery({
    queryKey: ["floors", siteId],
    queryFn: () => api.floors(token!, siteId!),
    enabled: !!token && !!siteId,
  });

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ padding: spacing(2) }}
      data={floors.data ?? []}
      keyExtractor={(f) => f.id}
      ListHeaderComponent={
        <Text style={styles.header}>{sites.data?.[0]?.name ?? "Loading…"}</Text>
      }
      ListEmptyComponent={<Text style={styles.sub}>No floors yet — run `make seed`.</Text>}
      renderItem={({ item }) => (
        <Link href={{ pathname: "/floor/[id]", params: { id: item.id, name: item.name } }} asChild>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.cardMeta}>
              Plan {item.plan_width_px}×{item.plan_height_px}px · positions are normalised 0–1
            </Text>
            <Text style={styles.link}>View resources →</Text>
          </View>
        </Link>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { color: colors.text, fontSize: 24, fontWeight: "700", marginBottom: spacing(2) },
  sub: { color: colors.muted },
  card: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 14, padding: spacing(2), marginBottom: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: "600" },
  cardMeta: { color: colors.muted, fontSize: 13, marginTop: spacing(0.5) },
  link: { color: colors.accent, marginTop: spacing(1), fontWeight: "600" },
});
