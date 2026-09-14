/**
 * Daylight — the design system for the mobile app.
 *
 * Two things this file is deliberately strict about.
 *
 * **Light is the default and dark is a real second theme.** Phase 1 shipped a single
 * dark palette because that was the default when the file was written, not because
 * anyone chose it. An office app is used in daylight, beside a window, over a floor
 * plan that is itself white paper. The dark palette here is re-solved rather than
 * inverted: `accent` is lifted on dark so a filled button still clears 4.5:1 against
 * white, and `accentText` is a separate, much lighter value because the fill colour
 * is unreadable as text on a dark ground.
 *
 * **State colour is not accent colour.** Previously `accent` meant both "this control
 * is selected" and "this desk is yours", so on the plan a selected filter and your own
 * booking were the same blue. `state.*` is a closed set with its own hues, and every
 * state also carries a distinct *shape* at the call site (filled dot, faded dot, ring,
 * hollow ring) because roughly 8% of men cannot separate the free/closed pair by hue.
 * Colour alone never carries meaning — see the `accessibilityLabel` on every node.
 */

import { useMemo } from "react";
import {
  StyleSheet, useColorScheme, type TextStyle, type ViewStyle,
} from "react-native";

export type Scheme = "light" | "dark";

export type Palette = {
  /** The page itself. Never white — white is reserved for cards that sit on it. */
  ground: string;
  surface: string;
  /** Insets, pressed states, and anything that should read as below the surface. */
  surfaceAlt: string;
  ink: string;
  inkSoft: string;
  muted: string;
  line: string;
  /** Fills: button backgrounds, selected pills. */
  accent: string;
  /** The same idea as text or an icon on `ground`. Not interchangeable with `accent`. */
  accentText: string;
  accentSoft: string;
  onAccent: string;
  /** Anything time-boxed: check-in windows, auto-release warnings, a lapsing hold. */
  clay: string;
  claySoft: string;
  danger: string;
  state: {
    free: string;
    taken: string;
    yours: string;
    closed: string;
    zone: string;
  };
};

const light: Palette = {
  ground: "#F5F4F0",
  surface: "#FFFFFF",
  surfaceAlt: "#EFEDE7",
  ink: "#16181C",
  inkSoft: "#3E4247",
  muted: "#70747B",
  line: "#E7E4DD",
  accent: "#4340C4",
  accentText: "#4340C4",
  accentSoft: "#ECEBFA",
  onAccent: "#FFFFFF",
  clay: "#C4622F",
  claySoft: "#FBEDE6",
  danger: "#B8433A",
  state: {
    free: "#1E8F63",
    taken: "#A9ADB4",
    yours: "#4340C4",
    closed: "#B8433A",
    zone: "#7C6AE8",
  },
};

const dark: Palette = {
  ground: "#17181B",
  surface: "#202226",
  surfaceAlt: "#282B30",
  ink: "#F0EFEB",
  inkSoft: "#C9C8C3",
  muted: "#8E9298",
  line: "#2E3137",
  accent: "#5B57DA",
  accentText: "#A6A2FF",
  accentSoft: "#26254E",
  onAccent: "#FFFFFF",
  clay: "#E08A54",
  claySoft: "#3A2419",
  danger: "#F0776A",
  state: {
    free: "#45C08D",
    taken: "#6B7079",
    yours: "#8C88F5",
    closed: "#F0776A",
    zone: "#9B8CF0",
  },
};

export const palettes: Record<Scheme, Palette> = { light, dark };

export const spacing = (n: number) => n * 8;

export const radius = { s: 10, m: 14, l: 20, pill: 999 } as const;

/**
 * One family, four weights, a fixed scale. `letterSpacing` is in points here, not em —
 * the values are the em figures from the spec multiplied out at each size.
 */
export type TypeName =
  | "display" | "title" | "heading" | "body" | "sub" | "label" | "code";

export const type: Record<TypeName, TextStyle> = {
  display: { fontSize: 34, lineHeight: 38, fontWeight: "800", letterSpacing: -1 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.45 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "700", letterSpacing: -0.25 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400", letterSpacing: -0.15 },
  sub: { fontSize: 14, lineHeight: 20, fontWeight: "400", letterSpacing: -0.1 },
  label: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    letterSpacing: 1.3,
    textTransform: "uppercase",
  },
  /**
   * Desk and room codes. Tabular figures so `4F-B-03` and `4F-C-06` align digit for
   * digit down a list. Deliberately NOT a monospace family: Menlo's hyphen reads as
   * an en dash beside the system face and iOS has to synthesise its semibold, and
   * alignment — not the typewriter look — was the whole point.
   */
  code: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
    letterSpacing: 0.2,
    fontVariant: ["tabular-nums"],
  },
};

/**
 * A type role at a different size, with its line box scaled to match.
 *
 * Spreading a role and overriding `fontSize` alone keeps the role's `lineHeight`, so a
 * 26pt code sat in a 20pt line box and was clipped top and bottom. This exists so that
 * cannot happen: the ratio comes from the role itself.
 */
export function at(style: TextStyle, fontSize: number): TextStyle {
  const base = style.fontSize ?? fontSize;
  const ratio = (style.lineHeight ?? base) / base;
  return { ...style, fontSize, lineHeight: Math.round(fontSize * ratio) };
}

export type Theme = {
  scheme: Scheme;
  color: Palette;
  /**
   * Elevation is a shadow on light and a lighter surface plus a hairline on dark,
   * because a drop shadow against a dark ground reads as smudge rather than lift.
   */
  card: ViewStyle;
};

function themeFor(scheme: Scheme): Theme {
  const color = palettes[scheme];
  return {
    scheme,
    color,
    card:
      scheme === "light"
        ? {
            backgroundColor: color.surface,
            shadowColor: "#101218",
            shadowOpacity: 0.07,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 6 },
            elevation: 2,
          }
        : {
            backgroundColor: color.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: color.line,
          },
  };
}

const themes: Record<Scheme, Theme> = { light: themeFor("light"), dark: themeFor("dark") };

export function useTheme(): Theme {
  // `useColorScheme` returns null before the native module reports in; light is the
  // default, so that transient null resolves to the right thing rather than flashing.
  return themes[useColorScheme() === "dark" ? "dark" : "light"];
}

/**
 * Styles that depend on the palette. The factory must live at module scope so its
 * identity is stable and the sheet is rebuilt only when the scheme actually changes.
 */
export function useThemedStyles<T extends Record<string, object>>(
  factory: (theme: Theme) => T,
): { [K in keyof T]: ViewStyle & TextStyle } {
  const theme = useTheme();
  return useMemo(
    // The cast is the one place this indirection costs anything: `NamedStyles`
    // cannot infer through a factory that spreads both a ViewStyle and a TextStyle.
    () => StyleSheet.create(factory(theme) as StyleSheet.NamedStyles<T>),
    [theme, factory],
  ) as { [K in keyof T]: ViewStyle & TextStyle };
}
