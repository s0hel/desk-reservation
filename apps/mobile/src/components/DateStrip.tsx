import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import { upcomingDays } from "@/lib/dates";
import { colors, spacing } from "@/lib/theme";

export function DateStrip({
  value,
  onChange,
  days = 7,
}: {
  value: string;
  onChange: (date: string) => void;
  days?: number;
}) {
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

const styles = StyleSheet.create({
  // flexGrow:0 stops the scroll view claiming the rest of the screen; alignItems keeps
  // the cells their natural height instead of stretching to the cross axis.
  strip: { flexGrow: 0 },
  row: { alignItems: "center", gap: spacing(1), paddingHorizontal: spacing(2), paddingVertical: spacing(1) },
  cell: {
    minWidth: 52, paddingVertical: spacing(1), borderRadius: 12, alignItems: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  cellSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  weekday: { color: colors.muted, fontSize: 12 },
  day: { color: colors.text, fontSize: 18, fontWeight: "600" },
  textSelected: { color: "#fff" },
});
