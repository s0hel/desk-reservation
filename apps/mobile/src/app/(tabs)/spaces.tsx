import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

export default function Spaces() {
  const { token } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api.sites(token!), enabled: !!token });
  const siteId = sites.data?.[0]?.id;

  const floors = useQuery({
    queryKey: ["floors", siteId],
    queryFn: () => api.floors(token!, siteId!),
    enabled: !!token && !!siteId,
  });

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ padding: spacing(2) }}
      data={floors.data ?? []}
      keyExtractor={(f) => f.id}
      ListHeaderComponent={
        <Text style={styles.header}>{sites.data?.[0]?.name ?? "Loading…"}</Text>
      }
      ListEmptyComponent={<Text style={styles.sub}>No floors yet — run `make seed`.</Text>}
      renderItem={({ item }) => (
        <Link href={{ pathname: "/floor/[id]", params: { id: item.id, name: item.name } }} asChild>
          <Pressable
            style={styles.card}
            accessibilityRole="link"
            accessibilityLabel={`${item.name}, see the plan`}
          >
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.cardMeta}>See the plan</Text>
            </View>
            <Icon name="chevronRight" size={20} color={theme.color.muted} />
          </Pressable>
        </Link>
      )}
    />
  );
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  header: { ...type.display, color: t.color.ink, marginBottom: spacing(2) },
  sub: { ...type.body, color: t.color.muted },
  card: {
    ...t.card,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    borderRadius: radius.l,
    padding: spacing(2),
    marginBottom: spacing(1.5),
  },
  cardBody: { flex: 1 },
  cardTitle: { ...type.heading, color: t.color.ink },
  cardMeta: { ...type.sub, color: t.color.muted, marginTop: spacing(0.25) },
});
