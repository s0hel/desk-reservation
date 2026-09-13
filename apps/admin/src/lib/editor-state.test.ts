import { beforeEach, describe, expect, it } from "vitest";

import {
  HISTORY_LIMIT,
  initialState,
  isDirty,
  newKey,
  reducer,
  type EditorState,
} from "@/lib/editor-state";
import type { Layout, LayoutResource } from "@/lib/types";

function desk(key: string, x: number, y: number, over: Partial<LayoutResource> = {}) {
  return {
    key,
    id: null,
    kind: "desk" as const,
    code: key.toUpperCase(),
    name: null,
    position: { x, y, rotation: 0 },
    capacity: 1,
    attributes: { sit_stand: false, monitors: 0, dock: "none" },
    zone_key: null,
    bookable: true,
    out_of_service_reason: null,
    ...over,
  };
}

const LAYOUT: Layout = {
  version: 1,
  plan_asset_id: null,
  resources: [desk("a", 0.2, 0.2), desk("b", 0.4, 0.2), desk("c", 0.6, 0.8)],
  zones: [],
};

let state: EditorState;
beforeEach(() => {
  state = initialState(structuredClone(LAYOUT));
});

const apply = (s: EditorState, ...actions: Parameters<typeof reducer>[1][]) =>
  actions.reduce(reducer, s);

const at = (s: EditorState, key: string) => s.layout.resources.find((r) => r.key === key)!;

describe("selection", () => {
  it("replaces, adds and toggles", () => {
    let s = reducer(state, { type: "select", keys: ["a"], mode: "replace" });
    expect(s.selection).toEqual(["a"]);
    s = reducer(s, { type: "select", keys: ["b"], mode: "add" });
    expect(new Set(s.selection)).toEqual(new Set(["a", "b"]));
    s = reducer(s, { type: "select", keys: ["a"], mode: "toggle" });
    expect(s.selection).toEqual(["b"]);
  });

  it("selects what a marquee covers", () => {
    const s = reducer(state, {
      type: "selectInRect",
      rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
      mode: "replace",
    });
    expect(new Set(s.selection)).toEqual(new Set(["a", "b"]));
  });

  it("does not put selection changes on the undo stack", () => {
    // Undo should step back through edits, not through every click. An editor where
    // ⌘Z first undoes four selections is one nobody trusts.
    const s = reducer(state, { type: "select", keys: ["a"], mode: "replace" });
    expect(s.past).toHaveLength(0);
  });
});

describe("adding resources", () => {
  it("selects what it just created", () => {
    const s = reducer(state, {
      type: "addResources",
      items: [
        { kind: "desk", code: "N-1", position: { x: 0.5, y: 0.5 } },
        { kind: "desk", code: "N-2", position: { x: 0.6, y: 0.5 } },
      ],
    });
    expect(s.layout.resources).toHaveLength(5);
    // Placing a grid and then setting its attributes has to be one gesture.
    expect(s.selection).toHaveLength(2);
    expect(s.layout.resources.slice(-2).map((r) => r.code)).toEqual(["N-1", "N-2"]);
  });

  it("gives new items a null id, so publish knows to create them", () => {
    const s = reducer(state, {
      type: "addResources",
      items: [{ kind: "desk", code: "N-1", position: { x: 0.5, y: 0.5 } }],
    });
    expect(s.layout.resources.at(-1)!.id).toBeNull();
  });

  it("fills the right attribute defaults per kind", () => {
    const s = reducer(state, {
      type: "addResources",
      items: [{ kind: "room", code: "R-1", position: { x: 0.5, y: 0.5 } }],
    });
    const room = s.layout.resources.at(-1)!;
    expect(room.attributes).toHaveProperty("video_conf", false);
    expect(room.attributes).not.toHaveProperty("monitors");
    expect(room.capacity).toBe(6);
  });

  it("clamps a position dropped outside the plan", () => {
    const s = reducer(state, {
      type: "addResources",
      items: [{ kind: "desk", code: "N-1", position: { x: 1.4, y: -0.2 } }],
    });
    expect(s.layout.resources.at(-1)!.position).toMatchObject({ x: 1, y: 0 });
  });
});

