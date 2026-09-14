"use client";

/**
 * Search, list, and add people.
 *
 * The filters are URL state rather than component state: an admin who has filtered to
 * one team and found the person they want should be able to send that link to a
 * colleague, and coming back from a person's page should land on the same list rather
 * than resetting to everyone.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { post } from "@/lib/client";
import { ProblemError, ROLE_LABELS, type AdminGroup, type RoleName, type UserPage } from "@/lib/types";
import { describeAdmin } from "@/lib/admin-messages";

export function Directory({
  page,
  groups,
  query,
  groupId,
  includeInactive,
  canAssignRoles,
}: {
  page: UserPage;
  groups: AdminGroup[];
  query: string;
  groupId: string;
  includeInactive: boolean;
  canAssignRoles: boolean;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`/people?${next}`));
  };

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>People</h1>
        <span className="pill">{page.total}</span>
        <div className="spacer" />
        <Link href="/groups">Groups →</Link>
        <button className="primary" onClick={() => setAdding(true)}>
          Add a person
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <input
            type="text"
            defaultValue={query}
            placeholder="Search by name or email"
            aria-label="Search people"
            onChange={(event) => setParam("q", event.target.value)}
            style={{ maxWidth: 320 }}
          />
          <select
            value={groupId}
            aria-label="Filter by group"
            onChange={(event) => setParam("group", event.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">Any group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <div className="spacer" />
          <label
            className="row"
            style={{ margin: 0, textTransform: "none", letterSpacing: 0, fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setParam("inactive", event.target.checked ? "1" : "")}
              style={{ width: "auto" }}
            />
            Show deactivated
          </label>
        </div>
      </div>

      <div className="card">
        {page.users.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nobody matches that.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
                <th style={{ padding: "6px 0" }}>Name</th>
                <th>Email</th>
                <th>Roles</th>
                <th>Groups</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.users.map((user) => (
                <tr key={user.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 0" }}>
                    <Link href={`/people/${user.id}`}>{user.display_name}</Link>
                    {/* Deactivated people are findable on request, so the row has to
                        say which one it is rather than looking like everyone else. */}
                    {!user.is_active ? (
                      <span className="pill" style={{ marginLeft: 8 }}>
                        deactivated
                      </span>
                    ) : null}
                  </td>
                  <td className="muted small">{user.email}</td>
                  <td className="small">
                    {user.roles.length
                      ? user.roles
                          .map((role) => ROLE_LABELS[role.role as RoleName] ?? role.role)
                          .join(", ")
                      : "—"}
                  </td>
                  <td className="small muted">
                    {user.groups.length ? user.groups.map((g) => g.name).join(", ") : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link href={`/people/${user.id}`}>Manage →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page.total > page.users.length ? (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Showing {page.users.length} of {page.total}. Narrow the search to see the rest.
          </p>
        ) : null}
      </div>

      {adding ? (
        <AddPerson
          canAssignRoles={canAssignRoles}
          onClose={() => setAdding(false)}
          onCreated={(id) => router.push(`/people/${id}`)}
        />
      ) : null}
    </div>
  );
}

function AddPerson({
  canAssignRoles,
  onClose,
  onCreated,
}: {
  canAssignRoles: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await post<{ id: string }>("/v1/admin/users", {
        email: email.trim(),
        display_name: name.trim(),
      });
      onCreated(created.id);
    } catch (problem) {
      setError(
        problem instanceof ProblemError
          ? describeAdmin(problem)
          : "Could not reach the server.",
      );
      setSaving(false);
    }
  };

  return (
    <dialog open onCancel={onClose}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Add a person</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        They join as an employee. Roles and groups come next, on their own page.
        {canAssignRoles ? "" : " Only an org admin can grant roles."}
      </p>
      <div className="stack">
        <div>
          <label htmlFor="new-email">Work email</label>
          <input
            id="new-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
        </div>
        <div>
          <label htmlFor="new-name">Display name</label>
          <input
            id="new-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Priya Raman"
          />
        </div>
        {error ? <p className="error small">{error}</p> : null}
        <div className="row">
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={saving || !email.trim() || !name.trim()}
            onClick={submit}
          >
            {saving ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
