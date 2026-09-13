"use client";

/**
 * Fill a dragged rectangle with a named grid of desks.
 *
 * This is the editor's primary path, not a shortcut (TDD §14.3). An admin placing 300
 * desks individually abandons onboarding, and so does one who places them in a grid and
 * then renames all 300 — so the naming pattern and its clashes are shown BEFORE
 * anything is created, while they can still be fixed by editing one field.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { gridPoints, type Rect } from "@/lib/geometry";
import { PatternError, clashingNames, expandPattern } from "@/lib/naming";
import type { NewResource } from "@/lib/editor-state";
import type { ResourceKind } from "@/lib/types";

type Props = {
  rect: Rect;
  takenCodes: string[];
  defaultPattern: string;
  onCancel: () => void;
  onCreate: (items: NewResource[]) => void;
};

export function BulkDialog({ rect, takenCodes, defaultPattern, onCancel, onCreate }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState(4);
  const [columns, setColumns] = useState(6);
  const [kind, setKind] = useState<ResourceKind>("desk");
  const [pattern, setPattern] = useState(defaultPattern);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const cells = Math.max(0, rows) * Math.max(0, columns);

  const preview = useMemo(() => {
    try {
      const names = expandPattern(pattern);
      return { names, error: null as string | null };
    } catch (error) {
      return {
        names: [] as string[],
        error: error instanceof PatternError ? error.message : "Invalid pattern",
      };
    }
  }, [pattern]);

  const names = preview.names.slice(0, cells);
  const short = preview.error === null && names.length < cells;
  const clashes = clashingNames(names, takenCodes);
  const blocked = preview.error !== null || short || clashes.length > 0 || cells === 0;

  function create() {
    const points = gridPoints(rect, rows, columns);
    onCreate(
      points.map((position, index) => ({
        kind,
        code: names[index],
        position,
        capacity: kind === "room" ? 6 : 1,
      })),
    );
  }

  return (
    <dialog ref={dialogRef} onCancel={onCancel} onClose={onCancel}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Fill this area</h2>

      <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 80 }}>
          <label htmlFor="rows">Rows</label>
          <input
            id="rows"
            type="number"
            min={1}
            max={60}
            value={rows}
            autoFocus
            onChange={(event) => setRows(Number(event.target.value))}
          />
        </div>
        <div style={{ width: 80 }}>
          <label htmlFor="columns">Columns</label>
          <input
            id="columns"
            type="number"
            min={1}
            max={60}
            value={columns}
            onChange={(event) => setColumns(Number(event.target.value))}
          />
        </div>
        <div style={{ width: 110 }}>
          <label htmlFor="bulk-kind">Type</label>
          <select
            id="bulk-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as ResourceKind)}
          >
            <option value="desk">Desks</option>
            <option value="room">Rooms</option>
          </select>
        </div>
        <span className="muted small" style={{ paddingBottom: 8 }}>
          {cells} cells
        </span>
      </div>

      <div style={{ marginTop: 12 }}>
        <label htmlFor="pattern">Naming pattern</label>
        <input
          id="pattern"
          type="text"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
        />
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          <code>{"{01..24}"}</code> counts, <code>{"{A..E}"}</code> letters. The first
          range varies slowest, so <code>{"4F-{A..E}-{01..12}"}</code> reads as rows then
          columns.
        </p>
      </div>

      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          minHeight: 56,
        }}
      >
        {preview.error ? (
          <p className="error small" style={{ margin: 0 }}>
            {preview.error}
          </p>
        ) : (
          <>
            <p className="small" style={{ margin: 0 }}>
              {names.slice(0, 6).join(", ")}
              {names.length > 6 ? ` … ${names[names.length - 1]}` : ""}
            </p>
            {short ? (
              <p className="error small" style={{ margin: "6px 0 0" }}>
                The pattern makes {preview.names.length} names but the grid has {cells}{" "}
                cells. Widen the range or shrink the grid.
              </p>
            ) : null}
            {clashes.length ? (
              <p className="error small" style={{ margin: "6px 0 0" }}>
                Already used on this site: {clashes.slice(0, 6).join(", ")}
                {clashes.length > 6 ? ` and ${clashes.length - 6} more` : ""}.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={blocked} onClick={create}>
          Create {cells} {kind === "room" ? "rooms" : "desks"}
        </button>
      </div>
    </dialog>
  );
}
