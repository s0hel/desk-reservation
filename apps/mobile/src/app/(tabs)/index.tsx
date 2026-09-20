import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, useWindowDimensions, View } from "react-native";

import { AbsenceSheet } from "@/components/AbsenceSheet";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { RefusalSheet } from "@/components/RefusalSheet";
import { Sheet } from "@/components/Sheet";
import { SiteBanner } from "@/components/SiteBanner";
import { WeekStrip } from "@/components/WeekStrip";
import { api, placeName, ProblemError, type DayAvailability, type Site } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { timeInZone } from "@/lib/dates";
import { refusal, type Refusal } from "@/lib/messages";
import { absenceLabel, type AbsenceKind } from "@/lib/presence";
import { useHomeSite } from "@/lib/site";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

/**
 * Home (FR-2.1).
 *
 * Previously this rendered `GET /v1/bookings` as a list of rows, which answers a
 * question nobody asks. Somebody opening this app at 08:40 wants to know one thing —
 * am I sorted for today, and what do I do next — and that is a sentence and a button,
 * not a table. So: the day leads, one hero card carries the answer and the next
 * action, and the week below shows which days are even worth tapping.
 *
 * Cancel is deliberately demoted into the day's detail sheet. It used to be the only
 * action on every card, in red, which made the destructive path the most obvious thing
 * on the screen.
 *
 * The header names the office by the user's OWN home site (FR-1.9), not by whichever
 * site sorted first — see `lib/site.ts` for why that distinction is load-bearing once
 * a tenant has two buildings.
 */
