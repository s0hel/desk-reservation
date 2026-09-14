/**
 * One colleague in a list.
 *
 * The status is always words — "Working remotely", not a coloured dot — because a row
 * that encodes where somebody is in hue alone is unreadable to the 8% this design
 * system already accounts for on the floor plan, and unreadable to a screen reader
 * entirely.
 */

import { Pressable, Text, View } from "react-native";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { statusLabel, type PresenceStatus } from "@/lib/presence";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  id: string;
  name: string;
  initials?: string;
  isMe?: boolean;
  status: PresenceStatus;
  /** Desk code, when the status is "in" and we know where. */
  seat?: string | null;
  /** Floor name, shown beside the desk so the code is placeable. */
  where?: string | null;
  onPress?: () => void;
};

export function PersonRow({ id, name, initials, isMe, status, seat, where, onPress }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const away = status !== "in";

  const detail = status === "in" && seat ? `${seat}${where ? ` · ${where}` : ""}` : statusLabel(status);

  const body = (
    <>
      <Avatar id={id} name={name} initials={initials} muted={away} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
          {isMe ? <Text style={styles.you}>  You</Text> : null}
        </Text>
        <Text style={[styles.detail, status === "in" && styles.detailIn]} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {onPress ? <Icon name="chevronRight" size={18} color={theme.color.muted} /> : null}
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;

  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}${isMe ? ", you" : ""}. ${statusLabel(status)}${
        status === "in" && seat ? `, desk ${seat}` : ""
      }`}
      accessibilityHint="Double tap to see their week"
    >
      {body}
    </Pressable>
  );
}

const makeStyles = (t: Theme) => ({
  row: {
    ...t.card,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    borderRadius: radius.m,
    padding: spacing(1.5),
    marginBottom: spacing(1),
  },
  name: { ...type.body, color: t.color.ink, fontWeight: "600" as const },
  you: { ...type.sub, color: t.color.muted, fontWeight: "400" as const },
  detail: { ...at(type.sub, 13), color: t.color.muted, marginTop: 1 },
  detailIn: { ...at(type.code, 13), color: t.color.inkSoft },
});
