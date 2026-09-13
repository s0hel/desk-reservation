"use client";

/**
 * The floor plan editor (TDD §14.3).
 *
 * Owns the document, the tool mode and every call to the API. The pieces below it are
 * presentational; the maths and the undo stack live in `lib/`, tested without a
 * browser, because that is the only layer of this stack that can be tested at all (see
 * CLAUDE.md).
 *
 * Saving is explicit and batched. Nothing here autosaves: a CAD-ish tool that writes on
 * every drag has no coherent undo, and an admin who drags a desk across the room by
 * accident should be able to press ⌘Z rather than discover it on the floor plan
 * tomorrow.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { BulkDialog } from "@/components/editor/BulkDialog";
import { Canvas, type Tool } from "@/components/editor/Canvas";
import { Inspector } from "@/components/editor/Inspector";
import { PublishDialog } from "@/components/editor/PublishDialog";
import { del, get, post, put, upload } from "@/lib/client";
import { Toolbar } from "@/components/editor/Toolbar";
import {
  initialState,
  isDirty,
  newKey,
  reducer,
  type NewResource,
} from "@/lib/editor-state";
import type { Point, Rect } from "@/lib/geometry";
import { describeAll } from "@/lib/messages";
import {
  ProblemError,
  type FloorEditorData,
  type Layout,
  type Plan,
  type PublishPreflight,
} from "@/lib/types";

const NUDGE = 0.002;
const NUDGE_COARSE = 0.02;

export function Editor({ initial }: { initial: FloorEditorData }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, initial.layout, initialState);
  const [plan, setPlan] = useState<Plan | null>(initial.plan);
  const [tool, setTool] = useState<Tool>("select");
  const [zoom, setZoom] = useState(1);
  const [snapDivisions, setSnapDivisions] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkRect, setBulkRect] = useState<Rect | null>(null);
  const [takenCodes, setTakenCodes] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [preflight, setPreflight] = useState<PublishPreflight | null>(null);
  const [acceptOrphans, setAcceptOrphans] = useState(false);

  const floorId = initial.floor.id;
  const dirty = isDirty(state);

  const aspectRatio =
    plan && plan.height_px ? plan.width_px / plan.height_px : 1.5;

  const selectedResources = useMemo(() => {
    const keys = new Set(state.selection);
    return state.layout.resources.filter((resource) => keys.has(resource.key));
  }, [state.layout.resources, state.selection]);

  const activeZone =
    state.layout.zones.find((zone) => zone.key === state.activeZone) ?? null;

  const counts = useMemo(
    () => ({
      desks: state.layout.resources.filter((r) => r.kind === "desk").length,
      rooms: state.layout.resources.filter((r) => r.kind === "room").length,
      zones: state.layout.zones.length,
    }),
    [state.layout],
  );

  const report = useCallback((caught: unknown, fallback: string) => {
    setStatus(null);
    setError(
      caught instanceof ProblemError
        ? describeAll(caught.violations, caught.detail || fallback)
        : fallback,
    );
  }, []);

  // Codes are unique per SITE, so the bulk dialog needs what is taken on other floors
  // too. Fetched once; the editor knows its own codes already.
  useEffect(() => {
    get<string[]>(`/v1/admin/floors/${floorId}/codes`)
      .then(setTakenCodes)
      // A failure here costs a warning, not the editor: the API still rejects a clash.
      .catch(() => setTakenCodes([]));
  }, [floorId]);

  // ------------------------------------------------------------------- persistence

  const save = useCallback(async (): Promise<Layout | null> => {
    setSaving(true);
    setError(null);
    try {
      const response = await put<{ layout: Layout; base_version: number }>(
        `/v1/admin/floors/${floorId}/layout`,
        state.layout,
      );
      // Save the layout the SERVER stored, not the one we sent: it fills in attribute
      // defaults, and marking our version as saved would leave the editor permanently
      // one edit "dirty".
      dispatch({ type: "markSaved", layout: response.layout });
      setStatus("Draft saved. Employees still see the published floor.");
      return response.layout;
    } catch (caught) {
      report(caught, "Could not save the draft.");
      return null;
    } finally {
      setSaving(false);
    }
  }, [floorId, state.layout, report]);

  async function discard() {
    if (!confirm("Discard every unpublished change on this floor?")) return;
    setSaving(true);
    try {
      await del(`/v1/admin/floors/${floorId}/draft`);
      // Re-render from the server rather than guessing what live looks like.
      router.refresh();
      setStatus("Draft discarded.");
    } catch (caught) {
      report(caught, "Could not discard the draft.");
    } finally {
      setSaving(false);
    }
  }

  async function uploadPlan(file: File) {
    setUploading(true);
    setError(null);
    try {
      const uploaded = await upload<Plan>(`/v1/admin/floors/${floorId}/plan`, file);
      setPlan(uploaded);
      dispatch({ type: "setPlanAsset", assetId: uploaded.asset_id });
      // The upload endpoint attaches the asset to the DRAFT server-side, so the editor
      // already agrees with the server — mark it saved rather than leaving a phantom
      // unsaved change the admin cannot see.
      setStatus(
        uploaded.converted
          ? `Plan uploaded and converted to ${uploaded.width_px}×${uploaded.height_px}. Not visible to employees until you publish.`
          : `Plan uploaded (${uploaded.width_px}×${uploaded.height_px}). Not visible to employees until you publish.`,
      );
    } catch (caught) {
      report(caught, "Could not upload that plan.");
    } finally {
      setUploading(false);
    }
  }

  async function openPublish() {
    setPublishOpen(true);
    setPreflight(null);
    setAcceptOrphans(false);
    setError(null);
    // Preflight reads the DRAFT, so an unsaved edit would not be counted. Save first,
    // rather than showing an admin a confident summary of the wrong document.
    if (dirty && !(await save())) {
      setPublishOpen(false);
      return;
    }
    try {
      setPreflight(await get<PublishPreflight>(`/v1/admin/floors/${floorId}/publish`));
    } catch (caught) {
      report(caught, "Could not work out what publishing would change.");
      setPublishOpen(false);
    }
  }

  async function confirmPublish() {
    setPublishing(true);
    setError(null);
    try {
      await post(`/v1/admin/floors/${floorId}/publish`, { accept_orphans: acceptOrphans });
      setPublishOpen(false);
      setStatus("Published. Employees see this floor now.");
      router.refresh();
    } catch (caught) {
      report(caught, "Could not publish.");
    } finally {
      setPublishing(false);
    }
  }

  // --------------------------------------------------------------------- shortcuts

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke from a field the admin is typing in — Delete inside the
      // code input must delete a character, not forty desks.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (meta && event.key.toLowerCase() === "a") {
        event.preventDefault();
        dispatch({
          type: "select",
          keys: state.layout.resources.map((r) => r.key),
          mode: "replace",
        });
        return;
      }
      if (meta) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        dispatch({ type: "deleteSelection" });
        return;
      }
      if (event.key === "Escape") {
        dispatch({ type: "clearSelection" });
        setTool("select");
        return;
      }

      const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
      const nudges: Record<string, Point> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      };
      if (nudges[event.key]) {
        if (state.selection.length === 0) return;
        event.preventDefault();
        dispatch({ type: "moveSelection", delta: nudges[event.key] });
        return;
      }

      const tools: Record<string, Tool> = { v: "select", p: "place", g: "bulk", z: "zone" };
      const next = tools[event.key.toLowerCase()];
      if (next) setTool(next);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, state.layout.resources, state.selection.length]);

  // Leaving with unsaved work loses it: the draft only exists on the server once saved.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ------------------------------------------------------------------------ actions

  const nextCode = useCallback((): string => {
    // A new desk needs a code that is free, and typing one per desk is exactly the
    // tedium the Grid tool exists to avoid — so guess, from the floor's own naming.
    const existing = new Set(
      state.layout.resources.map((r) => r.code.toLowerCase()),
    );
    const prefix = initial.floor.name.match(/\d+/)?.[0]
      ? `${initial.floor.name.match(/\d+/)![0]}F-NEW-`
      : "NEW-";
    for (let n = 1; n < 1000; n++) {
      const candidate = `${prefix}${String(n).padStart(2, "0")}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return `${prefix}${Date.now()}`;
  }, [state.layout.resources, initial.floor.name]);

  const defaultPattern = useMemo(() => {
    const floorNumber = initial.floor.name.match(/\d+/)?.[0];
    return floorNumber ? `${floorNumber}F-{A..D}-{01..06}` : "{A..D}-{01..06}";
  }, [initial.floor.name]);

  function createBulk(items: NewResource[]) {
    setBulkRect(null);
    dispatch({ type: "addResources", items });
    setTool("select");
  }

  const publishedState = initial.floor.published_at
    ? new Date(initial.floor.published_at).toLocaleString()
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 45px)" }}>
      <div
        className="row"
        style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="muted small">
          ← Sites
        </Link>
        <strong>{initial.site.name}</strong>
        <span className="muted">/</span>
        <strong>{initial.floor.name}</strong>
        {dirty ? (
          <span className="pill draft">unsaved</span>
        ) : initial.is_draft ? (
          <span className="pill draft">draft not published</span>
        ) : publishedState ? (
          <span className="pill published">published {publishedState}</span>
        ) : (
          <span className="pill">never published</span>
        )}
        <div className="spacer" />
        {error ? (
          <span className="error small">{error}</span>
        ) : status ? (
          <span className="muted small">{status}</span>
        ) : null}
      </div>

      <Toolbar
        tool={tool}
        onTool={setTool}
        zoom={zoom}
        onZoom={setZoom}
        snapDivisions={snapDivisions}
        onSnap={setSnapDivisions}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        onUndo={() => dispatch({ type: "undo" })}
        onRedo={() => dispatch({ type: "redo" })}
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => void discard()}
        onPublish={() => void openPublish()}
        onUpload={(file) => void uploadPlan(file)}
        uploading={uploading}
        hasPlan={!!plan}
        counts={counts}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Canvas
          layout={state.layout}
          plan={plan}
          aspectRatio={aspectRatio}
          tool={tool}
          zoom={zoom}
          selection={state.selection}
          activeZone={state.activeZone}
          snapDivisions={snapDivisions}
          onSelect={(keys, mode) => dispatch({ type: "select", keys, mode })}
          onSelectInRect={(rect, mode) => dispatch({ type: "selectInRect", rect, mode })}
          onPlace={(position) =>
            dispatch({
              type: "addResources",
              items: [{ kind: "desk", code: nextCode(), position }],
            })
          }
          onMove={(delta) => dispatch({ type: "moveSelection", delta })}
          onBulkRect={setBulkRect}
          onZoneDrawn={(polygon) =>
            dispatch({
              type: "addZone",
              zone: {
                key: newKey("z"),
                name: `Zone ${state.layout.zones.length + 1}`,
                kind: "neighborhood",
                polygon,
                color: "#4f7df3",
                permissions: [],
              },
            })
          }
          onActivateZone={(key) => dispatch({ type: "setActiveZone", key })}
        />

        <Inspector
          selection={selectedResources}
          zones={state.layout.zones}
          activeZone={activeZone}
          groups={initial.groups}
          onPatch={(patch) => dispatch({ type: "patchSelection", patch })}
          onPatchAttributes={(attributes) => dispatch({ type: "patchAttributes", attributes })}
          onDelete={() => dispatch({ type: "deleteSelection" })}
          onPatchZone={(key, patch) => dispatch({ type: "patchZone", key, patch })}
          onDeleteZone={(key) => dispatch({ type: "deleteZone", key })}
        />
      </div>

      {bulkRect ? (
        <BulkDialog
          rect={bulkRect}
          defaultPattern={defaultPattern}
          takenCodes={[
            ...takenCodes,
            ...state.layout.resources.map((resource) => resource.code),
          ]}
          onCancel={() => setBulkRect(null)}
          onCreate={createBulk}
        />
      ) : null}

      {publishOpen ? (
        <PublishDialog
          preflight={preflight}
          error={error}
          publishing={publishing}
          accepted={acceptOrphans}
          onAccept={setAcceptOrphans}
          onCancel={() => setPublishOpen(false)}
          onConfirm={() => void confirmPublish()}
        />
      ) : null}
    </div>
  );
}
