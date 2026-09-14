import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, SectionList, Text, TextInput, View } from "react-native";

import { PersonRow } from "@/components/PersonRow";
import { api, ProblemError, type Colleague } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { addDays } from "@/lib/dates";
import type { PresenceStatus } from "@/lib/presence";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

/**
 * Team (FR-5.1, FR-5.2, FR-5.4).
 *
 * The question this screen answers is "is it worth me coming in on Thursday", and the
 * honest answer to it is a list of names, not a number. Two lists, in fact: the people
 * whose plans you actually coordinate with, and everyone else who will be there.
 *
 * The count above them is the length of what is drawn below it and nothing else. The
 * API deliberately returns no total (TDD §11, PRD Q6) precisely so this screen cannot
 * print "18 in" over a list of 16 and identify the two who opted out — so the number
 * here is computed from the rows, and it is allowed to be an undercount.
 */
export default function TeamScreen() {
  const { token, me } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();

  const [date, setDate] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");

  // Debounced, so typing a name is one request rather than one per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setTerm(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: () => api.sites(token!),
    enabled: !!token,
  });
  const site = sites.data?.[0];

  // Shared cache key with Today and the floor screen: the site's own `today` is the
  // only correct anchor for the strip (TDD §5), and it is already on the wire.
  const week = useQuery({
    queryKey: ["week", site?.id],
    queryFn: () => api.week(token!, site!.id),
    enabled: !!token && !!site,
  });
  const today = week.data?.today ?? null;
  const selected = date ?? today;

  const dates = useMemo(
    () => (today ? Array.from({ length: 7 }, (_, i) => addDays(today, i)) : []),
    [today],
  );

  const team = useQuery({
    queryKey: ["team", site?.id, today],
    queryFn: () => api.team(token!, { siteId: site!.id, from: today!, days: 7 }),
    enabled: !!token && !!site && !!today,
  });

  const presence = useQuery({
    queryKey: ["presence", site?.id, selected],
    queryFn: () => api.presence(token!, site!.id, selected!),
    enabled: !!token && !!site && !!selected,
  });

  const found = useQuery({
    queryKey: ["colleagues", term],
    queryFn: () => api.colleagues(token!, term),
    enabled: !!token && term.length >= 2,
  });

  const openColleague = (person: { user_id: string; display_name: string }) =>
    router.push({
      pathname: "/colleague/[id]",
      params: { id: person.user_id, name: person.display_name },
    });

  const members = team.data?.members ?? [];
  const teamIds = new Set(members.map((m) => m.user_id));
  const inOffice = presence.data?.people ?? [];
  // Team members already have a row of their own; repeating them under "Also in" would
  // make the screen look busier than the office is.
  const alsoIn = inOffice.filter((p) => !teamIds.has(p.user_id));

  type Row =
    | { kind: "person"; id: string; name: string; initials?: string; isMe: boolean;
        status: PresenceStatus; seat: string | null; where: string | null }
    | { kind: "empty"; id: string; text: string };

  const sections: { title: string; note?: string; data: Row[] }[] = term.length >= 2
    ? [
        {
          title: `Matching “${term}”`,
          data: (found.data ?? []).length
            ? (found.data ?? []).map(
                (c: Colleague): Row => ({
                  kind: "person",
                  id: c.user_id,
                  name: c.display_name,
                  initials: c.initials,
                  isMe: c.is_me,
                  // Search answers "who", not "where" — the colleague's own screen does
                  // that, and guessing a status here would mean a call per result.
                  status: "unknown",
                  seat: null,
                  where: null,
                }),
              )
            : [{ kind: "empty", id: "none", text: found.isFetching ? "Searching…" : "Nobody by that name." }],
        },
      ]
    : [
        {
          title: team.data?.group_name ?? "Your team",
          data: members.length
            ? members.map((m): Row => {
                const day = m.days.find((d) => d.local_date === selected);
                return {
                  kind: "person",
                  id: m.user_id,
                  name: m.display_name,
                  initials: m.initials,
                  isMe: m.is_me,
                  status: (day?.status ?? "unknown") as PresenceStatus,
                  seat: day?.seat?.resource_code ?? null,
                  where: day?.seat?.floor_name ?? null,
                };
              })
            : [
                {
                  kind: "empty",
                  id: "no-team",
                  text: team.isLoading
                    ? "Loading your team…"
                    : "You're not in a team yet. An admin can add you to one.",
                },
              ],
        },
        {
          title: "Also in the office",
          data: alsoIn.length
            ? alsoIn.map((p): Row => ({
                kind: "person",
                id: p.user_id,
                name: p.display_name,
                initials: p.initials,
                isMe: p.is_me,
                status: "in",
                seat: p.seat?.resource_code ?? null,
                where: p.seat?.floor_name ?? null,
              }))
            : [
                {
                  kind: "empty",
                  id: "no-one",
                  text: presence.isLoading ? "Loading…" : "Nobody else has booked a desk yet.",
                },
              ],
        },
      ];

  // A 404 here means the org switched presence off between app start and now; the tab
  // should already be gone, so say so plainly rather than rendering three empty lists.
  const switchedOff =
    presence.error instanceof ProblemError && presence.error.status === 404;

  if (switchedOff) {
    return (
      <View style={styles.offScreen}>
        <Text style={styles.offText}>
          Your organisation has turned off colleague visibility.
        </Text>
      </View>
    );
  }

  return (
    <SectionList
      style={styles.screen}
      sections={sections}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(4) }}
      stickySectionHeadersEnabled={false}
      refreshing={presence.isRefetching || team.isRefetching}
      onRefresh={() => {
        void presence.refetch();
        void team.refetch();
      }}
      ListHeaderComponent={
        <View style={styles.head}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Find a colleague"
            placeholderTextColor={theme.color.muted}
            style={styles.search}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Find a colleague by name"
          />

          {term.length >= 2 ? null : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.dayRow}
              >
                {dates.map((d) => {
                  const on = d === selected;
                  return (
                    <Pressable
                      key={d}
                      onPress={() => setDate(d)}
                      style={[styles.day, on && styles.dayOn]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${d === today ? "Today, " : ""}${longDay(d)}`}
                    >
                      <Text style={[styles.dayName, on && styles.onDay]}>
                        {d === today ? "TODAY" : weekdayOf(d).toUpperCase()}
                      </Text>
                      <Text style={[styles.dayNum, on && styles.onDay]}>{dayNumberOf(d)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Text style={styles.count}>
                {presence.isLoading
                  ? " "
                  : inOffice.length === 0
                    ? "Nobody in the office yet"
                    : `${inOffice.length} ${inOffice.length === 1 ? "person" : "people"} in`}
              </Text>
            </>
          )}
        </View>
      }
      renderSectionHeader={({ section }) => <Text style={styles.label}>{section.title}</Text>}
      renderItem={({ item }) =>
        item.kind === "empty" ? (
          <Text style={styles.empty}>{item.text}</Text>
        ) : (
          <PersonRow
            id={item.id}
            name={item.name}
            initials={item.initials}
            isMe={item.isMe}
            status={item.status}
            seat={item.seat}
            where={item.where}
            onPress={() => openColleague({ user_id: item.id, display_name: item.name })}
          />
        )
      }
    />
  );
}

function weekdayOf(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function dayNumberOf(localDate: string) {
  return String(Number(localDate.split("-")[2]));
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
  offScreen: {
    flex: 1,
    backgroundColor: t.color.ground,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: spacing(4),
  },
  offText: { ...type.body, color: t.color.muted, textAlign: "center" as const },
  head: { gap: spacing(1.5), marginBottom: spacing(1) },
  search: {
    ...type.body,
    color: t.color.ink,
    backgroundColor: t.color.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(1.25),
  },
  dayRow: { gap: spacing(0.75), paddingRight: spacing(2) },
  day: {
    ...t.card,
    minWidth: 54,
    alignItems: "center" as const,
    gap: 2,
    paddingVertical: spacing(0.875),
    paddingHorizontal: spacing(0.75),
    borderRadius: radius.m,
  },
  dayOn: { backgroundColor: t.color.accent, borderColor: t.color.accent, shadowOpacity: 0 },
  dayName: { ...at(type.label, 9), letterSpacing: 0.6, color: t.color.muted },
  dayNum: { ...at(type.heading, 18), color: t.color.ink },
  onDay: { color: t.color.onAccent },
  count: { ...type.sub, color: t.color.muted },
  label: { ...type.label, color: t.color.muted, marginBottom: spacing(1), marginTop: spacing(1) },
  empty: { ...type.sub, color: t.color.muted, marginBottom: spacing(1) },
});
