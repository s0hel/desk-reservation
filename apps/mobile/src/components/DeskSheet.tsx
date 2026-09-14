/**
 * Desk and room detail.
 *
 * Replaces the `Alert.alert` that used to fire on tapping a node. Two things it can do
 * that an alert could not: keep the plan visible behind it while you decide, and render
 * attributes as something other than the string `"no attributes"`.
 */

import { Text, View } from "react-native";

import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { Sheet } from "@/components/Sheet";
import type { ResourceAvailability } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { describe as describeViolation } from "@/lib/messages";
import { at, radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  resource: ResourceAvailability | null;
  localDate: string;
  zoneName: string | null;
  /**
   * Who has this desk, when presence is on and they are willing to be named (FR-5.1).
   * Null covers three different situations that must all look identical from here —
   * presence switched off, the desk free, or the person hidden — because a sheet that
   * distinguished "nobody" from "someone who opted out" would leak the opt-out.
   */
  occupant?: { id: string; name: string; initials: string } | null;
  booking: boolean;
  onBook: (resource: ResourceAvailability) => void;
  onClose: () => void;
};

/** `attributes` is free-form jsonb, so the renderer must not assume a shape. */
function chipsFor(resource: ResourceAvailability): string[] {
  const out: string[] = [];
  if (resource.kind === "room") out.push(`${resource.capacity} seats`);
  for (const [key, value] of Object.entries(resource.attributes)) {
    if (value === false || value === 0 || value === "none" || value == null) continue;
    if (Array.isArray(value)) continue;
    const name = key.replace(/_/g, " ");
    out.push(typeof value === "boolean" ? name : `${name} ${value}`);
  }
  return out;
}

export function DeskSheet({
  resource,
  localDate,
  zoneName,
  occupant,
  booking,
  onBook,
  onClose,
}: Props) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  // Nothing selected: render nothing rather than an invisible modal.
  if (!resource) return null;

  // A zone held for another team is not "taken" — nobody has it. Saying so would be a
  // small lie in place of the large one this release removed (FR-6.4).
  const state = resource.occupied_by_me
    ? "yours"
    : resource.restriction
      ? "restricted"
      : !resource.bookable
        ? "unavailable"
        : resource.available
          ? "free"
          : "taken";

  const label = {
    free: "Free",
    taken: "Taken",
    yours: "Yours",
    restricted: "Reserved",
    unavailable: resource.out_of_service_reason || "Out of service",
  }[state];

  const chips = chipsFor(resource);

  return (
    <Sheet visible onClose={onClose} title={`${resource.code}, ${label}`} showTitle={false}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <View style={styles.codeRow}>
            <Text style={styles.code}>{resource.code}</Text>
            <View style={[styles.pill, styles[`pill_${state}` as const]]}>
              <Text style={[styles.pillText, styles[`pillText_${state}` as const]]}>{label}</Text>
            </View>
          </View>
          <Text style={styles.meta}>
            {resource.name ? `${resource.name} · ` : ""}
            {zoneName ?? (resource.kind === "room" ? "Meeting room" : "Open plan")}
          </Text>
        </View>
      </View>

      <View style={styles.chips}>
        {chips.length ? (
          chips.map((c) => (
            <View key={c} style={styles.chip}>
              <Text style={styles.chipText}>{c}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.meta}>No listed features.</Text>
        )}
      </View>

      {/* A taken desk with a name on it. "Marcus Weber has this" is the answer to the
          question somebody taps a taken desk to ask; "someone else has this" is not. */}
      {state === "taken" && occupant ? (
        <View style={styles.occupant}>
          {/* The plan is right behind this sheet, where the same desk is a slate
              bubble; the same person in two colours on one screen reads as two
              people. The name is written out here, so nothing is lost. */}
          <Avatar
            id={occupant.id}
            name={occupant.name}
            initials={occupant.initials}
            size={32}
            tint={theme.color.state.person}
          />
          <Text style={styles.occupantName}>{occupant.name} is here all day</Text>
        </View>
      ) : null}

      {state === "free" ? (
        <Button
          label={`Book for ${shortDay(localDate)}`}
          busy={booking}
          onPress={() => onBook(resource)}
        />
      ) : (
        <Text style={styles.why}>
          {state === "yours"
            ? `This is your desk on ${formatDate(localDate)}.`
            : state === "restricted" && resource.restriction
              ? describeViolation({ ...resource.restriction, severity: "block" })
              : state === "taken"
                ? occupant
                  ? "Pick another desk, or a different day."
                  : "Someone else has this for the whole day."
                : resource.out_of_service_reason
                  ? `Out of service: ${resource.out_of_service_reason}`
                  : "This desk is out of service."}
        </Text>
      )}

      <Button label="Close" variant="quiet" onPress={onClose} />
    </Sheet>
  );
}

function shortDay(localDate: string) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long" });
}

const makeStyles = (t: Theme) => ({
  head: { flexDirection: "row" as const, gap: spacing(1.5), alignItems: "flex-start" as const },
  codeRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing(1) },
  code: { ...at(type.code, 21), color: t.color.ink },
  meta: { ...type.sub, color: t.color.muted, marginTop: spacing(0.5) },
  pill: { paddingHorizontal: spacing(1), paddingVertical: 2, borderRadius: radius.pill },
  pill_free: { backgroundColor: t.color.surfaceAlt },
  pill_taken: { backgroundColor: t.color.surfaceAlt },
  pill_yours: { backgroundColor: t.color.accentSoft },
  pill_restricted: { backgroundColor: t.color.surfaceAlt },
  pill_unavailable: { backgroundColor: t.color.surfaceAlt },
  pillText: { ...at(type.label, 10) },
  pillText_free: { color: t.color.state.free },
  pillText_taken: { color: t.color.muted },
  pillText_yours: { color: t.color.accentText },
  pillText_restricted: { color: t.color.state.zone },
  pillText_unavailable: { color: t.color.state.closed },
  chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: spacing(0.75) },
  chip: {
    backgroundColor: t.color.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing(1.25),
    paddingVertical: spacing(0.5),
  },
  chipText: { ...at(type.sub, 12), color: t.color.inkSoft },
  why: { ...type.body, color: t.color.muted },
  occupant: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing(1.25) },
  occupantName: { ...type.body, color: t.color.ink, fontWeight: "600" as const, flex: 1 },
});
