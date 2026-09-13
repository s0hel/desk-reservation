import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "expo-router";
import {
  Alert, Pressable, RefreshControl, ScrollView, Text, View, type ColorValue,
} from "react-native";

import { Icon } from "@/components/Icon";
import { api, ProblemError, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, timeInZone, toLocalDate } from "@/lib/dates";
import { describeAll } from "@/lib/messages";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

export default function Today() {
  const { token, me } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
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
      contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(4) }}
      refreshControl={
        <RefreshControl
          refreshing={bookings.isRefetching}
          onRefresh={() => bookings.refetch()}
          tintColor={theme.color.muted}
        />
      }
    >
      <Text style={styles.hello}>Hi {me?.display_name?.split(" ")[0] ?? "there"}</Text>

      <Text style={styles.section}>Your bookings</Text>
      {upcoming.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {bookings.isLoading ? "Loading…" : "Nothing booked yet."}
          </Text>
          <LinkRow href="/(tabs)/spaces" label="Find a desk" color={theme.color.accentText} />
        </View>
      ) : (
        upcoming.map((b) => (
          <View key={b.id} style={styles.card}>
            <Text style={styles.code}>{b.resource_code ?? "Desk"}</Text>
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
          <LinkRow href="/(tabs)/spaces" label="Browse floors" color={theme.color.accentText} />
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * `<Link asChild>` forwards onPress to its child, so the child has to be pressable and
 * its style has to be static — the `({ pressed }) => …` form does not survive `asChild`
 * and silently drops the styling.
 */
function LinkRow({ href, label, color }: { href: string; label: string; color: ColorValue }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Link href={href as never} asChild>
      <Pressable style={styles.linkRow} accessibilityRole="link" accessibilityLabel={label}>
        <Text style={[styles.link, { color }]}>{label}</Text>
        <Icon name="arrowRight" size={16} color={color} />
      </Pressable>
    </Link>
  );
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  hello: { ...type.display, color: t.color.ink },
  section: {
    ...type.label,
    color: t.color.muted,
    marginTop: spacing(3),
    marginBottom: spacing(1),
  },
  card: {
    ...t.card,
    borderRadius: radius.l,
    padding: spacing(2),
    marginBottom: spacing(1.5),
  },
  cardTitle: { ...type.heading, color: t.color.ink, marginBottom: spacing(0.5) },
  code: { ...type.code, fontSize: 18, color: t.color.ink, marginBottom: spacing(0.5) },
  cardMeta: { ...type.sub, color: t.color.muted },
  linkRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(0.75),
    marginTop: spacing(1.5),
  },
  link: { ...type.sub, fontWeight: "600" as const },
  cancel: { ...type.sub, color: t.color.danger, fontWeight: "600" as const, marginTop: spacing(1.5) },
  emptyText: { ...type.body, color: t.color.muted },
});
