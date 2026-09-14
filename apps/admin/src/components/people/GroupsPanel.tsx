"use client";

/**
 * Create, rename and delete groups.
 *
 * The delete button is the interesting control. `zone_permissions.group_id` cascades,
 * so deleting a group that holds a zone's only `exclusive` rule would succeed and
 * quietly turn a restricted neighbourhood into open seating — nothing would report it,
 * the desks would simply go green one morning. The API refuses that, and this list
 * shows the dependency next to the group so the refusal is never a surprise.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { del, patch, post } from "@/lib/client";
import { describeAdmin } from "@/lib/admin-messages";
import { ProblemError, type AdminGroup } from "@/lib/types";

export function GroupsPanel({ groups }: { groups: AdminGroup[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      router.refresh();
    } catch (problem) {
      setError(
        problem instanceof ProblemError ? describeAdmin(problem) : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Groups</h1>
        <span className="pill">{groups.length}</span>
      </div>

      <section className="card">
        <div className="row">
          <input
            type="text"
            value={name}
            placeholder="New group name"
            aria-label="New group name"
            onChange={(event) => setName(event.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              run(async () => {
                await post("/v1/admin/groups", { name: name.trim() });
                setName("");
              })
            }
          >
            Create
          </button>
        </div>
      </section>

      <section className="card">
        {groups.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No groups yet. Zone permissions and the team view both need one.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 12 }}>
                <th style={{ padding: "6px 0" }}>Group</th>
                <th>People</th>
                <th>Zones</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 0" }}>
                    {renaming === group.id ? (
                      <div className="row">
                        <input
                          type="text"
                          value={draft}
                          aria-label={`Rename ${group.name}`}
                          onChange={(event) => setDraft(event.target.value)}
                          style={{ maxWidth: 220 }}
                        />
                        <button
                          disabled={busy || !draft.trim()}
                          onClick={() =>
                            run(async () => {
                              await patch(`/v1/admin/groups/${group.id}`, {
                                name: draft.trim(),
                                kind: group.kind,
                              });
                              setRenaming(null);
                            })
                          }
                        >
                          Save
                        </button>
                        <button onClick={() => setRenaming(null)}>Cancel</button>
                      </div>
                    ) : (
                      group.name
                    )}
                  </td>
                  <td className="small">
                    <Link href={`/people?group=${group.id}`}>
                      {group.member_count} {group.member_count === 1 ? "person" : "people"}
                    </Link>
                  </td>
                  <td className="small muted">
                    {group.zones.length
                      ? group.zones.map((zone) => `${zone.name} (${zone.mode})`).join(", ")
                      : "—"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {renaming === group.id ? null : (
                      <button
                        onClick={() => {
                          setRenaming(group.id);
                          setDraft(group.name);
                        }}
                      >
                        Rename
                      </button>
                    )}{" "}
                    <button
                      className="danger"
                      // Not disabled when a zone depends on it: the click is how an
                      // admin finds out why, and a dead button explains nothing.
                      disabled={busy}
                      onClick={() => run(() => del(`/v1/admin/groups/${group.id}`))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
