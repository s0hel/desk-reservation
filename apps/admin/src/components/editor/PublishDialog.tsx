"use client";

/**
 * The one screen that exists to make an admin look before they change a floor people
 * are already booking (TDD §14.3).
 *
 * Two things it must not do. It must not report changes that are not changes — a
 * preflight that says "312 updates" on an untouched floor teaches admins to click
 * through it, and then it is worse than nothing. And it must not let the
 * affected-booking count be dismissed by momentum: accepting it is a separate,
 * explicit checkbox, not a second click in the same place as the first.
 */

import { useEffect, useRef } from "react";

import type { PublishPreflight } from "@/lib/types";

type Props = {
  preflight: PublishPreflight | null;
  error: string | null;
  publishing: boolean;
  accepted: boolean;
  onAccept: (accepted: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function PublishDialog({
  preflight,
  error,
  publishing,
  accepted,
  onAccept,
  onCancel,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const orphans = preflight?.orphans ?? [];
  const blocked = orphans.length > 0 && !accepted;

  return (
    <dialog ref={dialogRef} onCancel={onCancel} onClose={onCancel}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Publish this floor</h2>

      {!preflight ? (
        <p className="muted">Checking what this would change…</p>
      ) : preflight.is_empty ? (
        <p className="muted">
          Nothing to publish — the draft matches what employees already see.
        </p>
      ) : (
        <>
          <ul className="small" style={{ paddingLeft: 18, margin: "0 0 12px" }}>
            {preflight.creates ? <li>{preflight.creates} resources added</li> : null}
            {preflight.updates ? <li>{preflight.updates} resources changed</li> : null}
            {preflight.deletes ? <li>{preflight.deletes} resources removed</li> : null}
            {preflight.zone_creates ? <li>{preflight.zone_creates} zones added</li> : null}
            {preflight.zone_updates ? <li>{preflight.zone_updates} zones changed</li> : null}
            {preflight.zone_deletes ? <li>{preflight.zone_deletes} zones removed</li> : null}
            {preflight.plan_changed ? <li>the floor plan image is replaced</li> : null}
          </ul>

          {preflight.aspect_ratio_change ? (
            <p className="warn small">
              The replacement plan has a different shape ({preflight.aspect_ratio_change.from}{" "}
              → {preflight.aspect_ratio_change.to}). Desk positions are stored relative to
              the image, so they will land in different places. Check the plan before
              publishing (TDD §14.2).
            </p>
          ) : null}

          {orphans.length ? (
            <div
              style={{
                border: "1px solid var(--danger)",
                borderRadius: 8,
                padding: 10,
                marginBottom: 12,
              }}
            >
              <p className="error small" style={{ margin: "0 0 6px", fontWeight: 600 }}>
                {preflight.affected_bookings} existing booking
                {preflight.affected_bookings === 1 ? "" : "s"} will be cancelled.
              </p>
              <ul className="small muted" style={{ paddingLeft: 18, margin: "0 0 8px" }}>
                {orphans.slice(0, 8).map((orphan) => (
                  <li key={orphan.resource_id}>
                    {orphan.code} — {orphan.bookings} booking
                    {orphan.bookings === 1 ? "" : "s"} (
                    {orphan.reason === "deleted" ? "removed" : "out of service"})
                  </li>
                ))}
                {orphans.length > 8 ? <li>and {orphans.length - 8} more</li> : null}
              </ul>
              <p className="muted small" style={{ margin: "0 0 8px" }}>
                Everyone affected is emailed. Their desk history is kept.
              </p>
              <label className="row" style={{ margin: 0, color: "var(--text)", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => onAccept(event.target.checked)}
                  style={{ width: "auto" }}
                />
                Cancel them and publish
              </label>
            </div>
          ) : null}
        </>
      )}

      {error ? <p className="error small">{error}</p> : null}

      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button onClick={onCancel} disabled={publishing}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!preflight || preflight.is_empty || blocked || publishing}
          onClick={onConfirm}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>
    </dialog>
  );
}
