/**
 * Desk and room detail.
 *
 * Replaces the `Alert.alert` that used to fire on tapping a node. Two things it can do
 * that an alert could not: keep the plan visible behind it while you decide, and render
 * attributes as something other than the string `"no attributes"`.
 */

import { Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Sheet } from "@/components/Sheet";
import type { ResourceAvailability } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { at, radius, spacing, type, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  resource: ResourceAvailability | null;
  localDate: string;
  zoneName: string | null;
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
  booking,
  onBook,
  onClose,
}: Props) {
  const styles = useThemedStyles(makeStyles);
  // Nothing selected: render nothing rather than an invisible modal.
  if (!resource) return null;

  const state = resource.occupied_by_me
    ? "yours"
    : !resource.bookable
      ? "unavailable"
      : resource.available
        ? "free"
        : "taken";

  const label = {
    free: "Free",
    taken: "Taken",
    yours: "Yours",
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
            : state === "taken"
              ? "Someone else has this for the whole day."
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
  pill_unavailable: { backgroundColor: t.color.surfaceAlt },
  pillText: { ...at(type.label, 10) },
  pillText_free: { color: t.color.state.free },
  pillText_taken: { color: t.color.muted },
  pillText_yours: { color: t.color.accentText },
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
});
