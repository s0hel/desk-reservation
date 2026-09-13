/**
 * Editor geometry, in plan space (TDD §14.2).
 *
 * Everything here works in normalized [0,1] coordinates, never pixels. Pixels belong to
 * one rendering of one plan image at one zoom level; positions outlive all three. The
 * canvas converts at its edges and nothing else in the editor knows what a pixel is.
 *
 * Pure functions on purpose. The floor plan renderer in the mobile app taught this the
 * expensive way: an inverse transform that shipped wrong was invisible to typecheck,
 * lint and screenshots because it was inlined in a component nobody could call.
 */

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function clampPoint(point: Point): Point {
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

/** Screen pixels within the plan element -> normalized plan space. */
export function toPlan(point: Point, view: { width: number; height: number }): Point {
  return { x: point.x / (view.width || 1), y: point.y / (view.height || 1) };
}

/** Normalized plan space -> screen pixels within the plan element. */
export function toScreen(point: Point, view: { width: number; height: number }): Point {
  return { x: point.x * view.width, y: point.y * view.height };
}

/** A rectangle from two corners, in any drag direction. */
export function rectFrom(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * The centre points of an `rows` x `columns` grid inset inside `rect`.
 *
 * Inset by half a cell rather than starting at the corner: desks drawn at the very edge
 * of a marquee sit half outside the area the admin dragged, which looks like a bug even
 * though the coordinates are "correct". A single row or column centres in the rect.
 */
export function gridPoints(rect: Rect, rows: number, columns: number): Point[] {
  const points: Point[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const fx = columns === 1 ? 0.5 : (column + 0.5) / columns;
      const fy = rows === 1 ? 0.5 : (row + 0.5) / rows;
      points.push(
        clampPoint({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy }),
      );
    }
  }
  return points;
}

/** Squared distance — for "which is nearest", the square root is wasted work. */
function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * The nearest item to a point, within `radius` (normalized). Returns null when nothing
 * is close enough, so a click on empty plan clears the selection rather than grabbing
 * whatever desk happened to be least far away.
 */
export function nearest<T extends { position: Point }>(
  items: readonly T[],
  point: Point,
  radius: number,
): T | null {
  let best: T | null = null;
  let bestDistance = radius * radius;
  for (const item of items) {
    const distance = distanceSquared(item.position, point);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

/**
 * Snap to a grid of `divisions` per axis. Off by default: floor plans are not on a
 * grid, and forcing one would fight the drawing rather than help it.
 */
export function snap(point: Point, divisions: number | null): Point {
  if (!divisions || divisions <= 0) return point;
  return {
    x: clamp01(Math.round(point.x * divisions) / divisions),
    y: clamp01(Math.round(point.y * divisions) / divisions),
  };
}

/**
 * Move a set of items by a delta, clamped as a GROUP.
 *
 * Clamping each item separately collapses a selection against the edge: the ones that
 * hit the boundary stop while the rest keep going, and a neat row of desks arrives at
 * the wall as a pile. Clamping the delta keeps the shape.
 */
export function moveAll<T extends { position: Point }>(
  items: readonly T[],
  delta: Point,
): Map<T, Point> {
  const moved = new Map<T, Point>();
  if (items.length === 0) return moved;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.position.x);
    minY = Math.min(minY, item.position.y);
    maxX = Math.max(maxX, item.position.x);
    maxY = Math.max(maxY, item.position.y);
  }
  const dx = Math.min(1 - maxX, Math.max(-minX, delta.x));
  const dy = Math.min(1 - maxY, Math.max(-minY, delta.y));

  for (const item of items) {
    moved.set(item, { x: clamp01(item.position.x + dx), y: clamp01(item.position.y + dy) });
  }
  return moved;
}

/** Is the polygon being drawn close enough to its start point to close? */
export function closesPolygon(points: readonly Point[], candidate: Point, radius: number): boolean {
  return points.length >= 3 && distanceSquared(points[0], candidate) <= radius * radius;
}

/** Even-odd ray casting. Used to show which zone a desk falls in. */
export function polygonContains(polygon: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const straddles = a.y > point.y !== b.y > point.y;
    if (straddles && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
