import { ActivityIndicator, Pressable, Text, type ViewStyle } from "react-native";

import { Icon, type IconName } from "@/components/Icon";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

type Variant = "primary" | "ghost" | "quiet" | "clay";

/**
 * One button. Variants exist so a screen cannot invent a fifth shade of the accent,
 * which is how a design system stops being one.
 *
 * `clay` is reserved for anything time-boxed — checking in before a window closes,
 * claiming a desk about to be auto-released — so urgency reads without the button
 * having to shout in the accent colour.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  busy = false,
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inactive = busy || disabled;

  const tint = {
    primary: theme.color.onAccent,
    clay: theme.color.onAccent,
    ghost: theme.color.accentText,
    quiet: theme.color.inkSoft,
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      style={[styles.base, styles[variant], inactive && styles.inactive, style]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
    >
      {busy ? (
        <ActivityIndicator color={tint} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={17} color={tint} /> : null}
          <Text style={[styles.label, { color: tint }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const makeStyles = (t: Theme) => ({
  base: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: spacing(1),
    minHeight: 46,
    paddingHorizontal: spacing(2),
    borderRadius: radius.pill,
  },
  primary: { backgroundColor: t.color.accent },
  clay: { backgroundColor: t.color.clay },
  ghost: { backgroundColor: "transparent", borderWidth: 1.25, borderColor: t.color.accent },
  quiet: { backgroundColor: t.color.surfaceAlt },
  inactive: { opacity: 0.55 },
  label: { ...type.body, fontWeight: "600" as const },
});
