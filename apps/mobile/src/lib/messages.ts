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
