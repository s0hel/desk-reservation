import { Tabs } from "expo-router";

import { Icon } from "@/components/Icon";
import { useAuth } from "@/lib/auth";
import { type, useTheme } from "@/lib/theme";

export default function TabsLayout() {
  const theme = useTheme();
  const { me } = useAuth();
  /**
   * The org-level kill switch (PRD Q6). Some works councils reject colleague
   * visibility outright, and for those tenants every presence route 404s — so the tab
   * has to be absent, not present and broken. Defaults to on while `/v1/me` is still
   * in flight, matching the server's own default.
   */
  const presenceOn = me?.features?.presence !== false;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.ground },
        headerTitleStyle: { ...type.heading, color: theme.color.ink },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: theme.color.surface,
          borderTopColor: theme.color.line,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", letterSpacing: -0.1 },
        tabBarActiveTintColor: theme.color.accentText,
        tabBarInactiveTintColor: theme.color.muted,
        sceneStyle: { backgroundColor: theme.color.ground },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Today",
          tabBarIcon: ({ color, size }) => <Icon name="today" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="spaces"
        options={{
          title: "Spaces",
          tabBarIcon: ({ color, size }) => <Icon name="plan" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: "Team",
          // `href: null` removes the tab from the bar; the route still exists, which
          // is what lets a deep link land somewhere honest rather than nowhere.
          href: presenceOn ? undefined : null,
          tabBarIcon: ({ color, size }) => <Icon name="team" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: "Me",
          tabBarIcon: ({ color, size }) => <Icon name="person" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