export default function Today() {
  const { token, me } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [openDay, setOpenDay] = useState<DayAvailability | null>(null);
  const [away, setAway] = useState<string | null>(null);
  const [problem, setProblem] = useState<Refusal | null>(null);

  const fail = (error: unknown) =>
    setProblem(
      error instanceof ProblemError
        ? refusal(error.violations, error.detail)
        : refusal([], "Could not reach the server."),
    );

  const { site, refetch: refetchSite } = useHomeSite();
  const { width } = useWindowDimensions();

  const week = useQuery({
    queryKey: ["week", site?.id],
    queryFn: () => api.week(token!, site!.id),
    enabled: !!token && !!site,
  });

  const cancel = useMutation({
    mutationFn: (bookingId: string) => api.cancelBooking(token!, bookingId),
    onSuccess: () => {
      setOpenDay(null);
      queryClient.invalidateQueries({ queryKey: ["week"] });
      queryClient.invalidateQueries({ queryKey: ["availability"] });
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
    onError: fail,
  });

  const days = week.data?.days ?? [];
  const first = days[0]?.local_date;
  const last = days[days.length - 1]?.local_date;

  /**
   * Declared days away (FR-5.5). Deliberately NOT gated on the presence kill switch:
   * an absence is the user's own record of where they will be, and it also feeds
   * assigned-desk release (FR-6.7). Switching presence off hides other people from you;
   * it does not stop you saying you are on leave.
   */
  const absences = useQuery({
    queryKey: ["absences", first, last],
    queryFn: () => api.absences(token!, first!, last!),
    enabled: !!token && !!first && !!last,
  });
  const awayByDate = useMemo(() => {
    const map: Record<string, AbsenceKind> = {};
    for (const a of absences.data ?? []) map[a.local_date] = a.kind;
    return map;
  }, [absences.data]);

  const afterAbsence = () => {
    setAway(null);
    queryClient.invalidateQueries({ queryKey: ["absences"] });
  };

  const declare = useMutation({
    mutationFn: (vars: { date: string; kind: AbsenceKind }) =>
      api.declareAbsence(token!, vars.date, vars.kind),
    onSuccess: afterAbsence,
    // The server refuses while a desk is still held for that day, and names the booking
    // in the violation so the sheet can say which one (FR-5.5). It does not cancel it
    // for you — that is a side effect nobody asked for.
    onError: fail,
  });

  const clearAway = useMutation({
    mutationFn: (date: string) => api.clearAbsence(token!, date),
    onSuccess: afterAbsence,
    onError: fail,
  });

  const today = days.find((d) => d.local_date === week.data?.today) ?? null;
  const next = days.find((d) => d.local_date !== week.data?.today && d.my_booking) ?? null;

  /**
   * Desks and rooms are the same table and the same plan (TDD §4), so booking either
   * is the same journey with a different filter — `kind` rides through pick-a-floor
   * to the plan, which opens on that toggle.
   *
   * The date comes from the SITE's today, never the device's (TDD §5).
   */
  const book = (kind: "desk" | "room", localDate?: string) =>
    router.push({
      pathname: "/pick-floor",
      params: { date: localDate ?? week.data?.today ?? "", kind },
    });

  return (
    <>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={week.isRefetching}
            // The sites query too, not just the week: the header is rendered from it,
            // and its photo URL is signed with an hour's life (TDD §11). Refreshing
            // only the week left a swapped — or expired — building photo on screen
            // with the gesture visibly doing nothing about it.
            onRefresh={() => {
              void week.refetch();
              void refetchSite();
            }}
            tintColor={theme.color.muted}
          />
        }
      >
        <SiteBanner
          photo={site?.photo}
          siteName={site?.name ?? ""}
          width={width - spacing(4)}
        />

        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.display}>{greeting(site, me?.display_name)}</Text>
            {/* The site's own today, not the device's: a phone an hour behind Berlin
                would otherwise name the wrong day at the top of the screen (TDD §5). */}
            <Text style={styles.eyebrow}>
              {week.data ? `Today is ${weekdayOf(week.data.today)}, ${longDayOf(week.data.today)}` : " "}
            </Text>
          </View>
          <View style={styles.avatar}>
            <Text style={styles.initials}>{initialsOf(me?.display_name)}</Text>
          </View>
        </View>

        <HeroCard
          day={today}
          loading={week.isLoading}
          timezone={week.data?.site_timezone ?? null}
          away={today ? (awayByDate[today.local_date] ?? null) : null}
          onDeclare={() => setAway(week.data?.today ?? null)}
          onOpenPlan={(floorId, floorName) =>
            router.push({
              pathname: "/floor/[id]",
              params: { id: floorId, name: floorName, date: week.data?.today ?? "" },
            })
          }
          onBook={book}
          onManage={() => today && setOpenDay(today)}
        />

        <View style={styles.section}>
          <Text style={styles.label}>Your week</Text>
          {/* Only when there is nothing to show. A failed *re*fetch leaves the last good
              week in `data`, and reporting an error beside a hero card rendered from
              that same data is incoherent — which is exactly how it looked. */}
          {week.isError && !week.data ? (
            <Text style={styles.mutedInset}>Couldn&apos;t load the week.</Text>
          ) : (
            <>
              <WeekStrip
                days={days}
                value={week.data?.today ?? ""}
                today={week.data?.today}
                absences={awayByDate}
                onChange={(date) => {
                  const day = days.find((d) => d.local_date === date);
                  if (day) setOpenDay(day);
                }}
              />
              <Text style={styles.summary}>{summarise(days)}</Text>
            </>
          )}
        </View>

        {next ? (
          <View style={styles.section}>
            <Text style={styles.label}>Next in the office</Text>
            <Pressable
              style={styles.nextRow}
              onPress={() => setOpenDay(next)}
              accessibilityRole="button"
              accessibilityLabel={`${longDayOf(next.local_date)}, ${next.my_booking?.resource_code}`}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.nextDay}>{longDayOf(next.local_date)}</Text>
                <Text style={styles.muted}>
                  {next.my_booking?.resource_code} · {next.my_booking?.floor_name}
                </Text>
              </View>
              <Icon name="chevronRight" size={20} color={theme.color.muted} />
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      <DaySheet
        day={openDay}
        timezone={week.data?.site_timezone ?? null}
        away={openDay ? (awayByDate[openDay.local_date] ?? null) : null}
        cancelling={cancel.isPending}
        onCancel={(id) => cancel.mutate(id)}
        onAway={(localDate) => {
          setOpenDay(null);
          setAway(localDate);
        }}
        onBook={(kind, localDate) => {
          setOpenDay(null);
          book(kind, localDate);
        }}
        onOpenPlan={(floorId, floorName) => {
          const day = openDay?.local_date;
          setOpenDay(null);
          router.push({
            pathname: "/floor/[id]",
            params: { id: floorId, name: floorName, date: day ?? "" },
          });
        }}
        onClose={() => setOpenDay(null)}
      />

      <AbsenceSheet
        localDate={away}
        current={away ? (awayByDate[away] ?? null) : null}
        busy={declare.isPending || clearAway.isPending}
        onDeclare={(kind) => away && declare.mutate({ date: away, kind })}
        onClear={() => away && clearAway.mutate(away)}
        onClose={() => setAway(null)}
      />

      <RefusalSheet refusal={problem} onClose={() => setProblem(null)} />
    </>
  );
}

