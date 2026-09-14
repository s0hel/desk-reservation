/**
 * Dates are site-local calendar dates, never instants (TDD §5). The device timezone must
 * not leak into which day a booking lands on.
 */

import { formatDate, timeInZone, toLocalDate } from "../dates";

describe("toLocalDate", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(toLocalDate(new Date(2026, 8, 14))).toBe("2026-09-14");
  });

  it("zero-pads month and day", () => {
    expect(toLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("uses local calendar fields, not UTC", () => {
    // 23:30 local on the 14th is the 15th in UTC. The booking belongs to the 14th.
    const lateEvening = new Date(2026, 8, 14, 23, 30);
    expect(toLocalDate(lateEvening)).toBe("2026-09-14");
  });
});

describe("formatDate", () => {
  it("renders a human date from a plain calendar string", () => {
    // Parsed as local calendar fields; "2026-09-14" must never become the 13th.
    expect(formatDate("2026-09-14")).toContain("14");
    expect(formatDate("2026-09-14")).toContain("Monday");
  });
});

describe("timeInZone", () => {
  it("renders an instant in the site's zone, not the device's", () => {
    // 05:00Z is 07:00 in Berlin.
    const berlin = timeInZone("2026-09-14T05:00:00Z", "Europe/Berlin");
    expect(berlin).toMatch(/^0?7:00/);
  });

  it("renders the same instant differently for a different site", () => {
    const berlin = timeInZone("2026-09-14T05:00:00Z", "Europe/Berlin");
    const la = timeInZone("2026-09-14T05:00:00Z", "America/Los_Angeles");
    expect(berlin).not.toBe(la);
  });

  it("returns an empty string for an unparseable value rather than throwing", () => {
    expect(timeInZone("not-a-date", "Europe/Berlin")).toBe("");
  });
});
