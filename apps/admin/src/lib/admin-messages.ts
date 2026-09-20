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

  // Site photo upload (FR-2.1). Each one names the file's problem, because the admin
  // is standing in front of a file picker and the next action is picking a different
  // file — "upload failed" would send them to try the same one again.
  "photo.too_large": (p) =>
    `That image is ${megabytes(p.bytes)}. The limit is ${megabytes(p.max_bytes)} — it is a header image, downloaded on every app open.`,
  "photo.unsupported_type": (p) =>
    `${p.content_type ? `“${p.content_type}”` : "That file"} isn't an image this accepts. Use a JPEG, PNG or WebP — a PDF is a floor plan, not a photo of the building.`,
  "photo.image_unreadable": () =>
    "That file couldn't be read as an image, whatever its extension says. Try exporting it again.",
  "photo.empty": () => "That file is empty.",
};

const megabytes = (value: unknown): string =>
  typeof value === "number" ? `${(value / (1024 * 1024)).toFixed(1)}MB` : "an unknown size";

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