/**
 * The one card that answers "am I sorted", and the standing way to book.
 *
 * "Book a space" and "Book a room" sit here rather than floating under the card,
 * because a second action row below a card that already has one reads as two
 * unrelated offers. Where the day already has an answer — you are booked — the desk
 * button gives way to "Show on the plan", which is the thing you actually want at
 * 08:40; the room button stays, because having a desk is not having a room.
 */
function HeroCard({
  day,
  loading,
  timezone,
  away,
  onDeclare,
  onOpenPlan,
  onBook,
  onManage,
}: {
  day: DayAvailability | null;
  loading: boolean;
  timezone: string | null;
  away: AbsenceKind | null;
  onDeclare: () => void;
  onOpenPlan: (floorId: string, floorName: string) => void;
  onBook: (kind: "desk" | "room") => void;
  onManage: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  if (loading) {
    return (
      <View style={styles.hero}>
        <Text style={styles.muted}>Loading your day…</Text>
      </View>
    );
  }

  if (!day) {
    return (
      <View style={styles.hero}>
        <Text style={styles.muted}>No site data yet.</Text>
      </View>
    );
  }

  if (!day.is_open) {
    return (
      <View style={styles.hero}>
        <Text style={styles.heroLabelQuiet}>Closed today</Text>
        <Text style={styles.heroBody}>The office isn&apos;t open. Nothing to do.</Text>
      </View>
    );
  }

  const booking = day.my_booking;

  // You have said where you'll be, and it isn't here (FR-5.5). The card states that
  // back rather than nagging about the desks you didn't book — but it stays changeable,
  // because plans change on the morning more often than they change the week before.
  if (!booking && away) {
    return (
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.heroLabelQuiet}>Not in today</Text>
          <Pressable
            onPress={onDeclare}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Change how today is marked"
          >
            <Text style={styles.heroLink}>Change</Text>
          </Pressable>
        </View>
        <Text style={styles.heroHeadline}>{absenceLabel(away)}</Text>
        <Text style={styles.heroBody}>Your team can see this on their week.</Text>
        {/* Still offered, and still ghosted: plans change on the morning far more
            often than they change the week before, but nothing here should read as
            nagging somebody who has already said where they will be. */}
        <View style={styles.heroActions}>
          <Button
            label="Book a space"
            variant="ghost"
            onPress={() => onBook("desk")}
            style={{ flex: 1 }}
          />
          <Button
            label="Book a room"
            variant="ghost"
            onPress={() => onBook("room")}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    );
  }

  if (!booking) {
    return (
      <View style={styles.hero}>
        <Text style={styles.heroLabelQuiet}>Nothing booked today</Text>
        <Text style={styles.heroHeadline}>
          {day.available} of {day.total} desks free
        </Text>
        <View style={styles.heroActions}>
          <Button label="Book a space" onPress={() => onBook("desk")} style={{ flex: 1 }} />
          <Button
            label="Book a room"
            variant="ghost"
            onPress={() => onBook("room")}
            style={{ flex: 1 }}
          />
        </View>
        <Button
          label="I'm not coming in"
          variant="quiet"
          onPress={onDeclare}
          style={{ marginTop: spacing(1) }}
        />
      </View>
    );
  }

  return (
    <View style={styles.hero}>
      <View style={styles.heroTop}>
        <Text style={styles.heroLabel}>Your desk today</Text>
        <Pressable
          onPress={onManage}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Booking options"
        >
          <Text style={styles.heroLink}>Options</Text>
        </Pressable>
      </View>
      <Text style={styles.heroCode}>{booking.resource_code}</Text>
      <Text style={styles.heroBody}>
        {booking.floor_name} · {allDay(booking.starts_at, booking.ends_at, timezone)}
      </Text>
      <View style={styles.heroActions}>
        <Button
          label="Show on the plan"
          icon="plan"
          onPress={() => onOpenPlan(booking.floor_id, booking.floor_name)}
          style={{ flex: 1 }}
        />
        <Button
          label="Book a room"
          variant="ghost"
          onPress={() => onBook("room")}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

/**
 * Everything a day can do, out of the way until it is asked for.
 *
 * Every branch here ends in either an action or a reason there is none. The first
 * version stated "You have nothing booked on this day" and stopped, which is the same
 * dead end this sheet was built to replace `Alert.alert` for.
 */
function DaySheet({
  day,
  timezone,
  away,
  cancelling,
  onCancel,
  onAway,
  onOpenPlan,
  onBook,
  onClose,
}: {
  day: DayAvailability | null;
  timezone: string | null;
  away: AbsenceKind | null;
  cancelling: boolean;
  onCancel: (bookingId: string) => void;
  onAway: (localDate: string) => void;
  onOpenPlan: (floorId: string, floorName: string) => void;
  onBook: (kind: "desk" | "room", localDate: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const booking = day?.my_booking ?? null;

  return (
    <Sheet visible={day !== null} onClose={onClose} title={day ? longDayOf(day.local_date) : ""}>
      {day ? (
        <>
          <Text style={styles.muted}>
            {!day.is_open
              ? "The office is closed on this day."
              : day.blackout
                ? // Shut by an admin, not full. "0 of 144 desks free" would read as
                  // everyone having got there first (FR-6.5).
                  `Closed${day.blackout_reason ? ` — ${day.blackout_reason}` : ""}.`
                : `${day.available} of ${day.total} desks free`}
          </Text>

          {booking ? (
            <>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetCode}>{booking.resource_code}</Text>
                <Text style={styles.muted}>{booking.floor_name}</Text>
              </View>
              <Text style={styles.muted}>
                {allDay(booking.starts_at, booking.ends_at, timezone)}
              </Text>
              <Button
                label="Show on the plan"
                icon="plan"
                onPress={() => onOpenPlan(booking.floor_id, booking.floor_name)}
              />
              <Button
                label="Cancel this booking"
                variant="quiet"
                busy={cancelling}
                onPress={() => onCancel(booking.id)}
              />
            </>
          ) : day.is_open && !day.blackout ? (
            <>
              {away ? (
                <Text style={styles.awayLine}>{absenceLabel(away)} — your team can see this.</Text>
              ) : null}
              {day.available > 0 ? (
                <Button
                  label="Book a space"
                  icon="plan"
                  onPress={() => onBook("desk", day.local_date)}
                />
              ) : (
                <Text style={styles.muted}>
                  Every desk is taken. Try another day, or check back — people cancel.
                </Text>
              )}
              {/* Offered even on a day with no desks left: `available` counts desks,
                  and a full building is exactly when a room is worth grabbing. */}
              <Button
                label="Book a room"
                variant="ghost"
                onPress={() => onBook("room", day.local_date)}
              />
              {/* Always offered on a day you have not booked, full or not: a full day is
                  exactly when telling your team you are staying home is worth doing. */}
              <Button
                label={away ? "Change or clear this" : "I'm not coming in"}
                variant="quiet"
                onPress={() => onAway(day.local_date)}
              />
            </>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/**
 * A full-day booking spans the site's opening hours. Printing those hours and the tz
 * database name on every row, as this screen used to, is noise: what the user booked
 * was the day.
 */
function allDay(startsAt: string, endsAt: string, timezone: string | null): string {
  const from = timeInZone(startsAt, timezone);
  const to = timeInZone(endsAt, timezone);
  return from && to ? `All day · ${from}–${to}` : "All day";
}

function summarise(days: DayAvailability[]): string {
  const open = days.filter((d) => d.is_open);
  if (!open.length) return "";
  const booked = open.filter((d) => d.my_booking).length;
  // A blacked-out day has no desks free, but it is shut rather than full, and saying
  // "full" sends people looking for a cancellation that will never come (FR-6.5).
  const closed = open.filter((d) => d.blackout).map((d) => weekdayOf(d.local_date));
  const full = open
    .filter((d) => !d.blackout && d.available === 0)
    .map((d) => weekdayOf(d.local_date));
  const head =
    booked === 0 ? "Nothing booked this week" : `${booked} day${booked === 1 ? "" : "s"} booked`;
  const notes = [
    full.length ? `${andList(full)} full` : "",
    closed.length ? `${andList(closed)} closed` : "",
  ].filter(Boolean);
  return [head, ...notes].join(" · ");
}

/**
 * "Monday", "Monday and Tuesday", "Monday, Tuesday and Wednesday".
 *
 * A plain `join(" and ")` was fine while at most two days were ever full and became
 * "Monday and Tuesday and Wednesday and Thursday and Friday full" the first time a
 * whole week was. Easy to reach: a busy office, or a site whose floors have not been
 * drawn yet — every day of which has zero desks and therefore reads as full.
 */
function andList(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function weekdayOf(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long" });
}

function longDayOf(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/**
 * "Welcome to Tampa, Priya".
 *
 * The place comes from the site's `short_name` and falls back to its full name —
 * never from trimming one into the other, which eventually greets somebody with
 * "Welcome to Tampa — Rocky Poin". The person is their first name only, because that
 * is what a greeting is; a display name that is a single word still works.
 *
 * Both halves are optional and the sentence degrades in order: a place with no name
 * yet is just "Welcome back", which is true and says nothing wrong.
 */
function greeting(site: Site | undefined, displayName?: string): string {
  const place = placeName(site);
  const first = displayName?.trim().split(/\s+/)[0];
  if (!place) return first ? `Welcome back, ${first}` : "Welcome back";
  return first ? `Welcome to ${place}, ${first}` : `Welcome to ${place}`;
}

function initialsOf(name?: string) {
  if (!name) return "—";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  content: { paddingTop: spacing(1), paddingBottom: spacing(4), gap: spacing(2) },
  header: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: spacing(1.5),
    paddingHorizontal: spacing(2),
  },
  // `at()` rather than spreading `type.display` and overriding fontSize: the role
  // carries a lineHeight matched to 34pt, and a 26pt glyph in a 38pt box reads as a
  // stray gap above the date. A greeting is a sentence, and a sentence at 34pt wraps
  // to three lines on a phone.
  display: { ...at(type.display, 26), color: t.color.ink },
  eyebrow: { ...type.label, color: t.color.muted, marginTop: spacing(0.5) },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: t.color.accent,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  initials: { ...type.sub, fontWeight: "700" as const, color: t.color.onAccent },

  hero: {
    ...t.card,
    marginHorizontal: spacing(2),
    borderRadius: radius.l,
    padding: spacing(2),
  },
  heroTop: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
  },
  heroLabel: { ...type.label, color: t.color.clay },
  heroLabelQuiet: { ...type.label, color: t.color.muted },
  heroLink: { ...type.sub, color: t.color.accentText, fontWeight: "600" as const },
  heroCode: { ...at(type.code, 26), color: t.color.ink, marginTop: spacing(0.75) },
  heroActions: { flexDirection: "row" as const, gap: spacing(1), marginTop: spacing(1.5) },
  heroHeadline: { ...type.title, color: t.color.ink, marginTop: spacing(0.5) },
  heroBody: { ...type.sub, color: t.color.muted, marginTop: spacing(0.25) },

  section: { gap: spacing(0.5) },
  label: { ...type.label, color: t.color.muted, paddingHorizontal: spacing(2) },
  summary: { ...type.sub, color: t.color.muted, paddingHorizontal: spacing(2) },
  muted: { ...type.body, color: t.color.muted },
  mutedInset: { ...type.body, color: t.color.muted, paddingHorizontal: spacing(2) },

  nextRow: {
    ...t.card,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    marginHorizontal: spacing(2),
    marginTop: spacing(0.5),
    borderRadius: radius.l,
    padding: spacing(2),
  },
  nextDay: { ...type.heading, color: t.color.ink },

  awayLine: { ...type.body, color: t.color.accentText, fontWeight: "600" as const },
  sheetRow: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: spacing(1) },
  sheetCode: { ...at(type.code, 21), color: t.color.ink },
});
