import { describe, expect, it } from "vitest";

import {
  PatternError,
  clashingNames,
  expandPattern,
  namesForGrid,
  parsePattern,
  patternSize,
  shortLabel,
} from "@/lib/naming";

describe("expandPattern", () => {
  it("expands a single numeric range with the padding that was written", () => {
    expect(expandPattern("4F-A-{01..04}")).toEqual([
      "4F-A-01",
      "4F-A-02",
      "4F-A-03",
      "4F-A-04",
    ]);
  });

  it("does not invent padding that was not asked for", () => {
    expect(expandPattern("D{1..3}")).toEqual(["D1", "D2", "D3"]);
  });

  it("takes padding from the start of the range, not the widest end", () => {
    expect(expandPattern("{01..12}")[0]).toBe("01");
    expect(expandPattern("{01..12}").at(-1)).toBe("12");
    // Widest-end padding would render this as 001..100, which nobody typed.
    expect(expandPattern("{1..100}")[0]).toBe("1");
    expect(expandPattern("{001..100}")[0]).toBe("001");
  });

  it("expands letter ranges", () => {
    expect(expandPattern("{A..D}")).toEqual(["A", "B", "C", "D"]);
  });

  it("varies the FIRST range slowest, so {A..B}-{1..2} reads as rows then columns", () => {
    expect(expandPattern("{A..B}-{1..2}")).toEqual(["A-1", "A-2", "B-1", "B-2"]);
  });

  it("counts down when the range is written backwards", () => {
    expect(expandPattern("{3..1}")).toEqual(["3", "2", "1"]);
    expect(expandPattern("{C..A}")).toEqual(["C", "B", "A"]);
  });

  it("treats a pattern with no range as one literal name", () => {
    expect(expandPattern("Reception")).toEqual(["Reception"]);
  });

  it("keeps literal text on both sides of every range", () => {
    expect(expandPattern("L{1..2}-{A..B}-x")).toEqual(["L1-A-x", "L1-B-x", "L2-A-x", "L2-B-x"]);
  });

  it("refuses a pattern that would build more names than the browser should", () => {
    // {1..100000} is a typo, not a request. Locking the tab is not an error message.
    expect(() => expandPattern("{1..100000}")).toThrow(PatternError);
  });

  it("explains a malformed range instead of producing nonsense", () => {
    expect(() => expandPattern("{1-5}")).toThrow(PatternError);
    expect(() => expandPattern("{A..5}")).toThrow(PatternError);
    expect(() => expandPattern("{AB..AC}")).toThrow(PatternError);
    expect(() => expandPattern("4F-{01..")).toThrow(PatternError);
  });
});

describe("patternSize", () => {
  it("counts without building, so the dialog can warn before it expands", () => {
    expect(patternSize("{A..E}-{01..24}")).toBe(120);
    expect(patternSize("{1..1000000}")).toBe(1_000_000);
  });
});

describe("parsePattern", () => {
  it("keeps one more literal than it has ranges, including empty ones", () => {
    const { literals, ranges } = parsePattern("{A..B}x{1..2}");
    expect(ranges).toHaveLength(2);
    expect(literals).toEqual(["", "x", ""]);
  });
});

describe("namesForGrid", () => {
  it("returns one name per cell, in layout order", () => {
    expect(namesForGrid("{A..B}-{1..3}", 2, 3)).toEqual([
      "A-1",
      "A-2",
      "A-3",
      "B-1",
      "B-2",
      "B-3",
    ]);
  });

  it("returns SHORT rather than padding with undefined when the pattern is too small", () => {
    // The caller reports the shortfall. Silently generating `undefined` is how a bulk
    // import ends up with a desk actually named "undefined".
    expect(namesForGrid("{1..2}", 2, 3)).toEqual(["1", "2"]);
  });
});

describe("clashingNames", () => {
  it("reports names already taken on the site", () => {
    expect(clashingNames(["4F-A-01", "4F-A-02"], ["4F-A-02"])).toEqual(["4F-A-02"]);
  });

  it("compares case-insensitively, because the API does", () => {
    expect(clashingNames(["4f-a-01"], ["4F-A-01"])).toEqual(["4f-a-01"]);
  });

  it("catches a pattern that collides with itself", () => {
    expect(clashingNames(["A-1", "A-1"], [])).toEqual(["A-1"]);
  });

  it("is quiet when nothing clashes", () => {
    expect(clashingNames(["A-1", "A-2"], ["B-1"])).toEqual([]);
  });
});

describe("shortLabel", () => {
  it("drops the floor prefix that every desk on the floor shares", () => {
    expect(shortLabel("4F-A-01")).toBe("A-01");
  });

  it("keeps a code that has nothing to drop", () => {
    expect(shortLabel("A-01")).toBe("A-01");
    expect(shortLabel("RECEPTION")).toBe("RECEPTION");
  });

  it("drops only the first segment, so labels stay unique across rows", () => {
    // Taking just the trailing number made all five rows read 01..12.
    expect(shortLabel("4F-A-01")).not.toBe(shortLabel("4F-B-01"));
  });
});
