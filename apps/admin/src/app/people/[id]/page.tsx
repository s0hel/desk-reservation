import Link from "next/link";
import { redirect } from "next/navigation";

import { PersonPanel } from "@/components/people/PersonPanel";
import { apiJson } from "@/lib/api";
import { getAccessToken, getIdentity, isAdmin } from "@/lib/session";
import type { AdminGroup, DirectoryUser, SiteSummary } from "@/lib/types";

export default async function Person({ params }: { params: Promise<{ id: string }> }) {
  const token = await getAccessToken();
  const identity = await getIdentity();
  if (!token || !isAdmin(identity)) redirect("/sign-in");

  const { id } = await params;
  const [user, groups, sites] = await Promise.all([
    apiJson<DirectoryUser>(`/v1/admin/users/${id}`, { token }),
    apiJson<AdminGroup[]>("/v1/admin/groups", { token }),
    apiJson<SiteSummary[]>("/v1/sites", { token }),
  ]);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <p className="small" style={{ marginTop: 0 }}>
        <Link href="/people">← People</Link>
      </p>
      <PersonPanel
        user={user}
        groups={groups}
        sites={sites}
        canAssignRoles={!!identity?.roles.includes("org_admin")}
        isSelf={user.email === identity?.email}
      />
    </div>
  );
}
