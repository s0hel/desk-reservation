/**
 * One office, chooseable (FR-1.9).
 *
 * Shared by the first-run picker and the Me tab's home-office sheet, because it is
 * the same decision in two places — and a tick that means "selected" in one and a
 * tint that means it in the other is how a design system stops being one.
 *
 * Selection carries a tick as well as the tint: colour alone never means anything in
 * this app (see `lib/theme.ts`).
 */

import { Pressable, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import { placeName, type Site } from "@/lib/api";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

export function SiteOption({
  site,
  selected,
  disabled = false,
  onPress,
}: {
  site: Site;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.row, selected && styles.rowOn, disabled && styles.rowOff]}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      // The full name, not the short one: two offices in the same city are told apart
      // by exactly the part `short_name` throws away.
      accessibilityLabel={`${site.name}${site.address ? `, ${site.address}` : ""}`}
    >
      <Icon
        name="building"
        size={22}
        color={selected ? theme.color.accentText : theme.color.muted}
      />
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, selected && styles.titleOn]}>{site.name}</Text>
        {/* The address rather than the timezone: somebody choosing between two
            buildings knows which street they walk to, not which IANA zone it is in. */}
        <Text style={styles.sub} numberOfLines={1}>
          {site.address ?? placeName(site)}
        </Text>
      </View>
      {selected ? <Icon name="check" size={20} color={theme.color.accentText} /> : null}
    </Pressable>
  );
}

const makeStyles = (t: Theme) => ({
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    padding: spacing(1.5),
    borderRadius: radius.m,
    borderWidth: 1.25,
    borderColor: t.color.line,
  },
  rowOn: { borderColor: t.color.accent, backgroundColor: t.color.accentSoft },
  rowOff: { opacity: 0.55 },
  title: { ...type.body, color: t.color.ink, fontWeight: "600" as const },
  titleOn: { color: t.color.accentText },
  sub: { ...type.sub, color: t.color.muted, marginTop: 1 },
});
