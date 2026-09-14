/**
 * "I'm not coming in" (FR-5.5).
 *
 * The point of declaring a day away is not the record — it is that a teammate checking
 * Thursday sees "working remotely" instead of silence and can stop wondering. So the
 * three kinds are named the way a person would say them, and each one says what it
 * tells other people, because that consequence is the entire reason to tap anything
 * here.
 */

import { Pressable, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Icon, type IconName } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { formatDate } from "@/lib/dates";
import { ABSENCE_KINDS, type AbsenceKind } from "@/lib/presence";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

const OPTIONS: Record<AbsenceKind, { title: string; note: string; icon: IconName }> = {
  remote: { title: "Working remotely", note: "You're working, just not from the office.", icon: "home" },
  leave: { title: "On leave", note: "Holiday, sick day, or otherwise off.", icon: "leave" },
  travel: { title: "Travelling", note: "Away on business — customer visit, another site.", icon: "travel" },
};

type Props = {
  localDate: string | null;
  current: AbsenceKind | null;
  busy: boolean;
  onDeclare: (kind: AbsenceKind) => void;
  onClear: () => void;
  onClose: () => void;
};

export function AbsenceSheet({ localDate, current, busy, onDeclare, onClear, onClose }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <Sheet
      visible={localDate !== null}
      onClose={onClose}
      title={localDate ? formatDate(localDate) : ""}
    >
      <Text style={styles.intro}>
        Tell your team where you&apos;ll be. It doesn&apos;t book anything.
      </Text>

      {ABSENCE_KINDS.map((kind) => {
        const option = OPTIONS[kind];
        const on = current === kind;
        return (
          <Pressable
            key={kind}
            onPress={() => onDeclare(kind)}
            disabled={busy}
            style={[styles.option, on && styles.optionOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: busy }}
            accessibilityLabel={`${option.title}. ${option.note}`}
          >
            <Icon
              name={option.icon}
              size={20}
              color={on ? theme.color.accentText : theme.color.muted}
            />
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionTitle, on && styles.optionTitleOn]}>{option.title}</Text>
              <Text style={styles.optionNote}>{option.note}</Text>
            </View>
            {/* Checked state is a tick as well as a tint: the selected row must not
                depend on a colour difference alone. */}
            {on ? <Icon name="check" size={18} color={theme.color.accentText} /> : null}
          </Pressable>
        );
      })}

      {current ? (
        <Button label="Clear this day" variant="quiet" busy={busy} onPress={onClear} />
      ) : null}
    </Sheet>
  );
}

const makeStyles = (t: Theme) => ({
  intro: { ...type.sub, color: t.color.muted },
  option: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    padding: spacing(1.5),
    borderRadius: radius.m,
    borderWidth: 1.25,
    borderColor: t.color.line,
  },
  optionOn: { borderColor: t.color.accent, backgroundColor: t.color.accentSoft },
  optionTitle: { ...type.body, color: t.color.ink, fontWeight: "600" as const },
  optionTitleOn: { color: t.color.accentText },
  optionNote: { ...type.sub, color: t.color.muted, marginTop: 1 },
});