describe("moving", () => {
  it("moves the whole selection and nothing else", () => {
    const s = apply(
      state,
      { type: "select", keys: ["a", "b"], mode: "replace" },
      { type: "moveSelection", delta: { x: 0.1, y: 0 } },
    );
    expect(at(s, "a").position.x).toBeCloseTo(0.3);
    expect(at(s, "b").position.x).toBeCloseTo(0.5);
    expect(at(s, "c").position.x).toBeCloseTo(0.6);
  });

  it("keeps rotation while moving", () => {
    let s = initialState({
      ...LAYOUT,
      resources: [desk("a", 0.2, 0.2, { position: { x: 0.2, y: 0.2, rotation: 90 } })],
    });
    s = apply(
      s,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "moveSelection", delta: { x: 0.1, y: 0 } },
    );
    expect(at(s, "a").position.rotation).toBe(90);
  });

  it("is a no-op with nothing selected, and does not push history", () => {
    const s = reducer(state, { type: "moveSelection", delta: { x: 0.1, y: 0 } });
    expect(s).toBe(state);
  });
});

describe("patching a multi-selection", () => {
  it("applies to everything selected", () => {
    const s = apply(
      state,
      { type: "select", keys: ["a", "c"], mode: "replace" },
      { type: "patchAttributes", attributes: { sit_stand: true } },
    );
    expect(at(s, "a").attributes.sit_stand).toBe(true);
    expect(at(s, "c").attributes.sit_stand).toBe(true);
    expect(at(s, "b").attributes.sit_stand).toBe(false);
  });

  it("merges attributes rather than replacing the whole object", () => {
    const s = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "patchAttributes", attributes: { monitors: 2 } },
    );
    expect(at(s, "a").attributes).toMatchObject({ monitors: 2, dock: "none" });
  });

  it("resets attributes when the KIND changes", () => {
    // Desk and room attributes are validated against different schemas; carrying
    // `monitors` onto a room fails the save with a message about a field the admin
    // never typed.
    const s = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "patchAttributes", attributes: { monitors: 2 } },
      { type: "patchSelection", patch: { kind: "room" } },
    );
    expect(at(s, "a").attributes).not.toHaveProperty("monitors");
    expect(at(s, "a").attributes).toHaveProperty("video_conf", false);
  });

  it("leaves attributes alone when the kind is set to what it already is", () => {
    const s = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "patchAttributes", attributes: { monitors: 2 } },
      { type: "patchSelection", patch: { kind: "desk" } },
    );
    expect(at(s, "a").attributes.monitors).toBe(2);
  });
});

describe("deleting", () => {
  it("removes the selection and clears it", () => {
    const s = apply(
      state,
      { type: "select", keys: ["a", "b"], mode: "replace" },
      { type: "deleteSelection" },
    );
    expect(s.layout.resources.map((r) => r.key)).toEqual(["c"]);
    expect(s.selection).toEqual([]);
  });
});

describe("zones", () => {
  const polygon: [number, number][] = [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
  ];

  it("adds a zone and makes it active", () => {
    const s = reducer(state, {
      type: "addZone",
      zone: { key: "z1", name: "Eng", kind: "neighborhood", polygon, color: null, permissions: [] },
    });
    expect(s.layout.zones).toHaveLength(1);
    expect(s.activeZone).toBe("z1");
  });

  it("detaches desks from a deleted zone instead of deleting them", () => {
    let s = initialState({
      ...structuredClone(LAYOUT),
      zones: [
        { key: "z1", id: null, name: "Eng", kind: "neighborhood", polygon, color: null, permissions: [] },
      ],
    });
    s = reducer(s, { type: "patchZone", key: "z1", patch: { name: "Engineering" } });
    s.layout.resources[0].zone_key = "z1";

    s = reducer(s, { type: "deleteZone", key: "z1" });
    expect(s.layout.zones).toHaveLength(0);
    expect(s.layout.resources).toHaveLength(3);
    expect(at(s, "a").zone_key).toBeNull();
    expect(s.activeZone).toBeNull();
  });
});

