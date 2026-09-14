/**
 * The week, with how full each day is (FR-2.1).
 *
 * The old date strip drew seven identical boxes. Every one of them looked equally
 * bookable, so finding out that Wednesday was full took a tap, a load, and a refusal.
 * The availability was already on the wire — it was simply never drawn.
 *
 * Four states, distinguishable without colour: open (a bar showing the free
 * proportion), full (a bar at zero), closed (no bar at all, dimmed), and blacked out —
 * an admin has shut the day (FR-6.5), which renders like closed because nothing can be
 * booked, and carries its reason in the accessibility label. "Closed" and "full" must
 * never look the same: one is the office being shut, the other is everyone else having
 * got there first.
 */

import { Pressable, ScrollView, Text, View } from "react-native";

import type { DayAvailability } from "@/lib/api";
import { at, radius, spacing, type, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  days: DayAvailability[];
  value: string;
  today?: string;
  onChange: (localDate: string) => void;
};

function parts(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  const on = new Date(y, m - 1, d);
  return {
    weekday: on.toLocaleDateString(undefined, { weekday: "short" }),
    day: String(on.getDate()),
  };
}

export function WeekStrip({ days, value, today, onChange }: Props) {
  const styles = useThemedStyles(makeStyles);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.row}
    >
      {days.map((d) => {
        const { weekday, day } = parts(d.local_date);
        const selected = d.local_date === value;
        // A blacked-out day is shut, not full. Rendering it as full would send people
        // to a plan that refuses every desk on it.
        const shut = !d.is_open || d.blackout === true;
        const full = !shut && d.available === 0;
        const free = d.total > 0 ? d.available / d.total : 0;

        const spoken = d.blackout
          ? `closed${d.blackout_reason ? `, ${d.blackout_reason}` : ""}`
          : !d.is_open
            ? "closed"
            : full
              ? "full"
              : `${d.available} of ${d.total} free`;

        return (
          <Pressable
            key={d.local_date}
            onPress={() => onChange(d.local_date)}
            disabled={shut}
            style={[styles.cell, selected && styles.cellSelected, shut && styles.cellClosed]}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: shut }}
            accessibilityLabel={`${d.local_date === today ? "Today, " : ""}${weekday} ${day}, ${spoken}`}
          >
            <Text style={[styles.weekday, selected && styles.onSelected]}>
              {d.local_date === today ? "TODAY" : weekday.toUpperCase()}
            </Text>
            <Text style={[styles.day, selected && styles.onSelected]}>{day}</Text>

            {!shut ? (
              <View style={[styles.bar, selected && styles.barSelected]}>
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${Math.max(full ? 100 : 6, free * 100)}%`,
                      backgroundColor: selected
                        ? "#FFFFFF"
                        : full
                          ? styles.fullFill.color
                          : styles.freeFill.color,
                    },
                  ]}
                />
              </View>
            ) : (
              // Closed days get no bar at all. A zero-length bar would read as full.
              <View style={styles.barEmpty} />
            )}

            {d.my_booking ? (
              <View style={[styles.dot, selected && styles.dotSelected]} />
            ) : (
              <View style={styles.dotSpacer} />
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => ({
  strip: { flexGrow: 0 },
  row: {
    alignItems: "center" as const,
    gap: spacing(0.75),
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(1),
  },
  cell: {
    ...t.card,
    minWidth: 56,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(0.75),
    borderRadius: radius.m,
    alignItems: "center" as const,
    gap: spacing(0.5),
  },
  cellSelected: { backgroundColor: t.color.accent, borderColor: t.color.accent, shadowOpacity: 0 },
  cellClosed: { backgroundColor: "transparent", shadowOpacity: 0, borderWidth: 0, opacity: 0.45 },
  weekday: { ...at(type.label, 9), letterSpacing: 0.6, color: t.color.muted },
  day: { ...at(type.heading, 18), color: t.color.ink },
  onSelected: { color: t.color.onAccent },
  bar: {
    width: 22,
    height: 3,
    borderRadius: 2,
    overflow: "hidden" as const,
    backgroundColor: t.color.line,
  },
  barSelected: { backgroundColor: "rgba(255,255,255,0.35)" },
  barEmpty: { width: 22, height: 3 },
  fill: { height: "100%" as const },
  // Carried as styles so the palette stays the single source of these two hues.
  freeFill: { color: t.color.state.free },
  fullFill: { color: t.color.state.closed },
  dot: { width: 5, height: 5, borderRadius: radius.pill, backgroundColor: t.color.clay },
  dotSelected: { backgroundColor: t.color.onAccent },
  dotSpacer: { width: 5, height: 5 },
});
