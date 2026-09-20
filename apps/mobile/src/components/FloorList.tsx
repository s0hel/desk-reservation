import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useHomeSite } from "@/lib/site";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

/**
 * The floors of the user's home site, as a list of links to their plans.
 *
 * Shared by the Spaces tab (browse) and the pick-a-floor step (book for a named day).
 * `localDate` is what separates them: when set, every link carries it through to the
 * plan, and the header says which day you are choosing for. `kind` carries the same
 * way, so "Book a room" lands on the rooms toggle rather than on desks.
 */
export function FloorList({
  localDate,
  kind = "desk",
}: {
  localDate?: string;
  kind?: "desk" | "room";
}) {
  const { token } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const { site } = useHomeSite();
  const siteId = site?.id;

  const floors = useQuery({
    queryKey: ["floors", siteId],
    queryFn: () => api.floors(token!, siteId!),
    enabled: !!token && !!siteId,
  });

  const thing = kind === "room" ? "a room" : "a desk";

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ padding: spacing(2) }}
      data={floors.data ?? []}
      keyExtractor={(f) => f.id}
      ListHeaderComponent={
        <View style={styles.head}>
          <Text style={styles.header}>{site?.name ?? "Loading…"}</Text>
          {localDate ? (
            <Text style={styles.forDay}>
              Choosing {thing} for {longDay(localDate)}
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={<Text style={styles.sub}>No floors yet — run `make seed`.</Text>}
      renderItem={({ item }) => (
        <Link
          href={{
            pathname: "/floor/[id]",
            params: { id: item.id, name: item.name, date: localDate ?? "", kind },
          }}
          asChild
        >
          <Pressable
            style={styles.card}
            accessibilityRole="link"
            accessibilityLabel={
              localDate
                ? `${item.name}, see the plan for ${longDay(localDate)}`
                : `${item.name}, see the plan`
            }
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

function longDay(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  head: { marginBottom: spacing(2) },
  header: { ...type.display, color: t.color.ink },
  forDay: {
    ...type.sub,
    color: t.color.accentText,
    fontWeight: "600" as const,
    marginTop: spacing(0.5),
  },
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