describe("undo and redo", () => {
  it("steps back and forward through edits", () => {
    const s = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "moveSelection", delta: { x: 0.1, y: 0 } },
    );
    expect(at(s, "a").position.x).toBeCloseTo(0.3);

    const undone = reducer(s, { type: "undo" });
    expect(at(undone, "a").position.x).toBeCloseTo(0.2);

    const redone = reducer(undone, { type: "redo" });
    expect(at(redone, "a").position.x).toBeCloseTo(0.3);
  });

  it("does nothing at either end of the stack", () => {
    expect(reducer(state, { type: "undo" })).toBe(state);
    expect(reducer(state, { type: "redo" })).toBe(state);
  });

  it("abandons the redo branch once a new edit happens", () => {
    const moved = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "moveSelection", delta: { x: 0.1, y: 0 } },
    );
    const undone = reducer(moved, { type: "undo" });
    const diverged = reducer(undone, {
      type: "addResources",
      items: [{ kind: "desk", code: "N-1", position: { x: 0.5, y: 0.5 } }],
    });
    expect(diverged.future).toHaveLength(0);
    expect(reducer(diverged, { type: "redo" })).toBe(diverged);
  });

  it("prunes a selection that undo brought back to nothing", () => {
    // The classic undo bug: undoing an ADD leaves the selection pointing at items that
    // no longer exist, and the next keystroke edits ghosts.
    const added = reducer(state, {
      type: "addResources",
      items: [{ kind: "desk", code: "N-1", position: { x: 0.5, y: 0.5 } }],
    });
    expect(added.selection).toHaveLength(1);

    const undone = reducer(added, { type: "undo" });
    expect(undone.layout.resources).toHaveLength(3);
    expect(undone.selection).toEqual([]);
  });

  it("restores deleted items on undo", () => {
    const deleted = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "deleteSelection" },
    );
    const restored = reducer(deleted, { type: "undo" });
    expect(restored.layout.resources.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("bounds the history so a long session cannot grow without limit", () => {
    let s = reducer(state, { type: "select", keys: ["a"], mode: "replace" });
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      s = reducer(s, { type: "moveSelection", delta: { x: 0.0001, y: 0 } });
    }
    expect(s.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe("dirty tracking", () => {
  it("is clean until something changes", () => {
    expect(isDirty(state)).toBe(false);
  });

  it("is dirty after an edit and clean again after a matching save", () => {
    const edited = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "moveSelection", delta: { x: 0.1, y: 0 } },
    );
    expect(isDirty(edited)).toBe(true);
    expect(isDirty(reducer(edited, { type: "markSaved" }))).toBe(false);
  });

  it("adopts the server's normalized layout without wiping undo", () => {
    // The API fills in attribute defaults, so the response differs from what was sent.
    // Treating our own version as saved would leave the editor permanently one edit
    // dirty; resetting history instead would cost the admin their undo stack.
    const edited = apply(
      state,
      { type: "select", keys: ["a"], mode: "replace" },
      { type: "moveSelection", delta: { x: 0.1, y: 0 } },
    );
    const fromServer: Layout = structuredClone(edited.layout);
    fromServer.resources[0].attributes = {
      ...fromServer.resources[0].attributes,
      window: false,
      quiet: false,
      accessible: false,
    };

    const saved = reducer(edited, { type: "markSaved", layout: fromServer });
    expect(isDirty(saved)).toBe(false);
    expect(at(saved, "a").attributes).toHaveProperty("window", false);
    expect(saved.past.length).toBeGreaterThan(0);
    expect(at(reducer(saved, { type: "undo" }), "a").position.x).toBeCloseTo(0.2);
  });

  it("is dirty when a plan image is swapped, since that is a publishable change", () => {
    expect(isDirty(reducer(state, { type: "setPlanAsset", assetId: "abc" }))).toBe(true);
  });
});

describe("newKey", () => {
  it("does not collide", () => {
    const keys = new Set(Array.from({ length: 500 }, () => newKey()));
    expect(keys.size).toBe(500);
  });
});
