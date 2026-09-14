import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { api, ProblemError, type DayPresence } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { statusLabel } from "@/lib/presence";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

/**
 * One colleague's fortnight (FR-5.2), and the way in to sitting near them (FR-5.3).
 *
 * A day they are in the office is the only row here that does anything, and what it
 * does is open that floor on that day with their desk marked — which is the whole
 * feature. Everything else on the screen exists to let you find that row.
 */
export default function ColleagueScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { token } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();

  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: () => api.sites(token!),
    enabled: !!token,
  });
  const site = sites.data?.[0];

  const week = useQuery({
    queryKey: ["week", site?.id],
    queryFn: () => api.week(token!, site!.id),
    enabled: !!token && !!site,
  });
  const today = week.data?.today;

  const presence = useQuery({
    queryKey: ["user-presence", id, today],
    queryFn: () => api.userPresence(token!, id, site?.id, today, 14),
    enabled: !!token && !!id && !!today,
  });

  // A colleague who has hidden themselves is a 404, not a 403 — the server refuses to
  // confirm they exist (TDD §11). So this screen must not say "they have hidden their
  // days" either: that would leak exactly what the 404 protects.
  const missing = presence.error instanceof ProblemError && presence.error.status === 404;

  const person = presence.data;
  const days = person?.days ?? [];
  const office = days.filter((d) => d.status === "in");
  const displayName = person?.display_name ?? name ?? "Colleague";

  return (
    <>
      <Stack.Screen options={{ title: displayName, headerBackTitle: "Back" }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(4) }}
      >
        {missing ? (
          <Text style={styles.muted}>We couldn&apos;t find that person.</Text>
        ) : presence.isLoading ? (
          <ActivityIndicator color={theme.color.accentText} style={{ marginTop: spacing(4) }} />
        ) : (
          <>
            <View style={styles.identity}>
              <Avatar id={id} name={displayName} initials={person?.initials} size={52} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{displayName}</Text>
                <Text style={styles.sub}>
                  {office.length === 0
                    ? "No office days planned"
                    : `In the office ${office.length} of the next ${days.length} days`}
                </Text>
              </View>
            </View>

            <Text style={styles.label}>Next two weeks</Text>
            {days.map((day) => (
              <DayRow
                key={day.local_date}
                day={day}
                today={today}
                onSitNear={() =>
                  router.push({
                    pathname: "/floor/[id]",
                    params: {
                      id: day.seat!.floor_id,
                      name: day.seat!.floor_name,
                      date: day.local_date,
                      near: day.seat!.resource_id,
                      nearName: displayName,
                    },
                  })
                }
              />
            ))}
          </>
        )}
      </ScrollView>
    </>
  );
}

function DayRow({
  day,
  today,
  onSitNear,
}: {
  day: DayPresence;
  today?: string;
  onSitNear: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const isIn = day.status === "in" && day.seat !== null;

  const body = (
    <>
      <View style={styles.dayCell}>
        <Text style={styles.dayName}>
          {day.local_date === today ? "TODAY" : weekdayOf(day.local_date).toUpperCase()}
        </Text>
        <Text style={styles.dayNum}>{Number(day.local_date.split("-")[2])}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.status, isIn && styles.statusIn]}>
          {statusLabel(day.status as "in" | "remote" | "leave" | "travel" | "unknown")}
        </Text>
        {isIn ? (
          <Text style={styles.seat}>
            {day.seat!.resource_code} · {day.seat!.floor_name}
          </Text>
        ) : null}
      </View>
      {isIn ? (
        <View style={styles.nearChip}>
          <Text style={styles.nearText}>Sit near</Text>
          <Icon name="arrowRight" size={15} color={theme.color.accentText} />
        </View>
      ) : null}
    </>
  );

  if (!isIn) {
    return (
      <View style={[styles.row, styles.rowQuiet]} accessible accessibilityLabel={
        `${longDay(day.local_date)}, ${statusLabel(day.status as "remote" | "leave" | "travel" | "unknown")}`
      }>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      style={styles.row}
      onPress={onSitNear}
      accessibilityRole="button"
      accessibilityLabel={`${longDay(day.local_date)}, at desk ${day.seat!.resource_code} on ${day.seat!.floor_name}`}
      accessibilityHint="Double tap to find a desk near them"
    >
      {body}
    </Pressable>
  );
}

function weekdayOf(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function longDay(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  identity: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    marginBottom: spacing(2),
  },
  name: { ...type.title, color: t.color.ink },
  sub: { ...type.sub, color: t.color.muted, marginTop: 2 },
  muted: { ...type.body, color: t.color.muted },
  label: { ...type.label, color: t.color.muted, marginBottom: spacing(1) },
  row: {
    ...t.card,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    borderRadius: radius.m,
    padding: spacing(1.25),
    marginBottom: spacing(1),
  },
  // A day with no plans is still a row, so the fortnight reads as a continuous strip
  // rather than a list with holes in it — but it is plainly not a control.
  rowQuiet: { ...t.card, shadowOpacity: 0, backgroundColor: "transparent", elevation: 0 },
  dayCell: { width: 44, alignItems: "center" as const },
  dayName: { ...at(type.label, 9), letterSpacing: 0.6, color: t.color.muted },
  dayNum: { ...at(type.heading, 17), color: t.color.ink },
  status: { ...type.sub, color: t.color.muted },
  statusIn: { color: t.color.ink, fontWeight: "600" as const },
  seat: { ...at(type.code, 13), color: t.color.muted, marginTop: 1 },
  nearChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(0.5),
    paddingHorizontal: spacing(1.25),
    paddingVertical: spacing(0.625),
    borderRadius: radius.pill,
    backgroundColor: t.color.accentSoft,
  },
  nearText: { ...at(type.sub, 13), color: t.color.accentText, fontWeight: "600" as const },
});
