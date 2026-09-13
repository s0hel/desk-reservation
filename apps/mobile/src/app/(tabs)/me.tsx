import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import { useAuth } from "@/lib/auth";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

export default function Me() {
  const { me, signOut } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing(2) }}>
      <View style={styles.identity}>
        <View style={styles.avatar}>
          <Text style={styles.initials}>{initialsOf(me?.display_name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{me?.display_name}</Text>
          <Text style={styles.sub}>{me?.email}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Row label="Roles" value={me?.roles.join(", ") ?? "—"} />
        <Row label="Locale" value={me?.locale ?? "—"} />
        {/* Enforced server-side in the query layer, not here (TDD §11, PRD Q6). */}
        <Row label="Presence visibility" value={me?.presence_visibility ?? "—"} />
        <Row label="Organization" value={me?.organization_id.slice(0, 8) ?? "—"} last />
      </View>

      <Pressable onPress={signOut} style={styles.signOut} accessibilityRole="button">
        <Icon name="signOut" size={17} color={theme.color.danger} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

/** Tinted initials rather than a photograph: nothing to upload, nothing to moderate. */
function initialsOf(name?: string) {
  if (!name) return "—";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  identity: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    marginBottom: spacing(2.5),
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: t.color.accent,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  initials: { ...type.heading, color: t.color.onAccent },
  name: { ...type.title, color: t.color.ink },
  sub: { ...type.sub, color: t.color.muted },
  card: { ...t.card, borderRadius: radius.l, paddingHorizontal: spacing(2) },
  row: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    gap: spacing(2),
    paddingVertical: spacing(1.5),
    borderBottomColor: t.color.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { ...type.sub, color: t.color.muted },
  rowValue: { ...type.sub, color: t.color.ink, fontWeight: "600" as const },
  signOut: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: spacing(1),
    marginTop: spacing(3),
    padding: spacing(2),
    borderRadius: radius.pill,
    borderColor: t.color.line,
    borderWidth: 1,
  },
  signOutText: { ...type.body, color: t.color.danger, fontWeight: "600" as const },
});
