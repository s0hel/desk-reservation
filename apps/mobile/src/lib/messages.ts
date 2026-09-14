/**
 * Reason codes -> human text (TDD §9, §11).
 *
 * The server never sends user-facing prose; it sends a code plus params. This is the
 * only place that turns one into a sentence, which is what makes the four launch
 * languages (FR-10.4) a matter of swapping this map rather than changing the API.
 */

import type { Violation } from "./api";
import { formatDate } from "./dates";

type Params = Record<string, unknown>;

/** Params carry ISO dates; users should never see one. */
const day = (v: unknown) => (typeof v === "string" ? formatDate(v) : String(v));

const MESSAGES: Record<string, (p: Params) => string> = {
  "policy.horizon_exceeded": (p) =>
    `You can only book up to ${p.max_days} days ahead.`,
  "policy.max_concurrent_reached": (p) =>
    `You already hold ${p.held} upcoming bookings, the maximum is ${p.max}.`,
  "policy.site_capacity_reached": (p) =>
    `The office is full on ${day(p.date)} (${p.capacity} places).`,
  "policy.already_booked_today": (p) =>
    `You already have a desk on ${day(p.date)}.`,
  "policy.outside_opening_hours": (p) =>
    p.closed ? `The office is closed on ${day(p.date)}.` : `That time is outside opening hours.`,
  "policy.delegation_not_permitted": () =>
    "You cannot book on behalf of someone else.",
  "policy.zone_not_permitted": () =>
    "That area is reserved for another team.",
  "policy.zone_not_yet_open": (p) =>
    `That area opens to everyone at ${p.opens_at}.`,
  "policy.blackout": (p) =>
    p.reason ? `The office is closed on ${day(p.date)} — ${p.reason}.` : `The office is closed on ${day(p.date)}.`,
  "presence.absence_conflicts_with_booking": (p) =>
    `You still have ${p.resource_code ?? "a desk"} booked on ${day(p.date)}.`,
  "presence.absence_kind_unknown": () => "That isn't a kind of day away we know about.",
  "presence.visibility_unknown": () => "That isn't a visibility setting we know about.",
  "resource.unavailable": (p) =>
    `${p.resource_code ?? "That desk"} was taken while you were booking.`,
  "resource.out_of_service": (p) =>
    p.reason ? `${p.code_ref} is out of service: ${p.reason}` : `${p.code_ref} is out of service.`,
};

export function describe(violation: Violation): string {
  const fn = MESSAGES[violation.code];
  // An unmapped code must still say something useful rather than rendering a raw slug.
  return fn ? fn(violation.params) : "That booking isn't allowed right now.";
}

export function describeAll(violations: Violation[], fallback: string): string {
  const blocking = violations.filter((v) => v.severity !== "warn");
  if (blocking.length === 0) return fallback;
  return blocking.map(describe).join("\n");
}

/**
 * A refusal, broken into the parts a sheet can lay out (TDD §11).
 *
 * `describe` returns one sentence, which is all an alert box could show. That was the
 * ceiling, not the design: the server sends a stable code and typed params precisely so
 * the client can say what the rule is, what would satisfy it, and — when a different
 * day would work — offer one. None of that survives being flattened into a string.
 */
export type Refusal = {
  /** The headline, in the user's words rather than the rule's name. */
  headline: string;
  /** The rule stated plainly, with the number that makes it credible. */
  detail: string;
  /** What would satisfy it, when the rule implies something the user can do. */
  fix: string | null;
  /** Kept on screen, small: support can act on a screenshot. */
  code: string | null;
  /** Whether another day would plausibly work, so the sheet offers nearby ones. */
  otherDaysHelp: boolean;
};

type Shape = {
  headline: (p: Params) => string;
  /** Supporting fact. Must add something the headline does not already say. */
  detail?: (p: Params) => string;
  fix?: (p: Params) => string;
  otherDays?: boolean;
};

const SHAPES: Record<string, Shape> = {
  "policy.horizon_exceeded": {
    headline: () => "That's too far ahead",
    fix: (p) => `Pick a date within the next ${p.max_days} days.`,
  },
  "policy.max_concurrent_reached": {
    headline: () => "You're at your booking limit",
    detail: (p) => `You're holding ${p.held} of a maximum ${p.max}.`,
    fix: () => "Cancel one of your upcoming bookings to make room.",
  },
  "policy.site_capacity_reached": {
    headline: (p) => `${day(p.date)} is full`,
    detail: (p) => `All ${p.capacity} places for the day are taken.`,
    otherDays: true,
  },
  "policy.already_booked_today": {
    headline: (p) => `You already have a desk on ${day(p.date)}`,
    fix: () => "Cancel that one first if you want to move.",
  },
  "policy.outside_opening_hours": {
    headline: (p) =>
      p.closed ? `The office is closed on ${day(p.date)}` : "That's outside opening hours",
    otherDays: true,
  },
  "policy.zone_not_permitted": {
    headline: () => "That area is reserved",
    detail: () => "It's limited to certain teams.",
    fix: () => "Pick a desk outside it, or ask an admin for access.",
  },
  "policy.blackout": {
    headline: (p) => `${day(p.date)} is closed`,
    // The admin's own words, quoted. The sentence around them still comes from us.
    detail: (p) => (p.reason ? String(p.reason) : ""),
    otherDays: true,
  },
  "policy.zone_not_yet_open": {
    headline: () => "That area isn't open yet",
    detail: (p) => `It's held for another team until ${p.opens_at}.`,
    fix: () => "Pick a desk elsewhere, or come back later.",
  },
  "presence.absence_conflicts_with_booking": {
    headline: (p) => `You still have a desk on ${day(p.date)}`,
    // The server refuses rather than cancelling for you: marking a day away and
    // silently losing a desk is a side effect nobody asked for (FR-5.5).
    detail: (p) => (p.resource_code ? `${p.resource_code} is still booked.` : ""),
    fix: () => "Cancel that booking first, then mark the day away.",
  },
  "resource.unavailable": {
    headline: () => "Just taken",
    detail: (p) =>
      p.resource_code
        ? `${p.resource_code} went a moment before you did.`
        : "Someone booked it a moment before you did.",
    fix: () => "Pick another desk.",
  },
  "resource.out_of_service": {
    headline: () => "That desk is out of service",
    detail: (p) => (p.reason ? String(p.reason) : ""),
    fix: () => "Pick another desk.",
  },
  "policy.delegation_not_permitted": {
    headline: () => "You can't book for someone else",
  },
};

export function refusal(violations: Violation[], fallback: string): Refusal {
  const blocking = violations.filter((v) => v.severity !== "warn");
  const first = blocking[0];
  if (!first) {
    return {
      headline: "Something went wrong",
      detail: fallback,
      fix: null,
      code: null,
      otherDaysHelp: false,
    };
  }
  const shape = SHAPES[first.code];

  // The headline already speaks for the first violation, so repeating `describe` for it
  // printed the same sentence twice. An unmapped code has no headline of its own, so it
  // still falls back to the sentence. Any further violations are always stated: a user
  // who clears one rule only to meet the next has learned nothing.
  const parts = [
    shape ? (shape.detail ? shape.detail(first.params) : "") : describe(first),
    ...blocking.slice(1).map(describe),
  ].filter((line) => line.length > 0);

  return {
    headline: shape ? shape.headline(first.params) : "That booking isn't allowed",
    detail: parts.join(" "),
    fix: shape?.fix ? shape.fix(first.params) : null,
    code: first.code,
    otherDaysHelp: shape?.otherDays ?? false,
  };
}
