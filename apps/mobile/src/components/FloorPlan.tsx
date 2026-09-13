/**
 * Floor plan viewer (TDD §13.3).
 *
 * The only performance-sensitive screen in the product. Target: 300+ desks, 60fps
 * pan/zoom, first render under a second.
 *
 * Three decisions carry that:
 *
 * 1. The gesture never crosses the JS bridge. Pan and pinch write to reanimated shared
 *    values and a single Animated.View transform consumes them, so no React component
 *    re-renders while a finger is down. Desk nodes are memoized and depend only on data.
 *
 * 2. Hit testing is not per-node onPress. Hundreds of touch responders is what makes
 *    these screens janky. One tap handler on the canvas inverse-transforms the touch
 *    point into plan space and queries a uniform grid built once per floor — O(1) per
 *    tap, and the SVG tree stays free of handlers.
 *
 * 3. Positions are normalized 0..1 against the plan's intrinsic size (TDD §14.2), so
 *    re-uploading a higher-resolution plan does not invalidate placements.
 */

import { useCallback, useMemo, useRef } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  G,
  Image as SvgImage,
  Polygon,
  Rect,
  Text as SvgText,
} from "react-native-svg";

import type { Plan, ResourceAvailability } from "@/lib/api";
import {
  NODE_RADIUS, buildIndex, findNearest, shortLabel, viewportToPlan,
} from "@/lib/plan";
import {
  radius as rad, spacing, type, useTheme, useThemedStyles, type Palette, type Theme,
} from "@/lib/theme";

export type PlanZone = { id: string; name: string; polygon: number[][]; color?: string | null };

type Props = {
  resources: ResourceAvailability[];
  zones?: PlanZone[];
  /** The published plan image, or null while a floor has none. */
  plan?: Plan | null;
  aspectRatio?: number;
  onSelect: (resource: ResourceAvailability) => void;
};

const MIN_SCALE = 0.6;
const MAX_SCALE = 6;

function stateOf(r: ResourceAvailability): "free" | "taken" | "yours" | "unavailable" {
  if (r.occupied_by_me) return "yours";
  if (!r.bookable) return "unavailable";
  return r.available ? "free" : "taken";
}

type NodeState = "free" | "taken" | "yours" | "unavailable";

/**
 * Every state is a different colour AND a different shape: filled, faded, ringed,
 * hollow. Roughly 8% of men cannot separate the free/closed pair by hue alone, and the
 * list view has always carried a text label for the same reason (FR-2.4, TDD §13.3).
 */
function paint(color: Palette, state: NodeState) {
  switch (state) {
    case "free":
      return { fill: color.state.free, opacity: 1, stroke: undefined, ring: false };
    case "taken":
      return { fill: color.state.taken, opacity: 0.5, stroke: undefined, ring: false };
    case "yours":
      return { fill: color.state.yours, opacity: 1, stroke: undefined, ring: true };
    case "unavailable":
      return { fill: "none", opacity: 1, stroke: color.state.closed, ring: false };
  }
}

