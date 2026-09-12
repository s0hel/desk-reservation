/**
 * Floor plan geometry (TDD §13.3).
 *
 * Extracted from the component on purpose. The inverse transform below shipped wrong
 * once: the gesture detector was attached to the *transformed* view, so coordinates
 * arrived already in local space and this correction was applied twice. At scale 1 a
 * double correction is the identity, so tap-to-book looked perfect and silently missed
 * every desk after the first pinch — invisible to typecheck, lint and screenshots.
 *
 * Pure functions with no React and no native dependencies, so the maths can be tested
 * directly at the scales where it actually breaks.
 */

export type PlanPoint = { x: number; y: number };

export type Placed = {
  id: string;
  code: string;
  position?: { x?: number; y?: number } | null;
};

export type Viewport = {
  /** Pan offsets in viewport pixels. */
  tx: number;
  ty: number;
  scale: number;
  width: number;
  height: number;
};

/** Buckets are roughly three desk widths, so a tap inspects a handful of nodes. */
export const GRID = 12;
export const NODE_RADIUS = 0.011;
/** Fingers are imprecise; allow slop beyond the drawn node. */
export const TOUCH_SLOP = 1.8;

/**
 * "4F-A-01" -> "A-01". Dropping only the floor prefix keeps labels unique; taking just
 * the trailing number made all five rows read 01..12.
 */
export function shortLabel(code: string): string {
  const parts = code.split("-");
  return parts.length > 2 ? parts.slice(1).join("-") : code;
}

/**
 * Convert a touch in the *untransformed* viewport into normalized plan space.
 *
 * React Native applies transforms about the view's centre, so the inverse is
 * centre + (point - centre - translation) / scale, then normalized by plan size.
 */
export function viewportToPlan(point: PlanPoint, v: Viewport): PlanPoint {
  const cx = v.width / 2;
  const cy = v.height / 2;
  const px = (point.x - v.tx - cx) / v.scale + cx;
  const py = (point.y - v.ty - cy) / v.scale + cy;
  return { x: px / v.width, y: py / v.height };
}

export type PlanIndex<T extends Placed> = Map<string, T[]>;

/** Uniform spatial grid over plan space, built once per resource set. */
export function buildIndex<T extends Placed>(items: T[]): PlanIndex<T> {
  const cells: PlanIndex<T> = new Map();
  for (const item of items) {
    const x = item.position?.x ?? 0;
    const y = item.position?.y ?? 0;
    const key = `${Math.floor(x * GRID)}:${Math.floor(y * GRID)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(item);
    else cells.set(key, [item]);
  }
  return cells;
}

/**
 * Nearest item to a plan-space point, within the touch radius. Neighbouring buckets are
 * searched too: a node near a cell edge belongs to one cell but its touch target spills
 * into the next.
 */
export function findNearest<T extends Placed>(
  index: PlanIndex<T>,
  point: PlanPoint,
  radius = NODE_RADIUS * TOUCH_SLOP,
): T | null {
  const cx = Math.floor(point.x * GRID);
  const cy = Math.floor(point.y * GRID);
  let best: T | null = null;
  let bestDist = Infinity;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const item of index.get(`${gx}:${gy}`) ?? []) {
        const dx = (item.position?.x ?? 0) - point.x;
        const dy = (item.position?.y ?? 0) - point.y;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          best = item;
        }
      }
    }
  }
  return best !== null && bestDist <= radius ? best : null;
}
