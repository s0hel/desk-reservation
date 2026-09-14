/**
 * Presence, client side (FR-5.1–5.6, TDD §11).
 *
 * Pure and I/O-free on purpose, for the same reason `lib/plan.ts` is: every UI bug in
 * this app so far has been invisible to typecheck and Jest, so the parts that *can* be
 * tested directly are worth extracting. Nothing here decides who may be seen — that is
 * a query condition on the server, and a client-side filter would be the exact mistake
 * the server-side invariant exists to prevent. By the time a person reaches this
 * module, the server has already decided they are visible.
 */

export type PresenceStatus = "in" | "remote" | "leave" | "travel" | "unknown";

export const ABSENCE_KINDS = ["remote", "leave", "travel"] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

/**
 * How a status reads in a list, where the person's name is already beside it.
 *
 * "unknown" is deliberately "No plans yet" rather than "Away" or a blank: a colleague
 * who has told us nothing has not told us they are out, and a grid that renders silence
 * as absence invents information (FR-5.4).
 */
export function statusLabel(status: PresenceStatus): string {
  switch (status) {
    case "in":
      return "In the office";
    case "remote":
      return "Working remotely";
    case "leave":
      return "On leave";
    case "travel":
      return "Travelling";
    case "unknown":
      return "No plans yet";
  }
}

/** The same fact at chip width. */
export function statusShort(status: PresenceStatus): string {
  switch (status) {
    case "in":
      return "In";
    case "remote":
      return "Remote";
    case "leave":
      return "Leave";
    case "travel":
      return "Travel";
    case "unknown":
      return "—";
  }
}

export function absenceLabel(kind: AbsenceKind): string {
  return { remote: "Working remotely", leave: "On leave", travel: "Travelling" }[kind];
}

/**
 * Which of N tints a person gets, stable for the life of their id.
 *
 * An avatar that changes colour between screens stops being recognisable, which is the
 * only job a two-letter monogram has. Hashing the id rather than the name also keeps it
 * stable across a rename.
 */
export function tintIndex(id: string, count: number): number {
  if (count <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % count;
}

export function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]!.toUpperCase()).join("") || "?";
}

export type Positioned = { position?: { x?: number; y?: number } | null };

/**
 * The nearest candidate to a point in normalized plan space (TDD §14.2), or null.
 *
 * This is the whole of "sit near Marcus" (FR-5.3) on the client: presence already
 * carries each colleague's seat position, so finding the closest free desk to it is a
 * sort over data the screen has, not another round trip. Items with no position are
 * skipped rather than treated as (0,0) — the top-left corner of the plan is a real
 * place, and a desk with no coordinates would otherwise win whenever nothing is near.
 */
export function nearestTo<T extends Positioned>(
  point: { x: number; y: number },
  candidates: T[],
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const item of candidates) {
    const x = item.position?.x;
    const y = item.position?.y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    const d = Math.hypot(x - point.x, y - point.y);
    if (d < bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best;
}
