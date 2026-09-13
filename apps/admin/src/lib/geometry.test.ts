import { describe, expect, it } from "vitest";

import {
  clamp01,
  closesPolygon,
  gridPoints,
  moveAll,
  nearest,
  polygonContains,
  rectContains,
  rectFrom,
  snap,
  toPlan,
  toScreen,
} from "@/lib/geometry";

describe("plan <-> screen", () => {
  it("round-trips", () => {
    const view = { width: 1200, height: 800 };
    const point = { x: 0.37, y: 0.62 };
    expect(toPlan(toScreen(point, view), view)).toEqual(point);
  });

  it("does not divide by zero before the canvas has been measured", () => {
    expect(toPlan({ x: 10, y: 10 }, { width: 0, height: 0 })).toEqual({ x: 10, y: 10 });
  });
});

describe("rectFrom", () => {
  it("normalizes a drag in any direction", () => {
    const dragged = rectFrom({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.1 });
    expect(dragged.x).toBeCloseTo(0.2, 9);
    expect(dragged.y).toBeCloseTo(0.1, 9);
    expect(dragged.width).toBeCloseTo(0.6, 9);
    expect(dragged.height).toBeCloseTo(0.8, 9);
    // Dragging the other way must produce the same rectangle, exactly.
    expect(rectFrom({ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 })).toEqual(dragged);
  });
});

describe("rectContains", () => {
  const rect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

  it("includes the boundary, so a marquee drawn exactly on a desk takes it", () => {
    expect(rectContains(rect, { x: 0.2, y: 0.2 })).toBe(true);
    expect(rectContains(rect, { x: 0.6, y: 0.6 })).toBe(true);
  });

  it("excludes outside", () => {
    expect(rectContains(rect, { x: 0.19, y: 0.4 })).toBe(false);
  });
});

describe("gridPoints", () => {
  const rect = { x: 0, y: 0, width: 1, height: 1 };

  it("insets by half a cell so nothing sits on the edge of the drag", () => {
    expect(gridPoints(rect, 2, 2)).toEqual([
      { x: 0.25, y: 0.25 },
      { x: 0.75, y: 0.25 },
      { x: 0.25, y: 0.75 },
      { x: 0.75, y: 0.75 },
    ]);
  });

  it("centres a single row or column rather than pinning it to a corner", () => {
    expect(gridPoints(rect, 1, 1)).toEqual([{ x: 0.5, y: 0.5 }]);
    expect(gridPoints(rect, 1, 2)).toEqual([
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
    ]);
  });

  it("lays out left to right, top to bottom, matching the naming order", () => {
    const points = gridPoints(rect, 2, 3);
    expect(points).toHaveLength(6);
    expect(points.slice(0, 3).every((p) => p.y === points[0].y)).toBe(true);
    expect(points[0].x).toBeLessThan(points[1].x);
    expect(points[3].y).toBeGreaterThan(points[0].y);
  });

  it("stays inside plan space for a rect dragged against the edge", () => {
    for (const point of gridPoints({ x: 0.9, y: 0.9, width: 0.3, height: 0.3 }, 2, 2)) {
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });
});

describe("nearest", () => {
  const items = [
    { key: "a", position: { x: 0.1, y: 0.1 } },
    { key: "b", position: { x: 0.5, y: 0.5 } },
  ];

  it("finds the closest within the radius", () => {
    expect(nearest(items, { x: 0.52, y: 0.52 }, 0.05)?.key).toBe("b");
  });

  it("returns null when nothing is close, so a click on empty plan deselects", () => {
    expect(nearest(items, { x: 0.9, y: 0.9 }, 0.05)).toBeNull();
  });

  it("is exclusive of nothing at exactly the radius", () => {
    expect(nearest(items, { x: 0.15, y: 0.1 }, 0.05)?.key).toBe("a");
  });
});

describe("snap", () => {
  it("is off by default — floor plans are not on a grid", () => {
    expect(snap({ x: 0.333, y: 0.777 }, null)).toEqual({ x: 0.333, y: 0.777 });
    expect(snap({ x: 0.333, y: 0.777 }, 0)).toEqual({ x: 0.333, y: 0.777 });
  });

  it("snaps to the requested divisions when asked", () => {
    expect(snap({ x: 0.26, y: 0.74 }, 4)).toEqual({ x: 0.25, y: 0.75 });
  });
});

describe("moveAll", () => {
  const row = [
    { position: { x: 0.1, y: 0.5 } },
    { position: { x: 0.2, y: 0.5 } },
    { position: { x: 0.3, y: 0.5 } },
  ];

  it("moves everything by the delta", () => {
    const moved = moveAll(row, { x: 0.1, y: 0 });
    expect([...moved.values()].map((p) => p.x)).toEqual([0.2, 0.30000000000000004, 0.4]);
  });

  it("clamps the GROUP, so a row pushed into the wall stays a row", () => {
    // Clamping each item separately is what turns a neat row into a pile at the edge.
    const moved = moveAll(row, { x: 5, y: 0 });
    const xs = [...moved.values()].map((p) => Number(p.x.toFixed(6)));
    expect(xs).toEqual([0.8, 0.9, 1]);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 6);
  });

  it("clamps in the negative direction too", () => {
    const xs = [...moveAll(row, { x: -5, y: 0 }).values()].map((p) => Number(p.x.toFixed(6)));
    expect(xs).toEqual([0, 0.1, 0.2]);
  });

  it("is a no-op for an empty selection", () => {
    expect(moveAll([], { x: 0.5, y: 0.5 }).size).toBe(0);
  });
});

describe("closesPolygon", () => {
  const points = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
  ];

  it("closes when the cursor returns to the start", () => {
    expect(closesPolygon(points, { x: 0.11, y: 0.11 }, 0.03)).toBe(true);
  });

  it("will not close a shape that is not yet a shape", () => {
    expect(closesPolygon(points.slice(0, 2), { x: 0.1, y: 0.1 }, 0.03)).toBe(false);
  });
});

describe("polygonContains", () => {
  const square = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it("knows inside from outside", () => {
    expect(polygonContains(square, { x: 0.5, y: 0.5 })).toBe(true);
    expect(polygonContains(square, { x: 0.1, y: 0.5 })).toBe(false);
  });

  it("handles a concave shape, which is what real neighbourhoods look like", () => {
    const el = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 0.4 },
      { x: 0.4, y: 0.4 },
      { x: 0.4, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(polygonContains(el, { x: 0.2, y: 0.8 })).toBe(true);
    expect(polygonContains(el, { x: 0.8, y: 0.8 })).toBe(false);
  });
});

describe("clamp01", () => {
  it("keeps positions inside plan space", () => {
    expect([clamp01(-0.5), clamp01(0.5), clamp01(1.5)]).toEqual([0, 0.5, 1]);
  });
});
