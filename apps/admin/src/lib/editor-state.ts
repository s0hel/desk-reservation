/**
 * Editor state and the undo stack (TDD §14.3).
 *
 * Undo is snapshot-based rather than a stack of inverse commands. A floor is a few
 * hundred small objects, so a snapshot costs nothing worth optimizing, and inverse
 * commands are where undo bugs live: every new action needs its inverse written and
 * kept correct, and the one that is wrong corrupts the document silently rather than
 * failing. Snapshots cannot be wrong — they are the document.
 *
 * Selection is deliberately NOT part of history. Undoing a delete and being handed a
 * selection of items that no longer exist is the other classic undo bug; instead the
 * selection is pruned to whatever still exists after every history move.
 *
 * A pure reducer, so all of this is testable without a browser — which is the only way
 * it gets tested at all (see CLAUDE.md on UI bugs in this stack).
 */

import { clampPoint, moveAll, rectContains, type Point, type Rect } from "@/lib/geometry";
import {
  defaultAttributes,
  type Layout,
  type LayoutResource,
  type LayoutZone,
  type ResourceKind,
} from "@/lib/types";

export const HISTORY_LIMIT = 100;

export type EditorState = {
  layout: Layout;
  /** Resource keys. Zones are selected one at a time, via `activeZone`. */
  selection: string[];
  activeZone: string | null;
  past: Layout[];
  future: Layout[];
  /** The layout as last saved, so "dirty" is a fact rather than a flag someone forgot. */
  saved: Layout;
};

export type NewResource = {
  kind: ResourceKind;
  code: string;
  position: Point;
  capacity?: number;
  zone_key?: string | null;
};

export type Action =
  | { type: "addResources"; items: NewResource[] }
  | { type: "moveSelection"; delta: Point }
  | { type: "setPositions"; positions: Record<string, Point> }
  | { type: "patchSelection"; patch: Partial<Omit<LayoutResource, "key" | "id">> }
  | { type: "patchAttributes"; attributes: Record<string, unknown> }
  | { type: "deleteSelection" }
  | { type: "select"; keys: string[]; mode: "replace" | "add" | "toggle" }
  | { type: "selectInRect"; rect: Rect; mode: "replace" | "add" }
  | { type: "clearSelection" }
  | { type: "addZone"; zone: Omit<LayoutZone, "id"> }
  | { type: "patchZone"; key: string; patch: Partial<Omit<LayoutZone, "key" | "id">> }
  | { type: "deleteZone"; key: string }
  | { type: "setActiveZone"; key: string | null }
  | { type: "setPlanAsset"; assetId: string | null }
  | { type: "replaceLayout"; layout: Layout; markSaved?: boolean }
  | { type: "markSaved"; layout?: Layout }
  | { type: "undo" }
  | { type: "redo" };

let counter = 0;
/** Keys only have to be unique within a session; publish replaces them with real ids. */
export function newKey(prefix = "n"): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function initialState(layout: Layout): EditorState {
  return {
    layout,
    selection: [],
    activeZone: null,
    past: [],
    future: [],
    saved: layout,
  };
}

export function isDirty(state: EditorState): boolean {
  return !layoutsEqual(state.layout, state.saved);
}

export function layoutsEqual(a: Layout, b: Layout): boolean {
  // Cheap and sufficient: both sides are produced by this module or parsed from the
  // API, so key order is stable.
  return JSON.stringify(a) === JSON.stringify(b);
}

function withHistory(state: EditorState, layout: Layout): EditorState {
  return {
    ...state,
    layout,
    past: [...state.past, state.layout].slice(-HISTORY_LIMIT),
    // Any new edit abandons the redo branch — the standard model, and the one users
    // expect from every other editor they have ever used.
    future: [],
  };
}

function prune(state: EditorState): EditorState {
  const keys = new Set(state.layout.resources.map((r) => r.key));
  const zones = new Set(state.layout.zones.map((z) => z.key));
  return {
    ...state,
    selection: state.selection.filter((key) => keys.has(key)),
    activeZone: state.activeZone && zones.has(state.activeZone) ? state.activeZone : null,
  };
}

function selectedResources(state: EditorState): LayoutResource[] {
  const selected = new Set(state.selection);
  return state.layout.resources.filter((r) => selected.has(r.key));
}

