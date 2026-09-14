/**
 * A person, as a monogram.
 *
 * Initials rather than photographs, as the server's `initials_of` already assumes:
 * nothing to upload, nothing to moderate, no directory sync to build, and it degrades
 * honestly for a tenant whose IdP carries no images. The tint is derived from the user
 * id, so the same person is the same colour on the plan, in the team grid and on their
 * own screen — which is the only job a monogram has.
 */

import { Text, View, type ViewStyle } from "react-native";

import { initialsOf, tintIndex } from "@/lib/presence";
import { avatarTints, radius, type, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  /** The person's id. Tint follows this, not the name, so a rename keeps the colour. */
  id: string;
  name: string;
  /** Server-supplied initials win when present; it owns the rule for non-Latin names. */
  initials?: string;
  size?: number;
  /** Drained of colour for a day the person is not in — they are still themselves. */
  muted?: boolean;
  /**
   * Override the personal tint. Used only on surfaces that sit over the floor plan,
   * where colour already means availability and the person's name is spelled out
   * beside the monogram anyway — see components/DeskSheet.tsx.
   */
  tint?: string;
  style?: ViewStyle;
};

export function Avatar({ id, name, initials, size = 36, muted = false, tint, style }: Props) {
  const styles = useThemedStyles(makeStyles);
  const fill = tint ?? avatarTints[tintIndex(id, avatarTints.length)];

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius.pill,
          backgroundColor: fill,
          opacity: muted ? 0.4 : 1,
        },
        styles.bubble,
        style,
      ]}
      // The name is always adjacent in a list, so the bubble itself is decoration.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.initials, { fontSize: Math.round(size * 0.38) }]}>
        {initials || initialsOf(name)}
      </Text>
    </View>
  );
}

const makeStyles = (t: Theme) => ({
  bubble: { alignItems: "center" as const, justifyContent: "center" as const },
  initials: { ...type.heading, color: "#FFFFFF", letterSpacing: 0.2 },
});
