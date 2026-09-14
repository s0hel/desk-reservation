"use client";

/**
 * One person: their profile, their roles, their groups, and the way out of the
 * directory (FR-8.4, FR-1.8).
 *
 * Deactivation is the only destructive control in here and it behaves like the other
 * two in this console — the floor-plan publish and the blackout. It asks the server
 * what the action would cost, shows that, and only then offers the button. An admin
 * should learn that four people lose their desks *before* they cause it.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { del, get, patch, post, put } from "@/lib/client";
import { describeAdmin } from "@/lib/admin-messages";
import {
  ProblemError,
  ROLE_LABELS,
  type AdminGroup,
  type Deactivation,
  type DirectoryUser,
  type RoleAssignment,
  type RoleName,
  type SiteSummary,
} from "@/lib/types";

const ROLES: RoleName[] = ["employee", "team_lead", "site_admin", "org_admin"];

export function PersonPanel({
  user: initial,
  groups,
  sites,
  canAssignRoles,
  isSelf,
}: {
  user: DirectoryUser;
  groups: AdminGroup[];
  sites: SiteSummary[];
  canAssignRoles: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [user, setUser] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<DirectoryUser | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) setUser(next);
      // The list page and this one read the same rows; refreshing keeps a back
      // navigation from showing the state we just changed.
      router.refresh();
    } catch (problem) {
      setError(
        problem instanceof ProblemError ? describeAdmin(problem) : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  };

  const siteName = (id: string | null) =>
    sites.find((site) => site.id === id)?.name ?? "Unknown site";

  return (
    <div className="stack">
      <section className="card">
        <div className="row">
          <h1 style={{ margin: 0, fontSize: 20 }}>{user.display_name}</h1>
          {user.is_active ? null : <span className="pill">deactivated</span>}
          <div className="spacer" />
          <span className="muted small">{user.email}</span>
        </div>
        <Profile user={user} sites={sites} busy={busy} onSave={run} />
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Roles</h2>
        {canAssignRoles ? (
          <Roles user={user} sites={sites} busy={busy} onSave={run} siteName={siteName} />
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {/* A site admin who could grant roles could grant themselves org_admin,
                  which is not delegation — it is the absence of a boundary. */}
              Only an org admin can change roles.
            </p>
            <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
              {user.roles.map((role) => (
                <li key={`${role.role}:${role.scope_id ?? "org"}`}>
                  {ROLE_LABELS[role.role]} ·{" "}
                  {role.scope_type === "org" ? "whole organization" : siteName(role.scope_id)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Groups</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Groups are what zone permissions grant desks to, and what the team view on the
          phone is built from.
        </p>
        <Groups user={user} groups={groups} busy={busy} onRun={run} />
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          {user.is_active ? "Deactivate" : "Reactivate"}
        </h2>
        <Deactivate user={user} isSelf={isSelf} busy={busy} onRun={run} />
      </section>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Profile({
  user,
  sites,
  busy,
  onSave,
}: {
  user: DirectoryUser;
  sites: SiteSummary[];
  busy: boolean;
  onSave: (work: () => Promise<DirectoryUser>) => void;
}) {
  const [name, setName] = useState(user.display_name);
  const [home, setHome] = useState(user.home_site_id ?? "");
  const dirty = name !== user.display_name || home !== (user.home_site_id ?? "");

  return (
    <div className="row" style={{ alignItems: "flex-end", marginTop: 12 }}>
      <div style={{ flex: 1 }}>
        <label htmlFor="name">Display name</label>
        <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div style={{ flex: 1 }}>
        <label htmlFor="home">Home site</label>
        <select id="home" value={home} onChange={(e) => setHome(e.target.value)}>
          <option value="">None</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </div>
      <button
        disabled={busy || !dirty || !name.trim()}
        onClick={() =>
          onSave(() =>
            patch<DirectoryUser>(`/v1/admin/users/${user.id}`, {
              display_name: name.trim(),
              home_site_id: home || null,
            }),
          )
        }
      >
        Save
      </button>
    </div>
  );
}

function Roles({
  user,
  sites,
  busy,
  onSave,
  siteName,
}: {
  user: DirectoryUser;
  sites: SiteSummary[];
  busy: boolean;
  onSave: (work: () => Promise<DirectoryUser>) => void;
  siteName: (id: string | null) => string;
}) {
  const [roles, setRoles] = useState<RoleAssignment[]>(user.roles);
  const [role, setRole] = useState<RoleName>("team_lead");
  const [scope, setScope] = useState("org");

  useEffect(() => setRoles(user.roles), [user.roles]);

  const key = (r: RoleAssignment) => `${r.role}:${r.scope_id ?? "org"}`;
  const add = () => {
    const next: RoleAssignment = {
      role,
      scope_type: scope === "org" ? "org" : "site",
      scope_id: scope === "org" ? null : scope,
    };
    if (roles.some((r) => key(r) === key(next))) return;
    setRoles([...roles, next]);
  };

  const dirty =
    roles.length !== user.roles.length ||
    roles.some((r, i) => key(r) !== key(user.roles[i] ?? ({} as RoleAssignment)));

  return (
    <div className="stack">
      {roles.length === 0 ? (
        <p className="warn small" style={{ margin: 0 }}>
          No roles. They will be able to sign in and nothing else.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {roles.map((assignment) => (
              <tr key={key(assignment)} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 0" }}>{ROLE_LABELS[assignment.role]}</td>
                <td className="muted small">
                  {assignment.scope_type === "org"
                    ? "whole organization"
                    : siteName(assignment.scope_id)}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="danger"
                    onClick={() => setRoles(roles.filter((r) => key(r) !== key(assignment)))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row">
        <select
          value={role}
          aria-label="Role to add"
          onChange={(e) => setRole(e.target.value as RoleName)}
          style={{ maxWidth: 180 }}
        >
          {ROLES.map((name) => (
            <option key={name} value={name}>
              {ROLE_LABELS[name]}
            </option>
          ))}
        </select>
        <select
          value={scope}
          aria-label="Scope"
          onChange={(e) => setScope(e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="org">Whole organization</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name} only
            </option>
          ))}
        </select>
        <button onClick={add}>Add</button>
        <div className="spacer" />
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => onSave(() => put<DirectoryUser>(`/v1/admin/users/${user.id}/roles`, { roles }))}
        >
          Save roles
        </button>
      </div>
      {dirty ? (
        <p className="muted small" style={{ margin: 0 }}>
          Saving signs them out — their current session still carries the old roles.
        </p>
      ) : null}
    </div>
  );
}

function Groups({
  user,
  groups,
  busy,
  onRun,
}: {
  user: DirectoryUser;
  groups: AdminGroup[];
  busy: boolean;
  onRun: (work: () => Promise<DirectoryUser>) => void;
}) {
  const [picked, setPicked] = useState("");
  const available = groups.filter((g) => !user.groups.some((m) => m.id === g.id));

  const refetch = () => get<DirectoryUser>(`/v1/admin/users/${user.id}`);

  return (
    <div className="stack">
      {user.groups.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          Not in any group.
        </p>
      ) : (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {user.groups.map((group) => (
            <span key={group.id} className="pill" style={{ display: "inline-flex", gap: 6 }}>
              {group.name}
              <button
                aria-label={`Remove from ${group.name}`}
                style={{ border: 0, background: "none", padding: 0, lineHeight: 1 }}
                disabled={busy}
                onClick={() =>
                  onRun(async () => {
                    await del(`/v1/admin/groups/${group.id}/members/${user.id}`);
                    return refetch();
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="row">
        <select
          value={picked}
          aria-label="Group to join"
          onChange={(e) => setPicked(e.target.value)}
          style={{ maxWidth: 260 }}
        >
          <option value="">Add to a group…</option>
          {available.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !picked}
          onClick={() =>
            onRun(async () => {
              await post(`/v1/admin/groups/${picked}/members`, { user_id: user.id });
              setPicked("");
              return refetch();
            })
          }
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Deactivate({
  user,
  isSelf,
  busy,
  onRun,
}: {
  user: DirectoryUser;
  isSelf: boolean;
  busy: boolean;
  onRun: (work: () => Promise<DirectoryUser>) => void;
}) {
  const [impact, setImpact] = useState<Deactivation | null>(null);
  const [asked, setAsked] = useState(false);

  if (!user.is_active) {
    return (
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          They can sign in again once reactivated. The bookings cancelled when they left
          are not restored — those desks have very likely gone to someone else.
        </p>
        <div className="row">
          <div className="spacer" />
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              onRun(() => del<DirectoryUser>(`/v1/admin/users/${user.id}/deactivation`))
            }
          >
            Reactivate
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Ends their sessions immediately and returns every desk they hold to the pool.
        Each cancellation notifies them, the same as any other.
      </p>

      {asked && impact ? (
        <div
          style={{
            border: `1px solid ${impact.is_last_admin ? "var(--danger)" : "var(--border)"}`,
            borderRadius: 10,
            padding: 12,
          }}
        >
          {impact.is_last_admin ? (
            <p className="error small" style={{ margin: 0 }}>
              This is the only org admin. Give someone else that role first — nothing in
              this product can put an administrator back.
            </p>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              {impact.bookings === 0
                ? "No upcoming bookings to release."
                : `${impact.bookings} upcoming booking${impact.bookings === 1 ? "" : "s"} will be cancelled${
                    impact.sample.length ? ` — ${impact.sample.join(", ")}` : ""
                  }.`}
              {impact.groups ? ` They stay listed in ${impact.groups} group${impact.groups === 1 ? "" : "s"}.` : ""}
            </p>
          )}
        </div>
      ) : null}

      <div className="row">
        {isSelf ? (
          <span className="warn small">This is you.</span>
        ) : null}
        <div className="spacer" />
        {!asked ? (
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              setImpact(await get<Deactivation>(`/v1/admin/users/${user.id}/deactivation`));
              setAsked(true);
            }}
          >
            Deactivate…
          </button>
        ) : (
          <>
            <button onClick={() => setAsked(false)}>Cancel</button>
            <button
              className="danger"
              disabled={busy || !!impact?.is_last_admin}
              onClick={() =>
                onRun(() => post<DirectoryUser>(`/v1/admin/users/${user.id}/deactivation`))
              }
            >
              {impact?.bookings
                ? `Deactivate and release ${impact.bookings}`
                : "Deactivate"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
