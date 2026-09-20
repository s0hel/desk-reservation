import { Stack, useLocalSearchParams } from "expo-router";

import { FloorList } from "@/components/FloorList";

/**
 * Choose a floor for a particular day — the step between "Book a space" / "Book a
 * room" on the home screen and the plan itself.
 *
 * A pushed stack screen rather than the Spaces tab, because the day is the whole point
 * of it and a tab outlives the intent that set it. `kind` rides through for the same
 * reason: it is part of that intent, not a preference.
 */
export default function PickFloor() {
  const { date, kind } = useLocalSearchParams<{ date?: string; kind?: string }>();
  const wanted = kind === "room" ? "room" : "desk";
  return (
    <>
      <Stack.Screen options={{ title: "Pick a floor", headerBackTitle: "Back" }} />
      <FloorList localDate={date || undefined} kind={wanted} />
    </>
  );
}
