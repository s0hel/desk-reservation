/**
 * The icon set.
 *
 * Hand-drawn on react-native-svg, which is already a dependency for the floor plan,
 * rather than adding an icon font. Six icons do not justify a package, and a shared
 * stroke weight and cap style is what makes a set look like a set — that is exactly
 * what is lost when icons come from a library someone else tuned.
 *
 * All glyphs are drawn on a 24×24 grid, stroked (never filled), so a single `color`
 * follows the palette and `size` scales without reflowing anything.
 */

import type { ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

export type IconName =
  | "today"
  | "plan"
  | "team"
  | "person"
  | "chevronRight"
  | "arrowRight"
  | "check"
  | "clock"
  | "alert"
  | "signOut";

type Props = { name: IconName; size?: number; color: ColorValue; strokeWidth?: number };

export function Icon({ name, size = 22, color, strokeWidth = 1.9 }: Props) {
  const stroke = { stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {name === "today" ? (
        <>
          <Path d="M3.2 10.6 12 3.4l8.8 7.2" {...stroke} />
          <Path d="M5.6 9.6V20.4h12.8V9.6" {...stroke} />
        </>
      ) : null}

      {name === "plan" ? (
        <>
          <Path d="M3.4 5.6a2.2 2.2 0 0 1 2.2-2.2h12.8a2.2 2.2 0 0 1 2.2 2.2v12.8a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2z" {...stroke} />
          <Path d="M3.4 9.8h17.2M9.8 9.8v10.8" {...stroke} />
        </>
      ) : null}

      {name === "team" ? (
        <>
          <Circle cx={9} cy={8} r={3.3} {...stroke} />
          <Path d="M2.9 20.2c0-3.4 2.7-5.7 6.1-5.7s6.1 2.3 6.1 5.7" {...stroke} />
          <Path d="M16.2 5.4a3.3 3.3 0 0 1 0 5.2M18.4 20.2c0-2.4-.8-4.3-2.1-5.5" {...stroke} />
        </>
      ) : null}

      {name === "person" ? (
        <>
          <Circle cx={12} cy={7.8} r={3.9} {...stroke} />
          <Path d="M4.6 20.4c0-4 3.3-6.7 7.4-6.7s7.4 2.7 7.4 6.7" {...stroke} />
        </>
      ) : null}

      {name === "chevronRight" ? <Path d="M9.5 5.5 16 12l-6.5 6.5" {...stroke} /> : null}

      {name === "arrowRight" ? (
        <>
          <Path d="M4.5 12h15" {...stroke} />
          <Path d="M13.5 6 19.5 12l-6 6" {...stroke} />
        </>
      ) : null}

      {name === "check" ? <Path d="M5 12.8 9.6 17.4 19 6.8" {...stroke} /> : null}

      {name === "clock" ? (
        <>
          <Circle cx={12} cy={12} r={8.8} {...stroke} />
          <Path d="M12 6.8V12l3.6 2.2" {...stroke} />
        </>
      ) : null}

      {name === "alert" ? (
        <>
          <Circle cx={12} cy={12} r={8.8} {...stroke} />
          <Path d="M12 7.4v5.4" {...stroke} />
          <Circle cx={12} cy={16.6} r={1.05} fill={color} />
        </>
      ) : null}

      {name === "signOut" ? (
        <>
          <Path d="M14.6 3.6H6.2a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h8.4" {...stroke} />
          <Path d="M14.4 12h6.2M17.8 8.8 21 12l-3.2 3.2" {...stroke} />
        </>
      ) : null}
    </Svg>
  );
}