export function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case "addResources": {
      const added: LayoutResource[] = action.items.map((item) => ({
        key: newKey(),
        id: null,
        kind: item.kind,
        code: item.code,
        name: null,
        position: { ...clampPoint(item.position), rotation: 0 },
        capacity: item.capacity ?? (item.kind === "room" ? 6 : 1),
        attributes: defaultAttributes(item.kind),
        zone_key: item.zone_key ?? null,
        bookable: true,
        out_of_service_reason: null,
      }));
      const next = withHistory(state, {
        ...state.layout,
        resources: [...state.layout.resources, ...added],
      });
      // Selecting what was just created is what makes "place a grid, then set its
      // attributes" one gesture instead of two.
      return { ...next, selection: added.map((r) => r.key) };
    }

    case "moveSelection": {
      const selected = selectedResources(state);
      if (selected.length === 0) return state;
      const moved = moveAll(selected, action.delta);
      return withHistory(state, {
        ...state.layout,
        resources: state.layout.resources.map((r) => {
          const position = moved.get(r);
          return position ? { ...r, position: { ...r.position, ...position } } : r;
        }),
      });
    }

    case "setPositions": {
      return withHistory(state, {
        ...state.layout,
        resources: state.layout.resources.map((r) => {
          const position = action.positions[r.key];
          return position
            ? { ...r, position: { ...r.position, ...clampPoint(position) } }
            : r;
        }),
      });
    }

    case "patchSelection": {
      const selected = new Set(state.selection);
      if (selected.size === 0) return state;
      return withHistory(state, {
        ...state.layout,
        resources: state.layout.resources.map((r) =>
          selected.has(r.key)
            ? {
                ...r,
                ...action.patch,
                // Changing kind changes which attribute schema applies; carrying the
                // old attributes across would fail validation on save with a message
                // about a field the admin never typed.
                attributes:
                  action.patch.kind && action.patch.kind !== r.kind
                    ? defaultAttributes(action.patch.kind)
                    : r.attributes,
              }
            : r,
        ),
      });
    }

    case "patchAttributes": {
      const selected = new Set(state.selection);
      if (selected.size === 0) return state;
      return withHistory(state, {
        ...state.layout,
        resources: state.layout.resources.map((r) =>
          selected.has(r.key) ? { ...r, attributes: { ...r.attributes, ...action.attributes } } : r,
        ),
      });
    }

    case "deleteSelection": {
      const selected = new Set(state.selection);
      if (selected.size === 0) return state;
      const next = withHistory(state, {
        ...state.layout,
        resources: state.layout.resources.filter((r) => !selected.has(r.key)),
      });
      return prune(next);
    }

    case "select": {
      const current = new Set(state.selection);
      if (action.mode === "replace") return { ...state, selection: [...new Set(action.keys)] };
      for (const key of action.keys) {
        if (action.mode === "toggle" && current.has(key)) current.delete(key);
        else current.add(key);
      }
      return { ...state, selection: [...current] };
    }

    case "selectInRect": {
      const hits = state.layout.resources
        .filter((r) => rectContains(action.rect, r.position))
        .map((r) => r.key);
      if (action.mode === "add") {
        return { ...state, selection: [...new Set([...state.selection, ...hits])] };
      }
      return { ...state, selection: hits };
    }

    case "clearSelection":
      return { ...state, selection: [], activeZone: null };

    case "addZone": {
      const zone: LayoutZone = { id: null, ...action.zone };
      const next = withHistory(state, {
        ...state.layout,
        zones: [...state.layout.zones, zone],
      });
      return { ...next, activeZone: zone.key };
    }

    case "patchZone":
      return withHistory(state, {
        ...state.layout,
        zones: state.layout.zones.map((z) =>
          z.key === action.key ? { ...z, ...action.patch } : z,
        ),
      });

    case "deleteZone": {
      const next = withHistory(state, {
        ...state.layout,
        zones: state.layout.zones.filter((z) => z.key !== action.key),
        // Desks keep their place; they just stop belonging to the deleted zone.
        resources: state.layout.resources.map((r) =>
          r.zone_key === action.key ? { ...r, zone_key: null } : r,
        ),
      });
      return prune(next);
    }

    case "setActiveZone":
      return { ...state, activeZone: action.key };

    case "setPlanAsset":
      return withHistory(state, { ...state.layout, plan_asset_id: action.assetId });

    case "replaceLayout": {
      const next = {
        ...state,
        layout: action.layout,
        past: [],
        future: [],
        saved: action.markSaved ? action.layout : state.saved,
      };
      return prune(next);
    }

    case "markSaved":
      // The server returns the layout it stored, which differs from what was sent
      // (attribute defaults are filled in). Adopting the RESPONSE is what keeps "dirty"
      // from being true the instant a save succeeds.
      //
      // History is deliberately untouched: `replaceLayout` resets it, and a save that
      // costs the admin their undo stack is a save they learn not to press.
      return action.layout
        ? prune({ ...state, layout: action.layout, saved: action.layout })
        : { ...state, saved: state.layout };

    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return prune({
        ...state,
        layout: previous,
        past: state.past.slice(0, -1),
        future: [state.layout, ...state.future].slice(0, HISTORY_LIMIT),
      });
    }

    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return prune({
        ...state,
        layout: next,
        past: [...state.past, state.layout].slice(-HISTORY_LIMIT),
        future: rest,
      });
    }

    default:
      return state;
  }
}
