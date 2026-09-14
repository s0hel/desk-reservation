import { initialsOf, nearestTo, statusLabel, statusShort, tintIndex } from "../presence";
import { addDays } from "../dates";

describe("tintIndex", () => {
  it("is stable for the same id", () => {
    const id = "0199f0c2-4a1b-7c3d-9e2f-1a2b3c4d5e6f";
    expect(tintIndex(id, 6)).toBe(tintIndex(id, 6));
  });

  it("stays inside the palette", () => {
    for (let i = 0; i < 200; i++) {
      const index = tintIndex(`user-${i}`, 6);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(6);
    }
  });

  // The hash accumulates with `| 0`, so a long id can land on a negative intermediate;
  // without the abs() that produced a negative index and an undefined colour.
  it("never returns a negative index for a long id", () => {
    expect(tintIndex("a".repeat(200), 6)).toBeGreaterThanOrEqual(0);
  });

  it("survives an empty palette rather than dividing by zero", () => {
    expect(tintIndex("anyone", 0)).toBe(0);
  });
});

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Priya Raman")).toBe("PR");
    expect(initialsOf("Jean-Luc de la Fontaine")).toBe("JD");
  });

  it("copes with one name, blanks and nothing at all", () => {
    expect(initialsOf("Prince")).toBe("P");
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf(null)).toBe("?");
  });
});

describe("statusLabel", () => {
  // "unknown" must not read as an absence: silence is not a statement (FR-5.4).
  it("does not turn silence into an absence", () => {
    expect(statusLabel("unknown")).toBe("No plans yet");
    expect(statusShort("unknown")).toBe("—");
  });

  it("names every status it is given", () => {
    for (const status of ["in", "remote", "leave", "travel", "unknown"] as const) {
      expect(statusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe("nearestTo", () => {
  const desks = [
    { id: "far", position: { x: 0.9, y: 0.9 } },
    { id: "near", position: { x: 0.52, y: 0.51 } },
    { id: "middle", position: { x: 0.7, y: 0.7 } },
  ];

  it("picks the closest desk in normalized plan space", () => {
    expect(nearestTo({ x: 0.5, y: 0.5 }, desks)?.id).toBe("near");
  });

  // (0,0) is a real place on a plan, so a desk with no coordinates must not be treated
  // as sitting in the top-left corner — it would win every time nothing else is close.
  it("skips desks with no position rather than treating them as the origin", () => {
    const withUnplaced = [{ id: "unplaced", position: null }, ...desks];
    expect(nearestTo({ x: 0.05, y: 0.05 }, withUnplaced)?.id).toBe("near");
    expect(nearestTo({ x: 0.5, y: 0.5 }, [{ id: "unplaced", position: null }])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(nearestTo({ x: 0.5, y: 0.5 }, [])).toBeNull();
  });
});

describe("addDays", () => {
  it("walks a week without touching a clock", () => {
    expect(addDays("2026-09-13", 0)).toBe("2026-09-13");
    expect(addDays("2026-09-13", 6)).toBe("2026-09-19");
  });

  it("crosses month and year ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  // Europe/Berlin springs forward on 29 March 2026. Adding 86400000ms to an instant
  // lands at 23:00 the previous evening and reads back as the wrong day.
  it("keeps the calendar day across a DST boundary", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  });
});
