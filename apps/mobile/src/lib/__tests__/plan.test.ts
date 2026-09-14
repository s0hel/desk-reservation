/**
 * Floor plan geometry (TDD §13.3).
 *
 * These exist because the inverse transform shipped wrong and nothing caught it: the
 * correction was applied twice, which is the identity at scale 1, so tap-to-book looked
 * perfect until the first pinch and then missed every desk. The scale-1 case is
 * therefore the least interesting one here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NODE_RADIUS, buildIndex, findNearest, shortLabel, viewportToPlan, centreOn,} from "../plan";

const VIEW = { tx: 0, ty: 0, scale: 1, width: 400, height: 300 };

const desk = (id: string, x: number, y: number) => ({
  id,
  code: `4F-${id}`,
  position: { x, y },
});

describe("shortLabel", () => {
  it("keeps the row letter so labels stay unique across rows", () => {
    expect(shortLabel("4F-A-01")).toBe("A-01");
    expect(shortLabel("4F-B-01")).toBe("B-01");
    expect(shortLabel("4F-A-01")).not.toBe(shortLabel("4F-B-01"));
  });

  it("leaves short codes alone", () => {
    expect(shortLabel("R-01")).toBe("R-01");
    expect(shortLabel("desk")).toBe("desk");
  });
});

describe("viewportToPlan", () => {
  it("maps the centre to the centre at rest", () => {
    expect(viewportToPlan({ x: 200, y: 150 }, VIEW)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("maps corners to the unit square at rest", () => {
    expect(viewportToPlan({ x: 0, y: 0 }, VIEW)).toEqual({ x: 0, y: 0 });
    expect(viewportToPlan({ x: 400, y: 300 }, VIEW)).toEqual({ x: 1, y: 1 });
  });

  it("keeps the centre fixed under zoom", () => {
    const zoomed = { ...VIEW, scale: 3 };
    expect(viewportToPlan({ x: 200, y: 150 }, zoomed)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("contracts toward the centre as scale grows", () => {
    // THE regression case. At scale 1 a doubled correction is invisible, so assert a
    // point that only lands correctly when the inverse is applied exactly once.
    const zoomed = { ...VIEW, scale: 2 };
    expect(viewportToPlan({ x: 100, y: 150 }, zoomed)).toEqual({ x: 0.375, y: 0.5 });
  });

  it("is not idempotent, which is what the shipped bug assumed", () => {
    const zoomed = { ...VIEW, scale: 2 };
    const once = viewportToPlan({ x: 100, y: 150 }, zoomed);
    const twice = viewportToPlan({ x: once.x * VIEW.width, y: once.y * VIEW.height }, zoomed);
    expect(twice).not.toEqual(once);
  });

  it("accounts for panning", () => {
    const panned = { ...VIEW, tx: 40, ty: -30 };
    expect(viewportToPlan({ x: 240, y: 120 }, panned)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("accounts for pan and zoom together", () => {
    const both = { ...VIEW, tx: 50, ty: 25, scale: 2 };
    expect(viewportToPlan({ x: 250, y: 175 }, both)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("findNearest", () => {
  const desks = [desk("A-01", 0.1, 0.1), desk("A-02", 0.2, 0.1), desk("B-01", 0.1, 0.3)];
  const index = buildIndex(desks);

  it("finds a desk under an exact hit", () => {
    expect(findNearest(index, { x: 0.1, y: 0.1 })?.id).toBe("A-01");
  });

  it("finds the nearest when between two desks", () => {
    expect(findNearest(index, { x: 0.105, y: 0.1 })?.id).toBe("A-01");
    expect(findNearest(index, { x: 0.195, y: 0.1 })?.id).toBe("A-02");
  });

  it("returns null for empty space rather than the closest desk anywhere", () => {
    // A tap on the floor must not book something across the room.
    expect(findNearest(index, { x: 0.8, y: 0.8 })).toBeNull();
  });

  it("tolerates a near miss within the touch slop", () => {
    expect(findNearest(index, { x: 0.1 + NODE_RADIUS * 1.5, y: 0.1 })?.id).toBe("A-01");
  });

  it("rejects a miss beyond the touch slop", () => {
    expect(findNearest(index, { x: 0.1 + NODE_RADIUS * 3, y: 0.1 })).toBeNull();
  });

  it("searches neighbouring buckets, so a desk on a cell edge is still hittable", () => {
    const edgeIndex = buildIndex([desk("E-01", 1 / 12 - 0.0005, 0.5)]);
    expect(findNearest(edgeIndex, { x: 1 / 12 + 0.0005, y: 0.5 })?.id).toBe("E-01");
  });

  it("handles desks with missing positions without throwing", () => {
    const broken = buildIndex([{ id: "x", code: "4F-X-01", position: null }]);
    expect(findNearest(broken, { x: 0, y: 0 })?.id).toBe("x");
  });
});

describe("buildIndex", () => {
  it("groups by grid cell", () => {
    const index = buildIndex([desk("A-01", 0.01, 0.01), desk("A-02", 0.02, 0.02)]);
    expect(index.size).toBe(1);
    expect(index.get("0:0")).toHaveLength(2);
  });

  it("separates distant desks into different cells", () => {
    expect(buildIndex([desk("A-01", 0.05, 0.05), desk("Z-01", 0.95, 0.95)]).size).toBe(2);
  });
});

describe("worklet contract", () => {
  it("viewportToPlan still declares itself a worklet", () => {
    // Not a style check. This function is called from a gesture handler on the UI
    // thread; without the directive Reanimated aborts the process natively — no red
    // box, nothing in the Metro log, the app simply quits. Types cannot express this,
    // so it is asserted against the source.
    const source = readFileSync(join(__dirname, "..", "plan.ts"), "utf8");
    const body = source.slice(source.indexOf("export function viewportToPlan"));
    expect(body.slice(0, body.indexOf("const cx"))).toContain('"worklet"');
  });
});

describe("viewportToPlan with a letterboxed plan", () => {
  // A full-height viewport with a 3:2 plan centred in it: the plan occupies the
  // middle band, and everything above and below is empty ground.
  const boxed = {
    tx: 0,
    ty: 0,
    scale: 1,
    width: 400,
    height: 800,
    planX: 0,
    planY: 267,
    planWidth: 400,
    planHeight: 266,
  };

  it("maps the centre of the drawn plan to its centre, not the viewport's", () => {
    const p = viewportToPlan({ x: 200, y: 400 }, boxed);
    expect(p.x).toBeCloseTo(0.5, 5);
    expect(p.y).toBeCloseTo(0.5, 2);
  });

  it("maps the drawn plan's corners to 0 and 1", () => {
    expect(viewportToPlan({ x: 0, y: 267 }, boxed).y).toBeCloseTo(0, 5);
    expect(viewportToPlan({ x: 400, y: 533 }, boxed).y).toBeCloseTo(1, 2);
  });

  it("puts a tap in the letterbox outside the plan, so it selects nothing", () => {
    // Above the plan. It must fall outside [0,1] rather than clamping onto the top
    // row of desks, which would book the wrong one.
    expect(viewportToPlan({ x: 200, y: 40 }, boxed).y).toBeLessThan(0);
    expect(viewportToPlan({ x: 200, y: 760 }, boxed).y).toBeGreaterThan(1);
  });

  it("still zooms about the viewport centre", () => {
    const zoomed = { ...boxed, scale: 2 };
    // The viewport centre is also the plan centre here, so it is the fixed point.
    const p = viewportToPlan({ x: 200, y: 400 }, zoomed);
    expect(p.x).toBeCloseTo(0.5, 5);
    expect(p.y).toBeCloseTo(0.5, 2);
  });

  it("is unchanged when the plan fills the viewport", () => {
    const full = { tx: 12, ty: -8, scale: 1.7, width: 400, height: 266 };
    const explicit = { ...full, planX: 0, planY: 0, planWidth: 400, planHeight: 266 };
    expect(viewportToPlan({ x: 133, y: 90 }, full)).toEqual(
      viewportToPlan({ x: 133, y: 90 }, explicit),
    );
  });
});

describe("centreOn", () => {
  // A full-height viewport over a landscape plan: the drawing is wider than the frame
  // and shorter, which is the shape "sit near" actually opens into.
  const wide = {
    width: 402,
    height: 700,
    planX: -299,
    planY: 116,
    planWidth: 1000,
    planHeight: 467,
    scale: 1.5,
  };

  const drawn = (p: { x: number; y: number }, pan: { tx: number; ty: number }) => {
    const x = (wide.planX + p.x * wide.planWidth - wide.width / 2) * wide.scale + wide.width / 2;
    const y = (wide.planY + p.y * wide.planHeight - wide.height / 2) * wide.scale + wide.height / 2;
    return { x: x + pan.tx, y: y + pan.ty };
  };

  it("puts a mid-plan point in the middle of the viewport", () => {
    const point = { x: 0.5, y: 0.5 };
    const at = drawn(point, centreOn(point, wide));
    expect(at.x).toBeCloseTo(wide.width / 2, 5);
    expect(at.y).toBeCloseTo(wide.height / 2, 5);
  });

  // Without the clamp this is the band of empty ground that reads as a rendering fault.
  it("never pulls the plan's own edge inside the frame", () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.02, y: 0.98 },
    ]) {
      const pan = centreOn(point, wide);
      const left = drawn({ x: 0, y: 0 }, pan);
      const right = drawn({ x: 1, y: 1 }, pan);
      expect(left.x).toBeLessThanOrEqual(0.0001);
      expect(right.x).toBeGreaterThanOrEqual(wide.width - 0.0001);
    }
  });

  // Zoomed out far enough that the plan no longer fills the frame vertically, there is
  // no pan that covers it — centring the drawing is the only honest answer, and asking
  // for a point near the top must not drag it off-centre.
  it("centres an axis the plan cannot fill", () => {
    const short = { ...wide, scale: 1.2 };
    expect(short.planHeight * short.scale).toBeLessThan(short.height);
    const pan = centreOn({ x: 0.5, y: 0.1 }, short);
    const at = (y: number) =>
      (short.planY + y * short.planHeight - short.height / 2) * short.scale +
      short.height / 2 +
      pan.ty;
    expect((at(0) + at(1)) / 2).toBeCloseTo(short.height / 2, 5);
  });

  it("is a no-op at scale 1 for a plan that exactly fits", () => {
    const fits = {
      width: 402, height: 268, planX: 0, planY: 0,
      planWidth: 402, planHeight: 268, scale: 1,
    };
    expect(centreOn({ x: 0.5, y: 0.5 }, fits)).toEqual({ tx: 0, ty: 0 });
  });
});
