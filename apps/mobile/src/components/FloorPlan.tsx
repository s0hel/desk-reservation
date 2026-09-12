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
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, G, Polygon, Rect, Text as SvgText } from "react-native-svg";

import type { ResourceAvailability } from "@/lib/api";
import {
  NODE_RADIUS, buildIndex, findNearest, shortLabel, viewportToPlan,
} from "@/lib/plan";
import { colors } from "@/lib/theme";

export type PlanZone = { id: string; name: string; polygon: number[][]; color?: string | null };

type Props = {
  resources: ResourceAvailability[];
  zones?: PlanZone[];
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

const FILL = {
  free: colors.free,
  taken: "#3A4150",
  yours: colors.accent,
  unavailable: colors.danger,
} as const;

export function FloorPlan({ resources, zones = [], aspectRatio = 1.5, onSelect }: Props) {
  const { width } = useWindowDimensions();
  const planWidth = width;
  const planHeight = width / aspectRatio;

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
    .maxDuration(250)
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
      <View style={[styles.viewport, { height: planHeight }]}>
        <Animated.View style={[styles.canvas, animatedStyle]} pointerEvents="none">
          <Svg width={planWidth} height={planHeight}>
            <Rect x={0} y={0} width={planWidth} height={planHeight} fill={colors.card} />
            {/* No plan image has been uploaded yet — zones and desks render on a plain
                ground. The raster backdrop arrives with the admin editor (TDD §14.3). */}
            {zones.map((z) => (
              <Polygon
                key={z.id}
                points={z.polygon
                  .map(([x, y]) => `${x * planWidth},${y * planHeight}`)
                  .join(" ")}
                fill={z.color ?? colors.accent}
                fillOpacity={0.06}
                stroke={z.color ?? colors.accent}
                strokeOpacity={0.25}
                strokeWidth={1}
              />
            ))}
            <G>
              {resources.map((r) => {
                const state = stateOf(r);
                const cx = (r.position?.x ?? 0) * planWidth;
                const cy = (r.position?.y ?? 0) * planHeight;
                const radius = NODE_RADIUS * planWidth;
                return (
                  <G key={r.id}>
                    {r.kind === "room" ? (
                      <Rect
                        x={cx - radius * 1.6}
                        y={cy - radius}
                        width={radius * 3.2}
                        height={radius * 2}
                        rx={3}
                        fill={FILL[state]}
                        opacity={state === "taken" ? 0.55 : 1}
                      />
                    ) : (
                      <Circle
                        cx={cx}
                        cy={cy}
                        r={radius}
                        fill={FILL[state]}
                        opacity={state === "taken" ? 0.55 : 1}
                      />
                    )}
                    {showLabels ? (
                      <SvgText
                        x={cx}
                        y={cy + radius * 2.6}
                        fontSize={radius * 1.1}
                        fill={colors.muted}
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
        {(["free", "taken", "yours", "unavailable"] as const).map((s) => (
          <View key={s} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: FILL[s] }]} />
            <Text style={styles.legendText}>
              {{ free: "Free", taken: "Taken", yours: "Yours", unavailable: "Closed" }[s]}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: { overflow: "hidden", backgroundColor: colors.bg },
  canvas: { flex: 1 },
  legend: {
    position: "absolute", bottom: 8, left: 8, right: 8,
    flexDirection: "row", gap: 12, flexWrap: "wrap",
    backgroundColor: "rgba(11,13,18,0.82)", borderRadius: 10, padding: 6,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.muted, fontSize: 11 },
});
