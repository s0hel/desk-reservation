import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteIdentity } from "@/components/SiteIdentity";
import { apiJson } from "@/lib/api";
import { getAccessToken, getIdentity, isAdmin } from "@/lib/session";
import type { FloorSummary, SiteSummary } from "@/lib/types";

/** Server component: the data-heavy tables render on the server (TDD §14.1). */
export default async function Home() {
  const token = await getAccessToken();
  const identity = await getIdentity();
  if (!token || !isAdmin(identity)) redirect("/sign-in");

  const sites = await apiJson<SiteSummary[]>("/v1/sites", { token });
  const floorsBySite = await Promise.all(
    sites.map((site) =>
      apiJson<FloorSummary[]>(`/v1/admin/sites/${site.id}/floors`, { token }).then(
        (floors) => [site, floors] as const,
      ),
    ),
  );

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1>Sites</h1>

      {sites.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No sites yet. Run <code>make seed</code>, or create one through{" "}
            <code>POST /v1/admin/sites</code>.
          </p>
        </div>
      ) : null}

      <div className="stack">
        {floorsBySite.map(([site, floors]) => (
          <section key={site.id} className="card">
            <div className="row">
              <h2 style={{ margin: 0, fontSize: 18 }}>{site.name}</h2>
              <span className="pill">{site.timezone}</span>
              <div className="spacer" />
              <span className="muted small">{site.address}</span>
            </div>

            {/* What the mobile home screen opens on (FR-2.1). Above the floor table
                because it is the first thing an employee sees of this site. */}
            <SiteIdentity site={site} />

            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
                  <th style={{ padding: "6px 0" }}>Floor</th>
                  <th>Resources</th>
                  <th>Plan</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {floors.map((floor) => (
                  <tr key={floor.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 0" }}>{floor.name}</td>
                    <td>{floor.resource_count}</td>
                    <td className="muted small">
                      {floor.plan_width_px
                        ? `${floor.plan_width_px}×${floor.plan_height_px}`
                        : "none"}
                    </td>
                    <td>
                      {floor.has_draft ? (
                        <span className="pill draft">unpublished changes</span>
                      ) : floor.published_at ? (
                        <span className="pill published">published</span>
                      ) : (
                        <span className="pill">never published</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link href={`/floors/${floor.id}`}>Edit floor plan →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
