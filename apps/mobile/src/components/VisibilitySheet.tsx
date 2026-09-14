/**
 * Who can see where you'll be (FR-5.6).
 *
 * Written in terms of what other people will see, not in terms of the setting's name.
 * "Nobody" in particular has to state its real consequence — you disappear from the
 * team grid entirely, rather than appearing with your days blanked — because the
 * server enforces it by leaving you out of the result set (TDD §11), and a control
 * that undersells what it does gets chosen by people who wanted something milder.
 */

import { Pressable, Text, View } from "react-native";

import { Sheet } from "@/components/Sheet";
import { Icon } from "@/components/Icon";
import type { Visibility } from "@/lib/api";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

const OPTIONS: { value: Visibility; title: string; note: string }[] = [
  {
    value: "everyone",
    title: "Everyone",
    note: "Anyone at your company can see the days you're in and where you sit.",
  },
  {
    value: "team_only",
    title: "My teams only",
    note: "Only people in a group with you. Everyone else won't see you at all.",
  },
  {
    value: "nobody",
    title: "Nobody",
    note: "You won't appear in anyone's team view or on the plan. You can still book as normal.",
  },
];

export function VisibilitySheet({
  visible,
  value,
  busy,
  onChange,
  onClose,
}: {
  visible: boolean;
  value: Visibility;
  busy: boolean;
  onChange: (next: Visibility) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <Sheet visible={visible} onClose={onClose} title="Who can see your days">
      {OPTIONS.map((option) => {
        const on = value === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            disabled={busy}
            style={[styles.option, on && styles.optionOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: busy }}
            accessibilityLabel={`${option.title}. ${option.note}`}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, on && styles.titleOn]}>{option.title}</Text>
              <Text style={styles.note}>{option.note}</Text>
            </View>
            {on ? <Icon name="check" size={18} color={theme.color.accentText} /> : null}
          </Pressable>
        );
      })}
    </Sheet>
  );
}

const makeStyles = (t: Theme) => ({
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
  title: { ...type.body, color: t.color.ink, fontWeight: "600" as const },
  titleOn: { color: t.color.accentText },
  note: { ...type.sub, color: t.color.muted, marginTop: 1 },
});
