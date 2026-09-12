import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { api, type Resource } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";

/**
 * The list view (FR-2.4) — a first-class equal of the floor plan, not a fallback.
 * It is what screen-reader users get and what renders while the plan image loads.
 * The SVG plan renderer lands in Phase 1 (TDD §13.3).
 */
export default function FloorScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { token } = useAuth();
  const [kind, setKind] = useState<"desk" | "room">("desk");

  const resources = useQuery({
    queryKey: ["resources", id, kind],
    queryFn: () => api.resources(token!, id, kind),
    enabled: !!token && !!id,
  });

  return (
    <>
      <Stack.Screen options={{ title: name ?? "Floor", headerBackTitle: "Spaces" }} />
      <View style={styles.screen}>
        <View style={styles.tabs}>
          {(["desk", "room"] as const).map((k) => (
            <Pressable
              key={k}
              onPress={() => setKind(k)}
              style={[styles.tab, kind === k && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: kind === k }}
            >
              <Text style={[styles.tabText, kind === k && styles.tabTextActive]}>
                {k === "desk" ? "Desks" : "Rooms"}
              </Text>
            </Pressable>
          ))}
        </View>

        <FlatList
          data={resources.data ?? []}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing(2) }}
          ListHeaderComponent={
            <Text style={styles.count}>
              {resources.data ? `${resources.data.length} ${kind}s` : "Loading…"}
            </Text>
          }
          renderItem={({ item }) => <ResourceRow resource={item} />}
        />
      </View>
    </>
  );
}

function ResourceRow({ resource }: { resource: Resource }) {
  const attrs = Object.entries(resource.attributes)
    .filter(([, v]) => v !== false && v !== 0 && v !== "none")
    .map(([k, v]) => (typeof v === "boolean" ? k.replace(/_/g, " ") : `${k.replace(/_/g, " ")} ${v}`));

  return (
    <View style={styles.row} accessible accessibilityLabel={`${resource.code}, available`}>
      <View style={styles.dot} />
      <View style={{ flex: 1 }}>
        <Text style={styles.code}>
          {resource.code}
          {resource.name ? ` · ${resource.name}` : ""}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {resource.kind === "room" ? `${resource.capacity} seats · ` : ""}
          {attrs.length ? attrs.join(" · ") : "no attributes"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: "row", gap: spacing(1), padding: spacing(2), paddingBottom: 0 },
  tab: {
    paddingVertical: spacing(1), paddingHorizontal: spacing(2), borderRadius: 999,
    borderWidth: 1, borderColor: colors.border,
  },
  tabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  tabText: { color: colors.muted, fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  count: { color: colors.muted, marginBottom: spacing(1) },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing(1.5),
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 12, padding: spacing(1.5), marginBottom: spacing(1),
  },
  // Availability is carried by more than colour — shape/label too (TDD §13.3).
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.free },
  code: { color: colors.text, fontWeight: "600" },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
