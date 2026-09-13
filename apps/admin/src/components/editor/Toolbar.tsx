"use client";

import type { Tool } from "@/components/editor/Canvas";

type Props = {
  tool: Tool;
  onTool: (tool: Tool) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  snapDivisions: number | null;
  onSnap: (divisions: number | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onPublish: () => void;
  onUpload: (file: File) => void;
  uploading: boolean;
  hasPlan: boolean;
  counts: { desks: number; rooms: number; zones: number };
};

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "select", label: "Select", hint: "V — click, shift-click, or drag a marquee" },
  { id: "place", label: "Place", hint: "P — click to drop one desk" },
  { id: "bulk", label: "Grid", hint: "G — drag a rectangle to fill it with desks" },
  { id: "zone", label: "Zone", hint: "Z — click points, Enter or click the start to close" },
];

export function Toolbar({
  tool,
  onTool,
  zoom,
  onZoom,
  snapDivisions,
  onSnap,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  dirty,
  saving,
  onSave,
  onDiscard,
  onPublish,
  onUpload,
  uploading,
  hasPlan,
  counts,
}: Props) {
  return (
    <div
      className="row"
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        flexWrap: "wrap",
      }}
    >
      <div className="row" role="group" aria-label="Tools">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            className={tool === entry.id ? "active" : ""}
            aria-pressed={tool === entry.id}
            title={entry.hint}
            onClick={() => onTool(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <span style={{ width: 1, height: 22, background: "var(--border)" }} />

      <button onClick={onUndo} disabled={!canUndo} title="⌘Z">
        Undo
      </button>
      <button onClick={onRedo} disabled={!canRedo} title="⇧⌘Z">
        Redo
      </button>

      <span style={{ width: 1, height: 22, background: "var(--border)" }} />

      <label htmlFor="zoom" style={{ margin: 0 }}>
        Zoom
      </label>
      <input
        id="zoom"
        type="range"
        min={1}
        max={4}
        step={0.25}
        value={zoom}
        onChange={(event) => onZoom(Number(event.target.value))}
        style={{ width: 90 }}
      />
      <span className="muted small" style={{ width: 34 }}>
        {zoom.toFixed(2)}×
      </span>

      <label htmlFor="snap" style={{ margin: 0 }}>
        Snap
      </label>
      <select
        id="snap"
        value={snapDivisions ?? ""}
        onChange={(event) => onSnap(event.target.value ? Number(event.target.value) : null)}
        style={{ width: 90 }}
      >
        {/* Off by default: real floor plans are not on a grid, and forcing one fights
            the drawing instead of helping it. */}
        <option value="">off</option>
        <option value="20">20</option>
        <option value="40">40</option>
        <option value="80">80</option>
      </select>

      <div className="spacer" />

      <span className="muted small">
        {counts.desks} desks · {counts.rooms} rooms · {counts.zones} zones
      </span>

      <label
        className="row"
        style={{
          margin: 0,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "6px 12px",
          cursor: uploading ? "default" : "pointer",
          opacity: uploading ? 0.45 : 1,
        }}
      >
        {uploading ? "Uploading…" : hasPlan ? "Replace plan" : "Upload plan"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          disabled={uploading}
          style={{ display: "none", width: 0 }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset the input so choosing the same file twice fires again — a
            // re-upload after a failed one is the common case.
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </label>

      <button onClick={onDiscard} disabled={saving}>
        Discard draft
      </button>
      <button onClick={onSave} disabled={!dirty || saving}>
        {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
      </button>
      <button className="primary" onClick={onPublish} disabled={saving}>
        Publish…
      </button>
    </div>
  );
}
