/**
 * Admin refusal codes -> sentences (TDD §9, §11).
 *
 * The console's counterpart to `apps/mobile/src/lib/messages.ts`, and it exists for the
 * same reason: the API sends a code and typed params, never prose, so this is the one
 * place that decides how a refusal reads. An admin refusal has to name what is in the
 * way — "a zone depends on this group" is only useful if it says which zone.
 */

import { ProblemError } from "@/lib/types";

type Params = Record<string, unknown>;

const list = (value: unknown): string => {
  const items = Array.isArray(value) ? value.map(String) : [];
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};

const MESSAGES: Record<string, (p: Params) => string> = {
  "admin.last_org_admin": (p) =>
    `${p.display_name ?? "This person"} is the only org admin left. Give someone else that role first — nothing in this product can put an administrator back.`,
  "admin.group_in_use": (p) =>
    `${list(p.zones)} ${Array.isArray(p.zones) && p.zones.length > 1 ? "depend" : "depends"} on “${p.group}” for access. Deleting the group would open ${Array.isArray(p.zones) && p.zones.length > 1 ? "them" : "it"} to everyone, so clear the zone permission in the floor plan editor first.`,
  "admin.email_taken": (p) =>
    `${p.email} already belongs to ${p.display_name ?? "someone here"}.`,
  "admin.unknown_role": (p) => `“${p.role}” isn't a role this product has.`,
};

/** One sentence per blocking violation. Never the server's `detail`, which is for us. */
export function describeAdmin(problem: ProblemError): string {
  const blocking = problem.violations.filter((v) => v.severity !== "warn");
  const lines = blocking.map((v) => MESSAGES[v.code]?.(v.params) ?? null).filter(Boolean);
  if (lines.length) return lines.join("\n");
  // An unmapped code still has to say something an admin can act on, and the status is
  // the most honest thing we know about it.
  return problem.status === 403
    ? "You don't have permission to do that."
    : "That didn't work. Try again, or check the server logs.";
}
