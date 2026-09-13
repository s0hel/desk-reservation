"use client";

/**
 * The plan surface: the image, the zones, the desks, and every pointer gesture.
 *
 * Zoom is implemented by sizing the canvas element and letting the browser scroll it,
 * NOT by a CSS transform. That is a deliberate choice: a transformed surface needs an
 * inverse transform to turn a click back into plan coordinates, and that inverse is
 * exactly what shipped wrong in the mobile viewer — it was applied twice, which is the
 * identity at zoom 1, so it looked perfect until the first zoom. With a sized element,
 * `clientX - rect.left` is already in element space at every zoom level and there is no
 * inverse to get wrong.
 *
 * Hit testing happens in PIXELS, not normalized units. Plan space is normalized per
 * axis, so a circle of radius r is an ellipse in normalized space whenever the plan is
 * not square, and a normalized radius would make desks harder to hit vertically on a
 * wide plan.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  clampPoint,
  nearest,
  polygonContains,
  rectFrom,
  snap,
  toPlan,
  toScreen,
  type Point,
  type Rect,
} from "@/lib/geometry";
import { shortLabel } from "@/lib/naming";
import type { Layout, LayoutResource, LayoutZone, Plan } from "@/lib/types";

export type Tool = "select" | "place" | "bulk" | "zone";

const HIT_RADIUS_PX = 14;
const NODE_RADIUS_PX = 7;
/** Below this the pointer is still a click, not a drag. Fingers and trackpads wobble. */
const DRAG_THRESHOLD_PX = 4;

type Props = {
  layout: Layout;
  plan: Plan | null;
  aspectRatio: number;
  tool: Tool;
  zoom: number;
  selection: string[];
  activeZone: string | null;
  snapDivisions: number | null;
  onSelect: (keys: string[], mode: "replace" | "add" | "toggle") => void;
  onSelectInRect: (rect: Rect, mode: "replace" | "add") => void;
  onPlace: (point: Point) => void;
  onMove: (delta: Point) => void;
  onBulkRect: (rect: Rect) => void;
  onZoneDrawn: (polygon: [number, number][]) => void;
  onActivateZone: (key: string | null) => void;
};

type DragState =
  | { kind: "none" }
  | { kind: "pending"; origin: Point; originPx: Point; hitKey: string | null; additive: boolean }
  | { kind: "marquee"; origin: Point; current: Point; additive: boolean }
  | { kind: "move"; originPx: Point; lastDelta: Point }
  | { kind: "rect"; origin: Point; current: Point };

const ZONE_FALLBACK_COLOR = "#4f7df3";

