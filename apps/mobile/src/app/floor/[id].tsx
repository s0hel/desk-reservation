import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { DeskSheet } from "@/components/DeskSheet";
import { FloorPlan, type Occupant } from "@/components/FloorPlan";
import { RefusalSheet } from "@/components/RefusalSheet";
import { WeekStrip } from "@/components/WeekStrip";
import {
  api, newIdempotencyKey, ProblemError,
  type Availability, type ResourceAvailability,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useHomeSite } from "@/lib/site";
import { describeAll, refusal, type Refusal } from "@/lib/messages";
import { nearestTo } from "@/lib/presence";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

/**
 * One floor, one day (FR-2.3, FR-2.4).
 *
 * The plan now takes the whole screen and the controls float on it. Before, it was a
 * 1.4-aspect band in the top third with a legend sitting on the content and 55% of the
 * screen left black — the plan was the point of the screen and had a minority of it.
 *
 * The list view remains a first-class equal rather than a fallback: it is what a
 * screen-reader user gets, and what renders while a plan image loads (FR-2.4).
 */
export default function FloorScreen() {
  const { id, name, date: dateParam, kind: kindParam, near, nearName } = useLocalSearchParams<{
    id: string;
    name?: string;
    /** Set when arriving from a booking, so the plan opens on that booking's day. */
    date?: string;
    /**
     * Which toggle to open on, set when arriving from "Book a room" on the home
     * screen. Desks and rooms are the same plan (TDD §4), so the intent has to
     * survive the trip or the user lands on desks and has to say "rooms" again.
     */
    kind?: string;
    /** A colleague's desk to sit near, set when arriving from their screen (FR-5.3). */
    near?: string;
    nearName?: string;
  }>();
  const { token, me } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  // Validated rather than cast: the param is a string off a URL, and anything that
  // is not "room" means desks — which is also the right answer when it is absent.
  const [kind, setKind] = useState<"desk" | "room">(kindParam === "room" ? "room" : "desk");
  const [view, setView] = useState<"plan" | "list">("plan");
  // No device date anywhere here. "Today" is defined by the site's timezone, never the
  // phone's (TDD §5) — opening this screen in Berlin from a phone still on the previous
  // day would otherwise land on a day the office was shut.
  // `|| null`, not `?? null`: an absent route param arrives as the empty string, and
  // `?? ` would keep it and then never fall back to the site's today.
  const [picked, setPicked] = useState<string | null>(dateParam || null);
  const [selected, setSelected] = useState<ResourceAvailability | null>(null);
  const [problem, setProblem] = useState<Refusal | null>(null);
  const [showDays, setShowDays] = useState(false);

  const { site } = useHomeSite();

  // The day picker, the site's notion of today, and the alternatives offered when a
  // day is refused all come from here. A floor's own availability cannot answer
  // "which other day would work".
  const week = useQuery({
    queryKey: ["week", site?.id, kind],
    queryFn: () => api.week(token!, site!.id, undefined, 14, kind),
    enabled: !!token && !!site,
  });

  const date = picked ?? week.data?.today ?? null;
  const dayInfo = week.data?.days.find((d) => d.local_date === date) ?? null;
  const setDate = setPicked;

  const availability = useQuery({
    queryKey: ["availability", id, date, kind],
    queryFn: () => api.availability(token!, id, date!, kind),
    enabled: !!token && !!id && !!date,
  });

  const data = availability.data;

  // Who is in, for this site and day. Only the people the server is willing to name:
  // a colleague set to "nobody" is simply absent from the response, so their desk
  // renders as an anonymous taken dot (TDD §11). Skipped entirely when the org has
  // presence switched off, where every one of these calls would 404.
  const presenceOn = me?.features?.presence !== false;
  const presence = useQuery({
    queryKey: ["presence", site?.id, date],
    queryFn: () => api.presence(token!, site!.id, date!),
    enabled: !!token && !!site && !!date && presenceOn,
  });

  const occupants = useMemo(() => {
    const map = new Map<string, Occupant>();
    for (const person of presence.data?.people ?? []) {
      // Presence covers the whole site; this screen is one floor of it.
      if (person.seat && person.seat.floor_id === id) {
        map.set(person.seat.resource_id, { id: person.user_id, initials: person.initials });
      }
    }
    return map;
  }, [presence.data, id]);

  const occupantNames = useMemo(() => {
    const map = new Map<string, { id: string; name: string; initials: string }>();
    for (const person of presence.data?.people ?? []) {
      if (person.seat) {
        map.set(person.seat.resource_id, {
          id: person.user_id,
          name: person.display_name,
          initials: person.initials,
        });
      }
    }
    return map;
  }, [presence.data]);

  // "Sit near" resolves against the day being shown, not the day we arrived with: change
  // the date and their desk is no longer theirs, which the bar has to be able to say.
  const nearSeat = near ? (data?.resources.find((r) => r.id === near) ?? null) : null;
  const nearestFree = () => {
    const point = { x: nearSeat?.position?.x ?? 0, y: nearSeat?.position?.y ?? 0 };
    const free = (data?.resources ?? []).filter(
      (r) => r.kind === "desk" && r.available && r.bookable && !r.restriction && r.id !== near,
    );
    const pick = nearestTo(point, free);
    if (pick) setSelected(pick);
  };

  const book = useMutation({
    mutationFn: (resource: ResourceAvailability) =>
      api.createBooking(
        token!,
        { resource_id: resource.id, local_date: date! },
        // One key per user intent, so a retry replays rather than double-books.
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["availability"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
    onError: (error) => {
      setSelected(null);
      // Refusals are rendered from violation codes, never from server prose (TDD §11).
      if (error instanceof ProblemError) {
        setProblem(refusal(error.violations, error.detail));
        if (error.status === 409) {
          queryClient.invalidateQueries({ queryKey: ["availability"] });
        }
        return;
      }
      setProblem(refusal([], "Could not reach the server."));
    },
  });

  const zoneName = (zoneId: string | null) =>
    data?.zones.find((z) => z.id === zoneId)?.name ?? null;

  const planLoading = availability.isLoading || !date;
  const planError =
    availability.error instanceof ProblemError
      ? describeAll(availability.error.violations, availability.error.detail)
      : availability.isError
        ? "Couldn't load availability."
        : null;

  return (
    <>
      {/* "Back", not "Spaces": this screen is reached from the Spaces tab AND from the
          pick-a-floor step, and naming one of them is wrong half the time. */}
      <Stack.Screen options={{ title: name ?? "Floor", headerBackTitle: "Back" }} />
      <View style={styles.screen}>
        {view === "plan" ? (
          <View style={styles.stage}>
            {data && !planError ? (
              <FloorPlanStage
                data={data}
                occupants={occupants}
                focusId={near ?? null}
                onSelect={setSelected}
                bottomInset={insets.bottom}
              />
            ) : (
              <View style={styles.stageEmpty}>
                {planLoading ? (
                  <ActivityIndicator color={theme.color.accentText} />
                ) : (
                  <Text style={styles.emptyText}>
                    {planError ?? `No ${kind}s on this floor.`}
                  </Text>
                )}
              </View>
            )}

            {/* Floating controls. They sit on the plan rather than stacking above it,
                which is what frees the screen for the drawing. */}
            <View style={[styles.floatRow, { top: spacing(1) }]}>
              <View style={styles.floatGroup}>
                {(["plan", "list"] as const).map((v) => (
                  <Pressable
                    key={v}
                    onPress={() => setView(v)}
                    style={[styles.pill, view === v && styles.pillOn]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: view === v }}
                    accessibilityLabel={v === "plan" ? "Floor plan view" : "List view"}
                  >
                    <Text style={[styles.pillText, view === v && styles.pillTextOn]}>
                      {v === "plan" ? "Plan" : "List"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => setShowDays((open) => !open)}
                style={styles.floatChip}
                accessibilityRole="button"
                accessibilityLabel={`Change day, currently ${date ?? "loading"}`}
              >
                <Text style={styles.chipStrong}>{date ? shortDay(date) : "…"}</Text>
              </Pressable>
            </View>

            {showDays ? (
              <View style={styles.dayTray}>
                <WeekStrip
                  days={week.data?.days ?? []}
                  value={date ?? ""}
                  today={week.data?.today}
                  onChange={(d) => {
                    setDate(d);
                    setShowDays(false);
                  }}
                />
              </View>
            ) : null}

            <View style={[styles.floatRow, { top: spacing(7) }]}>
              <View style={styles.floatChip}>
                {dayInfo && !dayInfo.is_open ? (
                  <Text style={styles.chipMuted}>Closed</Text>
                ) : (
                  <>
                    <Text style={styles.chipFree}>{data?.available ?? 0} free</Text>
                    <Text style={styles.chipMuted}>of {data?.total ?? 0}</Text>
                  </>
                )}
              </View>
              <View style={{ flex: 1 }} />
              <View style={styles.floatGroup}>
                {(["desk", "room"] as const).map((k) => (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    style={[styles.pill, kind === k && styles.pillOn]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: kind === k }}
                  >
                    <Text style={[styles.pillText, kind === k && styles.pillTextOn]}>
                      {k === "desk" ? "Desks" : "Rooms"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.listBar}>
              <View style={styles.floatGroup}>
                {(["plan", "list"] as const).map((v) => (
                  <Pressable
                    key={v}
                    onPress={() => setView(v)}
                    style={[styles.pill, view === v && styles.pillOn]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: view === v }}
                    accessibilityLabel={v === "plan" ? "Floor plan view" : "List view"}
                  >
                    <Text style={[styles.pillText, view === v && styles.pillTextOn]}>
                      {v === "plan" ? "Plan" : "List"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={{ flex: 1 }} />
              <View style={styles.floatGroup}>
                {(["desk", "room"] as const).map((k) => (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    style={[styles.pill, kind === k && styles.pillOn]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: kind === k }}
                  >
                    <Text style={[styles.pillText, kind === k && styles.pillTextOn]}>
                      {k === "desk" ? "Desks" : "Rooms"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <WeekStrip
              days={week.data?.days ?? []}
              value={date ?? ""}
              today={week.data?.today}
              onChange={setDate}
            />

            <FlatList
              data={data?.resources ?? []}
              keyExtractor={(r) => r.id}
              contentContainerStyle={{ padding: spacing(2) }}
              refreshing={availability.isRefetching}
              onRefresh={() => availability.refetch()}
              ListHeaderComponent={
                <Text style={styles.count}>
                  {data
                    ? `${data.available} of ${data.total} ${kind}s free`
                    : planLoading
                      ? "Loading…"
                      : ""}
                </Text>
              }
              ListEmptyComponent={
                planLoading ? null : (
                  <Text style={styles.emptyText}>
                    {/* A closed day, a blackout or a full office all arrive here as a
                        refusal with a code — say which, rather than showing an empty
                        list that looks like a loading bug (FR-6.9). */}
                    {planError ?? `No ${kind}s on this floor.`}
                  </Text>
                )
              }
              renderItem={({ item }) => (
                <ResourceRow resource={item} onPress={() => setSelected(item)} />
              )}
            />
          </>
        )}

        {/* FR-5.3. The colleague's desk is already ringed on the plan; this is the part
            that does the work, because "near" is a sort over positions the screen
            already has rather than a question for the server. */}
        {near ? (
          <View style={[styles.nearBar, { paddingBottom: insets.bottom + spacing(1) }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.nearTitle} numberOfLines={1}>
                {nearSeat
                  ? `Sitting near ${nearName ?? "a colleague"}`
                  : `${nearName ?? "They"} aren't at a desk here`}
              </Text>
              <Text style={styles.nearSub} numberOfLines={1}>
                {nearSeat
                  ? `${nearSeat.code} · ringed on the plan`
                  : "Their desk isn't on this floor on this day."}
              </Text>
            </View>
            {nearSeat ? (
              <Button label="Nearest free desk" onPress={nearestFree} style={{ flexShrink: 0 }} />
            ) : null}
          </View>
        ) : null}
      </View>

      <DeskSheet
        resource={selected}
        localDate={date ?? ""}
        zoneName={selected ? zoneName(selected.zone_id) : null}
        occupant={selected ? occupantNames.get(selected.id) ?? null : null}
        booking={book.isPending}
        onBook={(r) => book.mutate(r)}
        onClose={() => setSelected(null)}
      />

      <RefusalSheet
        refusal={problem}
        week={week.data?.days ?? []}
        onPickDay={setDate}
        onClose={() => setProblem(null)}
      />
    </>
  );
}

/**
 * Measures the space it is given and hands it to the plan. Kept separate so the
 * measurement re-render cannot touch the plan's gesture state.
 */
function FloorPlanStage({
  data,
  occupants,
  focusId,
  onSelect,
  bottomInset,
}: {
  data: Availability;
  occupants: Map<string, Occupant>;
  focusId: string | null;
  onSelect: (r: ResourceAvailability) => void;
  bottomInset: number;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  return (
    <View
      style={{ flex: 1 }}
      onLayout={(e) =>
        setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
      }
    >
      {size.height > 0 ? (
        <FloorPlan
          resources={data.resources}
          zones={data.zones}
          plan={data.plan}
          height={size.height - bottomInset}
          occupants={occupants}
          focusId={focusId}
          onSelect={onSelect}
        />
      ) : null}
    </View>
  );
}


function ResourceRow({
  resource,
  onPress,
}: {
  resource: ResourceAvailability;
  onPress: () => void;
}) {
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
      style={[styles.row, state !== "free" && styles.rowMuted]}
      accessibilityRole="button"
      accessibilityLabel={`${resource.code}, ${label}`}
      accessibilityHint="Double tap for details"
    >
      {/* State is carried by a label and a shape as well as colour — colour alone
          cannot communicate availability accessibly (TDD §13.3). */}
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
      <Text style={[styles.state, state === "free" && styles.stateFree]}>{label}</Text>
    </Pressable>
  );
}

function shortDay(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
  });
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  stage: { flex: 1 },
  stageEmpty: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: spacing(4),
  },

  floatRow: {
    position: "absolute" as const,
    left: spacing(2),
    right: spacing(2),
    flexDirection: "row" as const,
    alignItems: "center" as const,
  },
  floatGroup: {
    flexDirection: "row" as const,
    gap: 2,
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: t.color.surface,
    shadowColor: "#101218",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  floatChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(0.75),
    paddingVertical: spacing(0.75),
    paddingHorizontal: spacing(1.5),
    borderRadius: radius.pill,
    backgroundColor: t.color.surface,
    shadowColor: "#101218",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  dayTray: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    top: spacing(6),
    backgroundColor: t.color.ground,
    paddingBottom: spacing(0.5),
  },
  pill: {
    paddingVertical: spacing(0.75),
    paddingHorizontal: spacing(1.75),
    borderRadius: radius.pill,
  },
  pillOn: { backgroundColor: t.color.accent },
  pillText: { ...at(type.sub, 13), color: t.color.muted, fontWeight: "600" as const },
  pillTextOn: { color: t.color.onAccent },
  chipStrong: { ...at(type.sub, 13), color: t.color.ink, fontWeight: "700" as const },
  chipFree: { ...at(type.sub, 13), color: t.color.state.free, fontWeight: "700" as const },
  chipMuted: { ...at(type.sub, 12), color: t.color.muted },

  nearBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    paddingHorizontal: spacing(2),
    paddingTop: spacing(1.5),
    backgroundColor: t.color.surface,
    borderTopWidth: 1,
    borderTopColor: t.color.line,
  },
  nearTitle: { ...type.body, color: t.color.ink, fontWeight: "600" as const },
  nearSub: { ...at(type.sub, 13), color: t.color.muted, marginTop: 1 },

  listBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: spacing(2),
    paddingTop: spacing(1),
  },
  count: { ...type.sub, color: t.color.muted, marginBottom: spacing(1) },
  emptyText: { ...type.body, color: t.color.muted, textAlign: "center" as const },

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
  dot_yours: {
    backgroundColor: t.color.state.yours,
    borderWidth: 2,
    borderColor: t.color.state.yours,
  },
  dot_unavailable: {
    backgroundColor: "transparent",
    borderWidth: 2,
    borderColor: t.color.state.closed,
  },
  code: { ...type.code, color: t.color.ink },
  meta: { ...at(type.sub, 12), color: t.color.muted, marginTop: 2 },
  state: { ...at(type.sub, 12), color: t.color.muted },
  stateFree: { color: t.color.state.free, fontWeight: "600" as const },
});
