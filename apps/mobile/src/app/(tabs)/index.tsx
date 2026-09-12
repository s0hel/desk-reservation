import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "expo-router";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { api, ProblemError, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, timeInZone, toLocalDate } from "@/lib/dates";
import { describeAll } from "@/lib/messages";
import { colors, spacing } from "@/lib/theme";

export default function Today() {
  const { token, me } = useAuth();
  const queryClient = useQueryClient();
  const today = toLocalDate(new Date());

  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: () => api.sites(token!),
    enabled: !!token,
  });

  const bookings = useQuery({
    queryKey: ["bookings", today],
    queryFn: () => api.bookings(token!, today),
    enabled: !!token,
  });

  const cancel = useMutation({
    mutationFn: (b: Booking) => api.cancelBooking(token!, b.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
      queryClient.invalidateQueries({ queryKey: ["availability"] });
    },
    onError: (error) =>
      Alert.alert(
        "Couldn't cancel",
        error instanceof ProblemError
          ? describeAll(error.violations, error.detail)
          : "Could not reach the server.",
      ),
  });

  const upcoming = (bookings.data ?? []).filter(
    (b) => b.status === "confirmed" || b.status === "checked_in",
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing(2) }}
      refreshControl={
        <RefreshControl
          refreshing={bookings.isFetching}
          onRefresh={() => bookings.refetch()}
          tintColor={colors.muted}
        />
      }
    >
      <Text style={styles.hello}>Hi {me?.display_name?.split(" ")[0] ?? "there"}</Text>

      <Text style={styles.section}>Your bookings</Text>
      {upcoming.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {bookings.isLoading ? "Loading…" : "Nothing booked yet."}
          </Text>
          <Link href="/(tabs)/spaces" style={styles.link}>
            Find a desk →
          </Link>
        </View>
      ) : (
        upcoming.map((b) => (
          <View key={b.id} style={styles.card}>
            <Text style={styles.cardTitle}>{b.resource_code ?? "Desk"}</Text>
            <Text style={styles.cardMeta}>{formatDate(b.local_date)}</Text>
            {/* Times render in the SITE's zone, not the device's (TDD §5). */}
            <Text style={styles.cardMeta}>
              {timeInZone(b.starts_at, b.site_timezone)} – {timeInZone(b.ends_at, b.site_timezone)}
              {b.site_timezone ? ` · ${b.site_timezone}` : ""}
            </Text>
            <Pressable
              onPress={() =>
                Alert.alert("Cancel booking?", `${b.resource_code} on ${formatDate(b.local_date)}`, [
                  { text: "Keep", style: "cancel" },
                  { text: "Cancel booking", style: "destructive", onPress: () => cancel.mutate(b) },
                ])
              }
              disabled={cancel.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Cancel booking for ${b.resource_code} on ${b.local_date}`}
            >
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
        ))
      )}

      <Text style={styles.section}>Sites</Text>
      {sites.data?.map((s) => (
        <View key={s.id} style={styles.card}>
          <Text style={styles.cardTitle}>{s.name}</Text>
          <Text style={styles.cardMeta}>{s.address}</Text>
          <Text style={styles.cardMeta}>Timezone {s.timezone}</Text>
          <Link href="/(tabs)/spaces" style={styles.link}>
            Browse floors →
          </Link>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hello: { color: colors.text, fontSize: 28, fontWeight: "700" },
  section: {
    color: colors.muted, fontSize: 13, textTransform: "uppercase",
    letterSpacing: 0.8, marginTop: spacing(3), marginBottom: spacing(1),
  },
  card: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 14, padding: spacing(2), marginBottom: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: "600", marginBottom: spacing(0.5) },
  cardMeta: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  link: { color: colors.accent, marginTop: spacing(1), fontWeight: "600" },
  cancel: { color: colors.danger, marginTop: spacing(1.5), fontWeight: "600" },
  empty: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 14, padding: spacing(2),
  },
  emptyText: { color: colors.muted },
});
