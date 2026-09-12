/**
 * Dates are handled as site-local calendar dates (YYYY-MM-DD), never as instants
 * (TDD §5). The API defines a booking's day by the site's timezone, so the client
 * must not convert through the device's.
 */

export type DayOption = { date: string; weekday: string; day: string; isToday: boolean };

export function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** The next `count` days starting today, for the date strip (FR-2.1). */
export function upcomingDays(count = 7, from = new Date()): DayOption[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return {
      date: toLocalDate(d),
      weekday: d.toLocaleDateString(undefined, { weekday: "short" }),
      day: String(d.getDate()),
      isToday: i === 0,
    };
  });
}

/** Render a site-local time-of-day from an ISO instant, in the SITE's zone. */
export function timeInZone(iso: string, timeZone: string | null): string {
  try {
    const at = new Date(iso);
    // An invalid Date does not throw here — toLocaleTimeString returns the literal
    // string "Invalid Date", which would render to the user as-is.
    if (Number.isNaN(at.getTime())) return "";
    return at.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return "";
  }
}

export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