export function Canvas({
  layout,
  plan,
  aspectRatio,
  tool,
  zoom,
  selection,
  activeZone,
  snapDivisions,
  onSelect,
  onSelectInRect,
  onPlace,
  onMove,
  onBulkRect,
  onZoneDrawn,
  onActivateZone,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<DragState>({ kind: "none" });
  const [zonePoints, setZonePoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);

  // The surface's own size is the single source of truth for the pixel<->plan mapping,
  // measured rather than computed so a scrollbar or a rounded layout cannot desync it.
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selected = new Set(selection);

  const pointerPx = useCallback((event: React.PointerEvent | PointerEvent): Point => {
    const element = surfaceRef.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    // getBoundingClientRect is the BORDER box; ResizeObserver's contentRect (the `size`
    // everything is drawn against) is the CONTENT box. Subtracting clientLeft/clientTop
    // — the border widths — is what puts both in the same coordinate space. Skipping it
    // leaves every click off by the border width, which is small enough to look like
    // imprecise aim rather than a bug, and biased in one direction forever.
    return {
      x: event.clientX - rect.left - element.clientLeft,
      y: event.clientY - rect.top - element.clientTop,
    };
  }, []);

  const hitTest = useCallback(
    (px: Point): LayoutResource | null => {
      const candidates = layout.resources.map((resource) => ({
        resource,
        position: toScreen(resource.position, size),
      }));
      return nearest(candidates, px, HIT_RADIUS_PX)?.resource ?? null;
    },
    [layout.resources, size],
  );

  // ------------------------------------------------------------------ zone drawing

  const finishZone = useCallback(() => {
    if (zonePoints.length >= 3) {
      onZoneDrawn(zonePoints.map((p) => [p.x, p.y] as [number, number]));
    }
    setZonePoints([]);
  }, [zonePoints, onZoneDrawn]);

  useEffect(() => {
    if (tool !== "zone") setZonePoints([]);
  }, [tool]);

  useEffect(() => {
    if (tool !== "zone") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") finishZone();
      if (event.key === "Escape") setZonePoints([]);
      if (event.key === "Backspace" && zonePoints.length) {
        event.preventDefault();
        setZonePoints((points) => points.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, finishZone, zonePoints.length]);

  // ---------------------------------------------------------------- pointer events

  function onPointerDown(event: React.PointerEvent) {
    // Ignore anything but the primary button: a right-click is a context menu, and a
    // middle-drag is the browser's own pan.
    if (event.button !== 0) return;
    const px = pointerPx(event);
    const point = toPlan(px, size);

    if (tool === "zone") {
      const snapped = snap(clampPoint(point), snapDivisions);
      // Clicking the first point again closes the shape — the convention every drawing
      // tool uses, and the only discoverable one without a visible "close" affordance.
      if (zonePoints.length >= 3) {
        const startPx = toScreen(zonePoints[0], size);
        if (Math.hypot(startPx.x - px.x, startPx.y - px.y) <= HIT_RADIUS_PX) {
          finishZone();
          return;
        }
      }
      setZonePoints((points) => [...points, snapped]);
      return;
    }

    if (tool === "place") {
      onPlace(snap(clampPoint(point), snapDivisions));
      return;
    }

    if (tool === "bulk") {
      (event.target as Element).setPointerCapture(event.pointerId);
      setDrag({ kind: "rect", origin: point, current: point });
      return;
    }

    const hit = hitTest(px);
    (event.target as Element).setPointerCapture(event.pointerId);
    setDrag({
      kind: "pending",
      origin: point,
      originPx: px,
      hitKey: hit?.key ?? null,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
    });
  }

  function onPointerMove(event: React.PointerEvent) {
    const px = pointerPx(event);
    const point = toPlan(px, size);
    setCursor(point);

    if (drag.kind === "pending") {
      const travelled = Math.hypot(px.x - drag.originPx.x, px.y - drag.originPx.y);
      if (travelled < DRAG_THRESHOLD_PX) return;

      if (drag.hitKey) {
        // Dragging an unselected desk selects it first, so grabbing a desk and moving
        // it is one gesture rather than click-then-drag.
        if (!selected.has(drag.hitKey)) {
          onSelect([drag.hitKey], drag.additive ? "add" : "replace");
        }
        setDrag({ kind: "move", originPx: drag.originPx, lastDelta: { x: 0, y: 0 } });
      } else {
        setDrag({
          kind: "marquee",
          origin: drag.origin,
          current: point,
          additive: drag.additive,
        });
      }
      return;
    }

    if (drag.kind === "marquee") {
      setDrag({ ...drag, current: point });
      return;
    }

    if (drag.kind === "rect") {
      setDrag({ ...drag, current: point });
      return;
    }

    if (drag.kind === "move") {
      const total = {
        x: (px.x - drag.originPx.x) / (size.width || 1),
        y: (px.y - drag.originPx.y) / (size.height || 1),
      };
      // Each move dispatches only the delta SINCE THE LAST ONE. Dispatching the total
      // would move the selection by the whole distance again on every pointer event.
      onMove({ x: total.x - drag.lastDelta.x, y: total.y - drag.lastDelta.y });
      setDrag({ ...drag, lastDelta: total });
    }
  }

  function onPointerUp(event: React.PointerEvent) {
    const px = pointerPx(event);

    if (drag.kind === "pending") {
      // Never travelled far enough to be a drag: it was a click.
      const hit = drag.hitKey;
      if (hit) onSelect([hit], drag.additive ? "toggle" : "replace");
      else if (tool === "select") {
        const zone = zoneAt(layout.zones, toPlan(px, size));
        onActivateZone(zone?.key ?? null);
        if (!drag.additive) onSelect([], "replace");
      }
    } else if (drag.kind === "marquee") {
      onSelectInRect(rectFrom(drag.origin, drag.current), drag.additive ? "add" : "replace");
    } else if (drag.kind === "rect") {
      const rect = rectFrom(drag.origin, drag.current);
      // A stray click with the bulk tool is not a zero-sized grid request.
      if (rect.width * size.width > 12 && rect.height * size.height > 12) onBulkRect(rect);
    }
    setDrag({ kind: "none" });
  }

  // ----------------------------------------------------------------------- render

  const marquee =
    drag.kind === "marquee" || drag.kind === "rect"
      ? rectFrom(drag.origin, drag.current)
      : null;

  const width = size.width;
  const height = size.height;
  const cursorLabel =
    tool === "place" ? "copy" : tool === "bulk" || tool === "zone" ? "crosshair" : "default";

  return (
    <div
      ref={wrapperRef}
      style={{
        flex: 1,
        overflow: "auto",
        background: "var(--bg)",
        padding: 16,
        minWidth: 0,
      }}
    >
      <div
        ref={surfaceRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        style={{
          position: "relative",
          width: `${100 * zoom}%`,
          aspectRatio: String(aspectRatio),
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          touchAction: "none",
          cursor: cursorLabel,
          userSelect: "none",
        }}
      >
        {plan ? (
          // eslint-disable-next-line @next/next/no-img-element -- the URL is signed and
          // short-lived (TDD §11), so next/image's optimizer would cache a dead link.
          <img
            src={plan.url}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              pointerEvents: "none",
            }}
          />
        ) : null}

        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${width || 1} ${height || 1}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {layout.zones.map((zone) => (
            <polygon
              key={zone.key}
              points={zone.polygon
                .map(([x, y]) => `${x * width},${y * height}`)
                .join(" ")}
              fill={zone.color ?? ZONE_FALLBACK_COLOR}
              fillOpacity={zone.key === activeZone ? 0.18 : 0.08}
              stroke={zone.color ?? ZONE_FALLBACK_COLOR}
              strokeOpacity={zone.key === activeZone ? 0.9 : 0.4}
              strokeWidth={zone.key === activeZone ? 2 : 1}
            />
          ))}

          {layout.resources.map((resource) => {
            const centre = toScreen(resource.position, size);
            const isSelected = selected.has(resource.key);
            const fill = !resource.bookable
              ? "var(--danger)"
              : resource.kind === "room"
                ? "var(--accent)"
                : "var(--free)";
            return (
              <g key={resource.key}>
                {resource.kind === "room" ? (
                  <rect
                    x={centre.x - NODE_RADIUS_PX * 1.7}
                    y={centre.y - NODE_RADIUS_PX}
                    width={NODE_RADIUS_PX * 3.4}
                    height={NODE_RADIUS_PX * 2}
                    rx={3}
                    fill={fill}
                    stroke={isSelected ? "#fff" : "none"}
                    strokeWidth={2}
                  />
                ) : (
                  <circle
                    cx={centre.x}
                    cy={centre.y}
                    r={NODE_RADIUS_PX}
                    fill={fill}
                    stroke={isSelected ? "#fff" : "none"}
                    strokeWidth={2}
                  />
                )}
                {/* Labels are culled by count, not by zoom: past a few hundred desks
                    the text is unreadable anyway and the DOM cost is real. */}
                {layout.resources.length <= 150 ? (
                  <text
                    x={centre.x}
                    y={centre.y + NODE_RADIUS_PX * 2.6}
                    fontSize={10}
                    textAnchor="middle"
                    fill="var(--muted)"
                  >
                    {shortLabel(resource.code)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {zonePoints.length ? (
            <>
              <polyline
                points={[...zonePoints, cursor ?? zonePoints[zonePoints.length - 1]]
                  .map((p) => `${p.x * width},${p.y * height}`)
                  .join(" ")}
                fill="none"
                stroke="var(--warn)"
                strokeWidth={2}
                strokeDasharray="4 3"
              />
              {zonePoints.map((point, index) => (
                <circle
                  key={index}
                  cx={point.x * width}
                  cy={point.y * height}
                  r={index === 0 ? 6 : 3}
                  fill="var(--warn)"
                />
              ))}
            </>
          ) : null}

          {marquee ? (
            <rect
              x={marquee.x * width}
              y={marquee.y * height}
              width={marquee.width * width}
              height={marquee.height * height}
              fill="var(--accent)"
              fillOpacity={0.12}
              stroke="var(--accent)"
              strokeDasharray="4 3"
            />
          ) : null}
        </svg>
      </div>
    </div>
  );
}

/** The topmost zone containing a point, so clicking inside one selects it. */
function zoneAt(zones: LayoutZone[], point: Point): LayoutZone | null {
  // Last first: zones are drawn in order, so the last one drawn is the one on top and
  // therefore the one the admin thinks they clicked.
  for (let i = zones.length - 1; i >= 0; i--) {
    const polygon = zones[i].polygon.map(([x, y]) => ({ x, y }));
    if (polygonContains(polygon, point)) return zones[i];
  }
  return null;
}
