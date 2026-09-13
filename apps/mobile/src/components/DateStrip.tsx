import { Pressable, ScrollView, Text } from "react-native";

import { upcomingDays } from "@/lib/dates";
import { radius, spacing, type, useThemedStyles, type Theme } from "@/lib/theme";

export function DateStrip({
  value,
  onChange,
  days = 7,
}: {
  value: string;
  onChange: (date: string) => void;
  days?: number;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.row}
    >
      {upcomingDays(days).map((d) => {
        const selected = d.date === value;
        return (
          <Pressable
            key={d.date}
            onPress={() => onChange(d.date)}
            style={[styles.cell, selected && styles.cellSelected]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={d.isToday ? `Today, ${d.weekday} ${d.day}` : `${d.weekday} ${d.day}`}
          >
            <Text style={[styles.weekday, selected && styles.textSelected]}>{d.weekday}</Text>
            <Text style={[styles.day, selected && styles.textSelected]}>{d.day}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => ({
  // flexGrow:0 stops the scroll view claiming the rest of the screen; alignItems keeps
  // the cells their natural height instead of stretching to the cross axis.
  strip: { flexGrow: 0 },
  row: {
    alignItems: "center" as const,
    gap: spacing(1),
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(1),
  },
  cell: {
    ...t.card,
    minWidth: 54,
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(1),
    borderRadius: radius.m,
    alignItems: "center" as const,
  },
  cellSelected: { backgroundColor: t.color.accent, borderColor: t.color.accent, shadowOpacity: 0 },
  weekday: { ...type.label, fontSize: 10, letterSpacing: 0.6, color: t.color.muted },
  day: { ...type.heading, fontSize: 18, color: t.color.ink, marginTop: 2 },
  textSelected: { color: t.color.onAccent },
});
