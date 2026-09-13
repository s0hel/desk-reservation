import { Tabs } from "expo-router";

import { Icon } from "@/components/Icon";
import { type, useTheme } from "@/lib/theme";

export default function TabsLayout() {
  const theme = useTheme();

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
        name="me"
        options={{
          title: "Me",
          tabBarIcon: ({ color, size }) => <Icon name="person" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
