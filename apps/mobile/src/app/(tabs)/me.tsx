import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import { RefusalSheet } from "@/components/RefusalSheet";
import { VisibilitySheet } from "@/components/VisibilitySheet";
import { api, ProblemError, type Visibility } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refusal, type Refusal } from "@/lib/messages";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

const VISIBILITY_LABEL: Record<Visibility, string> = {
  everyone: "Everyone",
  team_only: "My teams only",
  nobody: "Nobody",
};

export default function Me() {
  const { token, me, signOut, refreshMe } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<Refusal | null>(null);

  const presenceOn = me?.features?.presence !== false;

  const setVisibility = useMutation({
    mutationFn: (presence_visibility: Visibility) => api.updateMe(token!, { presence_visibility }),
    onSuccess: async () => {
      setEditing(false);
      await refreshMe();
    },
    onError: (error) =>
      setProblem(
        error instanceof ProblemError
          ? refusal(error.violations, error.detail)
          : refusal([], "Could not reach the server."),
      ),
  });

  return (
    <>
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

        {/* FR-5.6. The setting is real: it is enforced as a condition on every presence
            query, so choosing "nobody" removes you from other people's results rather
            than asking their app to hide you (TDD §11). It is only offered when the org
            has presence switched on at all — otherwise it controls nothing. */}
        {presenceOn ? (
          <>
            <Text style={styles.label}>Presence</Text>
            <Pressable
              style={styles.card}
              onPress={() => setEditing(true)}
              accessibilityRole="button"
              accessibilityLabel={`Who can see your days, currently ${
                VISIBILITY_LABEL[me?.presence_visibility ?? "everyone"]
              }`}
              accessibilityHint="Double tap to change"
            >
              <View style={styles.settingRow}>
                <Icon name="eye" size={20} color={theme.color.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.settingTitle}>Who can see your days</Text>
                  <Text style={styles.settingValue}>
                    {VISIBILITY_LABEL[me?.presence_visibility ?? "everyone"]}
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={theme.color.muted} />
              </View>
            </Pressable>
          </>
        ) : null}

        <Text style={styles.label}>Account</Text>
        <View style={styles.card}>
          <Row label="Roles" value={me?.roles.join(", ") ?? "—"} />
          <Row label="Locale" value={me?.locale ?? "—"} />
          <Row label="Organization" value={me?.organization_id.slice(0, 8) ?? "—"} last />
        </View>

        <Pressable onPress={signOut} style={styles.signOut} accessibilityRole="button">
          <Icon name="signOut" size={17} color={theme.color.danger} />
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>

      <VisibilitySheet
        visible={editing}
        value={me?.presence_visibility ?? "everyone"}
        busy={setVisibility.isPending}
        onChange={(next) => setVisibility.mutate(next)}
        onClose={() => setEditing(false)}
      />

      <RefusalSheet refusal={problem} onClose={() => setProblem(null)} />
    </>
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
  label: { ...type.label, color: t.color.muted, marginBottom: spacing(1) },
  card: {
    ...t.card,
    borderRadius: radius.l,
    paddingHorizontal: spacing(2),
    marginBottom: spacing(2.5),
  },
  settingRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    paddingVertical: spacing(1.75),
  },
  settingTitle: { ...type.body, color: t.color.ink, fontWeight: "600" as const },
  settingValue: { ...type.sub, color: t.color.muted, marginTop: 1 },
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
    marginTop: spacing(1),
    padding: spacing(2),
    borderRadius: radius.pill,
    borderColor: t.color.line,
    borderWidth: 1,
  },
  signOutText: { ...type.body, color: t.color.danger, fontWeight: "600" as const },
});
