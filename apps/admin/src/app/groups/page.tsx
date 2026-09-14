import Link from "next/link";
import { redirect } from "next/navigation";

import { GroupsPanel } from "@/components/people/GroupsPanel";
import { apiJson } from "@/lib/api";
import { getAccessToken, getIdentity, isAdmin } from "@/lib/session";
import type { AdminGroup } from "@/lib/types";

/**
 * Groups (FR-8.4).
 *
 * Membership is edited from a person's page, not here: the question an admin actually
 * has is "which teams is Priya in", and answering it from the other direction would
 * need a user picker on every group. This page owns what a group *is* — its name, how
 * many people are in it, and what depends on it.
 */
export default async function Groups() {
  const token = await getAccessToken();
  const identity = await getIdentity();
  if (!token || !isAdmin(identity)) redirect("/sign-in");

  const groups = await apiJson<AdminGroup[]>("/v1/admin/groups", { token });

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <p className="small" style={{ marginTop: 0 }}>
        <Link href="/people">← People</Link>
      </p>
      <GroupsPanel groups={groups} />
    </div>
  );
}
