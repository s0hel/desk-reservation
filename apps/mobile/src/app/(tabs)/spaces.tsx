import { FloorList } from "@/components/FloorList";

/**
 * Browse the floors. Deliberately carries no day: a tab is a place you return to, and
 * a day pinned to it goes stale silently — tapping Spaces a week later would still
 * claim you were choosing for last Friday, and the floor link would honour it. Booking
 * for a named day goes through `app/pick-floor.tsx`, which is a step you leave.
 */
export default function Spaces() {
  return <FloorList />;
}
