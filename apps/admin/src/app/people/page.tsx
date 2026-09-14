import { redirect } from "next/navigation";

import { Directory } from "@/components/people/Directory";
import { apiJson } from "@/lib/api";
import { getAccessToken, getIdentity, isAdmin } from "@/lib/session";
import type { AdminGroup, UserPage } from "@/lib/types";

/**
 * The directory (FR-8.4).
 *
 * This page exists because the product shipped a control nothing could configure: zone
 * permissions grant desks to groups, and until now the only way to create a group or
 * put someone in one was to write SQL against the database.
 *
 * Server component, like the rest of the console: the table is the data, and rendering
 * it here means the first paint is the answer rather than a spinner.
 */
export default async function People({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; inactive?: string }>;
}) {
  const token = await getAccessToken();
  const identity = await getIdentity();
  if (!token || !isAdmin(identity)) redirect("/sign-in");

  const { q, group, inactive } = await searchParams;
  const params = new URLSearchParams({ limit: "100" });
  if (q) params.set("q", q);
  if (group) params.set("group", group);
  if (inactive === "1") params.set("include_inactive", "true");

  const [page, groups] = await Promise.all([
    apiJson<UserPage>(`/v1/admin/users?${params}`, { token }),
    apiJson<AdminGroup[]>("/v1/admin/groups", { token }),
  ]);

  return (
    <Directory
      page={page}
      groups={groups}
      query={q ?? ""}
      groupId={group ?? ""}
      includeInactive={inactive === "1"}
      canAssignRoles={!!identity?.roles.includes("org_admin")}
    />
  );
}
