/**
 * What the user sees when the policy engine says no (FR-6.9, TDD §11).
 *
 * The rule is still rendered from `code` + `params` and never from the server's
 * `detail` prose, so this stays localizable. What changes is that a refusal now has
 * room to name the rule, say what would satisfy it, and — when only the day is the
 * problem — offer the nearest day that would work, which is the question the user was
 * about to ask anyway.
 */

import { Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import type { DayAvailability } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import type { Refusal } from "@/lib/messages";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  refusal: Refusal | null;
  /** Days around the refused one, already loaded for the week strip. */
  week?: DayAvailability[];
  onPickDay?: (localDate: string) => void;
  onClose: () => void;
};

export function RefusalSheet({ refusal, week = [], onPickDay, onClose }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const alternatives =
    refusal?.otherDaysHelp && onPickDay
      ? week.filter((d) => d.is_open && d.available > 0).slice(0, 3)
      : [];

  return (
    <Sheet
      visible={refusal !== null}
      onClose={onClose}
      title={refusal?.headline ?? ""}
      showTitle={false}
    >
      {refusal ? (
        <>
          <View style={styles.head}>
            <View style={styles.badge}>
              <Icon name="alert" size={18} color={theme.color.clay} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.headline}>{refusal.headline}</Text>
              {/* Often empty: a shaped headline already says it, and an empty Text
                  still takes a line of the stack's gap. */}
              {refusal.detail ? <Text style={styles.detail}>{refusal.detail}</Text> : null}
            </View>
          </View>

          {refusal.fix ? <Text style={styles.fix}>{refusal.fix}</Text> : null}

          {alternatives.length ? (
            <View style={styles.panel}>
              <Text style={styles.panelLabel}>Nearest days with space</Text>
              {alternatives.map((d) => (
                <View key={d.local_date} style={styles.altRow}>
                  <Text style={styles.altDay}>{formatDate(d.local_date)}</Text>
                  <Text style={styles.altFree}>{d.available} free</Text>
                </View>
              ))}
            </View>
          ) : null}

          {alternatives.length && onPickDay ? (
            <Button
              label={`Go to ${shortDay(alternatives[0].local_date)}`}
              onPress={() => {
                onPickDay(alternatives[0].local_date);
                onClose();
              }}
            />
          ) : null}

          <Button label="Close" variant="quiet" onPress={onClose} />

          {/* Deliberately visible and deliberately small. A screenshot of this sheet
              is enough for support to identify the exact rule that fired. */}
          {refusal.code ? <Text style={styles.code}>{refusal.code}</Text> : null}
        </>
      ) : null}
    </Sheet>
  );
}

function shortDay(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long" });
}

const makeStyles = (t: Theme) => ({
  head: { flexDirection: "row" as const, gap: spacing(1.5), alignItems: "flex-start" as const },
  badge: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: t.color.claySoft,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  headline: { ...at(type.title, 20), color: t.color.ink },
  detail: { ...type.sub, color: t.color.muted, marginTop: spacing(0.5) },
  fix: { ...type.body, color: t.color.inkSoft },
  panel: {
    backgroundColor: t.color.surfaceAlt,
    borderRadius: radius.m,
    padding: spacing(1.5),
    gap: spacing(1),
  },
  panelLabel: { ...type.label, color: t.color.muted },
  altRow: { flexDirection: "row" as const, justifyContent: "space-between" as const },
  altDay: { ...type.sub, color: t.color.ink, fontWeight: "600" as const },
  altFree: { ...type.sub, color: t.color.state.free, fontWeight: "600" as const },
  code: {
    ...at(type.sub, 11),
    color: t.color.muted,
    textAlign: "center" as const,
    opacity: 0.8,
  },
});
