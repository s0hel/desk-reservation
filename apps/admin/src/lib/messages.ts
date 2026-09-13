/**
 * Reason codes -> human text for the console (TDD §11).
 *
 * The same contract as the mobile app's `src/lib/messages.ts`: the server sends a code
 * plus params and never user-facing prose, and this is the only place that turns one
 * into a sentence.
 *
 * The codes differ because the audience does. An employee is told a desk is
 * unavailable; an admin is told which of their 300 desks has a duplicate code and what
 * it clashes with — a refusal an admin cannot act on is a support ticket.
 */

import type { Violation } from "@/lib/types";

type Params = Record<string, unknown>;

const list = (value: unknown): string =>
  Array.isArray(value) ? value.slice(0, 5).join(", ") + (value.length > 5 ? "…" : "") : String(value);

const MESSAGES: Record<string, (p: Params) => string> = {
  // Layout validation
  "layout.duplicate_code": (p) => `Two resources are both called ${p.code}.`,
  "layout.duplicate_resource_key": () => "The layout contains the same item twice.",
  "layout.duplicate_zone_key": () => "The layout contains the same zone twice.",
  "layout.unknown_zone": (p) => `${p.code} is assigned to a zone that no longer exists.`,
  "layout.unknown_kind": (p) => `"${p.kind}" is not a resource type this app understands.`,
  "layout.invalid_attributes": (p) =>
    `${p.where} has attributes that are not valid for a ${p.kind}: ${list(p.fields)}.`,
  "layout.code_taken_on_site": (p) =>
    `${p.code} is already used on another floor of this site. Codes are unique per site.`,

  // Publishing
  "publish.orphaned_bookings": (p) =>
    `${p.bookings} existing booking${p.bookings === 1 ? "" : "s"} would be cancelled (${list(
      p.resources,
    )}).`,

  // Plan upload
  "plan.unsupported_type": (p) => `${p.content_type} is not a floor plan. Use a PNG, JPEG or PDF.`,
  "plan.image_unreadable": () => "That image could not be read. It may be corrupt.",
  "plan.pdf_unreadable": () => "That PDF could not be opened.",
  "plan.pdf_empty": () => "That PDF has no pages.",
  "plan.empty": () => "That file is empty.",
  "plan.too_large": (p) =>
    `That file is ${Math.round(Number(p.bytes) / 1_000_000)}MB; the limit is ${Math.round(
      Number(p.max_bytes) / 1_000_000,
    )}MB.`,

  // Session
  "auth.not_admin": (p) =>
    `That account is not a site or organization admin (roles: ${list(p.roles) || "none"}).`,
  "auth.email_required": () => "Enter your work email address.",
  "auth.api_unreachable": () => "Could not reach the API. Is it running?",
};

export function describe(violation: Violation): string {
  const render = MESSAGES[violation.code];
  // An unmapped code must still say something rather than rendering a raw slug at an
  // admin who then has to grep the source for it.
  return render ? render(violation.params ?? {}) : `Refused: ${violation.code}`;
}

/**
 * Render a whole refusal. `fallback` is the problem's `detail` — developer-facing
 * English, used only when the server sent no codes at all, which is the one case where
 * showing it beats showing nothing.
 */
export function describeAll(violations: Violation[], fallback = ""): string {
  if (!violations.length) return fallback || "Something went wrong.";
  return violations.map(describe).join("\n");
}
