import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View,
} from "react-native";

import { DateStrip } from "@/components/DateStrip";
import { api, newIdempotencyKey, ProblemError, type ResourceAvailability } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, toLocalDate } from "@/lib/dates";
import { describeAll } from "@/lib/messages";
import { colors, spacing } from "@/lib/theme";

/**
 * The list view (FR-2.4) — a first-class equal of the floor plan, not a fallback.
 * It is what screen-reader users get and what renders while a plan image loads.
 * The SVG plan renderer lands alongside it (TDD §13.3).
 */
export default function FloorScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"desk" | "room">("desk");
  const [date, setDate] = useState(toLocalDate(new Date()));

  const availability = useQuery({
    queryKey: ["availability", id, date, kind],
    queryFn: () => api.availability(token!, id, date, kind),
    enabled: !!token && !!id,
  });

  const book = useMutation({
    mutationFn: (resource: ResourceAvailability) =>
      api.createBooking(
        token!,
        { resource_id: resource.id, local_date: date },
        // One key per user intent, so a retry replays rather than double-books.
        newIdempotencyKey(),
      ),
    onSuccess: (booking) => {
      // Availability and "my bookings" are both stale now.
      queryClient.invalidateQueries({ queryKey: ["availability"] });
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
      Alert.alert("Booked", `${booking.resource_code} on ${formatDate(booking.local_date)}`);
    },
    onError: (error) => {
      // Refusals are rendered from violation codes, never from server prose (TDD §11).
      if (error instanceof ProblemError) {
        Alert.alert(
          error.status === 409 ? "Just taken" : "Can't book that",
          describeAll(error.violations, error.detail),
        );
        if (error.status === 409) {
          queryClient.invalidateQueries({ queryKey: ["availability"] });
        }
        return;
      }
      Alert.alert("Something went wrong", "Could not reach the server.");
    },
  });

  const data = availability.data;

  return (
    <>
      <Stack.Screen options={{ title: name ?? "Floor", headerBackTitle: "Spaces" }} />
      <View style={styles.screen}>
        <DateStrip value={date} onChange={setDate} />

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
          data={data?.resources ?? []}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing(2) }}
          refreshing={availability.isFetching}
          onRefresh={() => availability.refetch()}
          ListHeaderComponent={
            <Text style={styles.count}>
              {data
                ? `${data.available} of ${data.total} ${kind}s free`
                : availability.isLoading
                  ? "Loading…"
                  : ""}
            </Text>
          }
          ListEmptyComponent={
            availability.isLoading ? null : (
              <Text style={styles.count}>
                {/* A closed day, a blackout or a full office all arrive here as a
                    refusal with a code — say which, rather than showing an empty list
                    that looks like a loading bug (FR-6.9). */}
                {availability.error instanceof ProblemError
                  ? describeAll(availability.error.violations, availability.error.detail)
                  : availability.isError
                    ? "Couldn't load availability."
                    : `No ${kind}s on this floor.`}
              </Text>
            )
          }
          renderItem={({ item }) => (
            <ResourceRow
              resource={item}
              busy={book.isPending && book.variables?.id === item.id}
              onPress={() => book.mutate(item)}
            />
          )}
        />
      </View>
    </>
  );
}

function ResourceRow({
  resource,
  busy,
  onPress,
}: {
  resource: ResourceAvailability;
  busy: boolean;
  onPress: () => void;
}) {
  const attrs = Object.entries(resource.attributes)
    .filter(([, v]) => v !== false && v !== 0 && v !== "none")
    .map(([k, v]) => (typeof v === "boolean" ? k.replace(/_/g, " ") : `${k.replace(/_/g, " ")} ${v}`));

  const state = resource.occupied_by_me
    ? "yours"
    : !resource.bookable
      ? "unavailable"
      : resource.available
        ? "free"
        : "taken";

  const label = {
    free: "Available",
    taken: "Taken",
    yours: "Booked by you",
    unavailable: resource.out_of_service_reason || "Out of service",
  }[state];

  return (
    <Pressable
      onPress={onPress}
      disabled={state !== "free" || busy}
      style={[styles.row, state !== "free" && styles.rowMuted]}
      accessibilityRole="button"
      accessibilityLabel={`${resource.code}, ${label}`}
      accessibilityHint={state === "free" ? "Double tap to book" : undefined}
    >
      {/* State is carried by a label as well as colour — colour alone cannot
          communicate availability accessibly (TDD §13.3). */}
      <View style={[styles.dot, styles[`dot_${state}` as const]]} />
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
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Text style={[styles.state, state === "free" && styles.stateFree]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: "row", gap: spacing(1), paddingHorizontal: spacing(2) },
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
  rowMuted: { opacity: 0.55 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dot_free: { backgroundColor: colors.free },
  dot_taken: { backgroundColor: colors.taken },
  dot_yours: { backgroundColor: colors.accent },
  dot_unavailable: { backgroundColor: colors.danger },
  code: { color: colors.text, fontWeight: "600" },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  state: { color: colors.muted, fontSize: 12 },
  stateFree: { color: colors.free, fontWeight: "600" },
});
