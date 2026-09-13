import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Pressable, Text, View,
} from "react-native";

import { DateStrip } from "@/components/DateStrip";
import { FloorPlan } from "@/components/FloorPlan";
import { api, newIdempotencyKey, ProblemError, type ResourceAvailability } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, toLocalDate } from "@/lib/dates";
import { describeAll } from "@/lib/messages";
import {
  radius, spacing, type, useTheme, useThemedStyles, type Theme,
} from "@/lib/theme";

/**
 * The list view (FR-2.4) — a first-class equal of the floor plan, not a fallback.
 * It is what screen-reader users get and what renders while a plan image loads.
 * The SVG plan renderer lands alongside it (TDD §13.3).
 */
export default function FloorScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { token } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"desk" | "room">("desk");
  const [view, setView] = useState<"plan" | "list">("plan");
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
          {/* Two independent choices — what to show, and how. Kept apart by the
              spacer below so they do not read as one four-way control. */}
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
          <View style={{ flex: 1 }} />
          {/* The list is a first-class equal of the plan, not a fallback: it is what
              screen-reader users get and what renders while data loads (FR-2.4). */}
          {(["plan", "list"] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => setView(v)}
              style={[styles.tab, view === v && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: view === v }}
              accessibilityLabel={v === "plan" ? "Floor plan view" : "List view"}
            >
              <Text style={[styles.tabText, view === v && styles.tabTextActive]}>
                {v === "plan" ? "Plan" : "List"}
              </Text>
            </Pressable>
          ))}
        </View>

        {view === "plan" && data ? (
          <View>
            <FloorPlan
              resources={data.resources}
              zones={data.zones}
              plan={data.plan}
              onSelect={(r) => {
                if (r.available) book.mutate(r);
                else
                  Alert.alert(
                    r.code,
                    r.occupied_by_me
                      ? "This is your booking."
                      : r.bookable
                        ? "Already taken for this day."
                        : r.out_of_service_reason || "Out of service.",
                  );
              }}
            />
            <Text style={styles.planHint}>
              {data.available} of {data.total} {kind}s free · pinch to zoom, double tap to reset
            </Text>
          </View>
        ) : null}

        <FlatList
          data={view === "list" ? (data?.resources ?? []) : []}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing(2) }}
          refreshing={availability.isFetching}
          onRefresh={() => availability.refetch()}
          ListHeaderComponent={
            view !== "list" ? null : (
            <Text style={styles.count}>
              {data
                ? `${data.available} of ${data.total} ${kind}s free`
                : availability.isLoading
                  ? "Loading…"
                  : ""}
            </Text>
            )
          }
          ListEmptyComponent={
            availability.isLoading || (view === "plan" && data) ? null : (
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
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
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
        <ActivityIndicator color={theme.color.accentText} />
      ) : (
        <Text style={[styles.state, state === "free" && styles.stateFree]}>{label}</Text>
      )}
    </Pressable>
  );
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  tabs: {
    flexDirection: "row" as const,
    gap: spacing(1),
    paddingHorizontal: spacing(2),
    paddingBottom: spacing(1),
  },
  tab: {
    paddingVertical: spacing(0.75),
    paddingHorizontal: spacing(1.75),
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.color.line,
    backgroundColor: t.color.surface,
  },
  tabActive: { backgroundColor: t.color.accent, borderColor: t.color.accent },
  tabText: { ...type.sub, color: t.color.muted, fontWeight: "600" as const },
  tabTextActive: { color: t.color.onAccent },
  count: { ...type.sub, color: t.color.muted, marginBottom: spacing(1) },
  planHint: {
    ...type.sub,
    fontSize: 12,
    color: t.color.muted,
    textAlign: "center" as const,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(2),
  },
  row: {
    ...t.card,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    borderRadius: radius.m,
    padding: spacing(1.5),
    marginBottom: spacing(1),
  },
  rowMuted: { opacity: 0.6 },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  dot_free: { backgroundColor: t.color.state.free },
  dot_taken: { backgroundColor: t.color.state.taken, opacity: 0.5 },
  dot_yours: { backgroundColor: t.color.state.yours, borderWidth: 2, borderColor: t.color.state.yours },
  dot_unavailable: { backgroundColor: "transparent", borderWidth: 2, borderColor: t.color.state.closed },
  code: { ...type.code, color: t.color.ink },
  meta: { ...type.sub, fontSize: 12, color: t.color.muted, marginTop: 2 },
  state: { ...type.sub, fontSize: 12, color: t.color.muted },
  stateFree: { color: t.color.state.free, fontWeight: "600" as const },
});
