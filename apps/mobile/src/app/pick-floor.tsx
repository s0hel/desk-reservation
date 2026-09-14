import { Stack, useLocalSearchParams } from "expo-router";

import { FloorList } from "@/components/FloorList";

/**
 * Choose a floor for a particular day — the step between "Find a desk" on the home
 * screen and the plan itself.
 *
 * A pushed stack screen rather than the Spaces tab, because the day is the whole point
 * of it and a tab outlives the intent that set it.
 */
export default function PickFloor() {
  const { date } = useLocalSearchParams<{ date?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: "Pick a floor", headerBackTitle: "Back" }} />
      <FloorList localDate={date || undefined} />
    </>
  );
}