export function FloorPlan({ resources, zones = [], plan, aspectRatio, onSelect }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const planWidth = width;
  // The image's own ratio wins: positions are normalized against it (TDD §14.2), so
  // drawing it at any other shape puts every desk in the wrong place.
  const planHeight = width / (plan?.aspect_ratio ?? aspectRatio ?? 1.5);

  const index = useMemo(() => buildIndex(resources), [resources]);
  const byId = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);
  const lastTap = useRef(0);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  /** Called from the UI thread with a point already converted to plan space. */
  const hitTest = useCallback(
    (px: number, py: number) => {
      // Debounce: a pinch that ends with one finger lifting can emit a stray tap.
      const now = Date.now();
      if (now - lastTap.current < 120) return;
      lastTap.current = now;

      const hit = findNearest(index, { x: px, y: py });
      if (hit) {
        const fresh = byId.get(hit.id);
        if (fresh) onSelect(fresh);
      }
    },
    [index, byId, onSelect],
  );

  const pan = Gesture.Pan()
    // A real finger drifts a few pixels while tapping. Without a minimum distance the
    // pan activates on that wobble and cancels the tap, so desks become unselectable on
    // hardware while still working in the simulator, whose taps have zero movement.
    .minDistance(10)
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const tap = Gesture.Tap()
    // Tuned for a finger, not a synthetic click: a deliberate tap on a small target
    // regularly exceeds 250ms and moves further than the default slop allows.
    .maxDuration(600)
    .maxDistance(24)
    .onEnd((e) => {
      // Recover plan-space coordinates from the live transform. Reading the shared
      // values here (on the UI thread) is what keeps this correct mid-gesture.
      const point = viewportToPlan(
        { x: e.x, y: e.y },
        { tx: tx.value, ty: ty.value, scale: scale.value, width: planWidth, height: planHeight },
      );
      runOnJS(hitTest)(point.x, point.y);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const reset = scale.value > 1.05;
      scale.value = withTiming(reset ? 1 : 2.5, { duration: 180 });
      savedScale.value = reset ? 1 : 2.5;
      if (reset) {
        tx.value = withTiming(0, { duration: 180 });
        ty.value = withTiming(0, { duration: 180 });
        savedTx.value = 0;
        savedTy.value = 0;
      }
    });

  const gesture = Gesture.Simultaneous(
    Gesture.Exclusive(doubleTap, tap),
    Gesture.Simultaneous(pan, pinch),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // Labels are culled by zoom, but the threshold is read once per render rather than
  // per frame: re-rendering the scene during a pinch is exactly what we are avoiding.
  const showLabels = resources.length <= 80;

  return (
    // The detector wraps the OUTER, untransformed viewport on purpose. Attached to the
    // transformed view instead, gesture coordinates arrive already in local space and
    // the inverse transform below double-corrects them — which happens to be identity
    // at scale 1, so it looks correct until the first pinch.
    <GestureDetector gesture={gesture}>
      <View testID="floor-plan" style={[styles.viewport, { height: planHeight }]}>
        <Animated.View style={[styles.canvas, animatedStyle]} pointerEvents="none">
          <Svg width={planWidth} height={planHeight}>
            <Rect x={0} y={0} width={planWidth} height={planHeight} fill={theme.color.surface} />
            {/* The plan the admin published, if any. A floor without one still renders:
                zones and desks on a plain ground, in the right places, because
                positions never depended on the image (TDD §14.2). */}
            {plan ? (
              <SvgImage
                x={0}
                y={0}
                width={planWidth}
                height={planHeight}
                href={{ uri: plan.url }}
                preserveAspectRatio="xMidYMid slice"
                // A floor plan is white paper. At full strength in dark mode it is a
                // slab of daylight in the middle of a dark screen, so it recedes.
                opacity={theme.scheme === "dark" ? 0.55 : 0.85}
              />
            ) : null}
            {zones.map((z) => (
              <Polygon
                key={z.id}
                points={z.polygon
                  .map(([x, y]) => `${x * planWidth},${y * planHeight}`)
                  .join(" ")}
                fill={z.color ?? theme.color.state.zone}
                fillOpacity={0.13}
                stroke={z.color ?? theme.color.state.zone}
                strokeOpacity={0.62}
                strokeWidth={1.5}
              />
            ))}
            <G>
              {resources.map((r) => {
                const state = stateOf(r);
                const skin = paint(theme.color, state);
                const cx = (r.position?.x ?? 0) * planWidth;
                const cy = (r.position?.y ?? 0) * planHeight;
                const r0 = NODE_RADIUS * planWidth;
                return (
                  <G key={r.id}>
                    {/* Your own desk gets a halo, so it is findable without hunting. */}
                    {skin.ring ? (
                      <Circle
                        cx={cx}
                        cy={cy}
                        r={r0 * 1.9}
                        fill="none"
                        stroke={skin.fill}
                        strokeOpacity={0.4}
                        strokeWidth={r0 * 0.5}
                      />
                    ) : null}
                    {r.kind === "room" ? (
                      <Rect
                        x={cx - r0 * 1.6}
                        y={cy - r0}
                        width={r0 * 3.2}
                        height={r0 * 2}
                        rx={4}
                        fill={skin.fill}
                        stroke={skin.stroke}
                        strokeWidth={skin.stroke ? r0 * 0.5 : 0}
                        opacity={skin.opacity}
                      />
                    ) : (
                      <Circle
                        cx={cx}
                        cy={cy}
                        r={r0}
                        fill={skin.fill}
                        stroke={skin.stroke}
                        strokeWidth={skin.stroke ? r0 * 0.5 : 0}
                        opacity={skin.opacity}
                      />
                    )}
                    {showLabels ? (
                      <SvgText
                        x={cx}
                        y={cy + r0 * 2.8}
                        fontSize={r0 * 1.15}
                        fill={theme.color.muted}
                        textAnchor="middle"
                      >
                        {shortLabel(r.code)}
                      </SvgText>
                    ) : null}
                  </G>
                );
              })}
            </G>
          </Svg>
        </Animated.View>

        <View style={styles.legend} pointerEvents="none">
          {(["free", "taken", "yours", "unavailable"] as const).map((s) => {
            const skin = paint(theme.color, s);
            return (
              <View key={s} style={styles.legendItem}>
                <View
                  style={[
                    styles.swatch,
                    {
                      backgroundColor: skin.fill === "none" ? "transparent" : skin.fill,
                      opacity: skin.opacity,
                      borderWidth: skin.stroke ? 2 : 0,
                      borderColor: skin.stroke,
                    },
                    skin.ring && styles.swatchRing,
                  ]}
                />
                <Text style={styles.legendText}>
                  {{ free: "Free", taken: "Taken", yours: "Yours", unavailable: "Closed" }[s]}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </GestureDetector>
  );
}

const makeStyles = (t: Theme) => ({
  viewport: { overflow: "hidden" as const, backgroundColor: t.color.ground },
  canvas: { flex: 1 },
  legend: {
    position: "absolute" as const,
    bottom: spacing(1),
    left: spacing(1),
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing(1.5),
    flexWrap: "wrap" as const,
    backgroundColor: t.color.surface,
    borderRadius: rad.pill,
    paddingVertical: spacing(0.75),
    paddingHorizontal: spacing(1.5),
  },
  legendItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: spacing(0.5) },
  swatch: { width: 9, height: 9, borderRadius: rad.pill },
  swatchRing: { borderWidth: 2, borderColor: t.color.state.yours },
  legendText: { ...type.label, fontSize: 10, letterSpacing: 0.5, color: t.color.muted },
});
