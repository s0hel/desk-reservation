import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";

export default function Me() {
  const { me, signOut } = useAuth();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing(2) }}>
      <Text style={styles.name}>{me?.display_name}</Text>
      <Text style={styles.sub}>{me?.email}</Text>

      <View style={styles.card}>
        <Row label="Roles" value={me?.roles.join(", ") ?? "—"} />
        <Row label="Locale" value={me?.locale ?? "—"} />
        {/* Enforced server-side in the query layer, not here (TDD §11, PRD Q6). */}
        <Row label="Presence visibility" value={me?.presence_visibility ?? "—"} />
        <Row label="Organization" value={me?.organization_id.slice(0, 8) ?? "—"} />
      </View>

      <Pressable onPress={signOut} style={styles.signOut} accessibilityRole="button">
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  name: { color: colors.text, fontSize: 26, fontWeight: "700" },
  sub: { color: colors.muted, marginBottom: spacing(2) },
  card: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 14, paddingHorizontal: spacing(2),
  },
  row: {
    flexDirection: "row", justifyContent: "space-between", paddingVertical: spacing(1.5),
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { color: colors.muted },
  rowValue: { color: colors.text, fontWeight: "500" },
  signOut: {
    marginTop: spacing(3), padding: spacing(2), borderRadius: 12,
    borderColor: colors.border, borderWidth: 1, alignItems: "center",
  },
  signOutText: { color: colors.danger, fontWeight: "600" },
});
