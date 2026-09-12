/**
 * Dates are site-local calendar dates, never instants (TDD §5). The device timezone must
 * not leak into which day a booking lands on.
 */

import { formatDate, timeInZone, toLocalDate, upcomingDays } from "../dates";

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

describe("upcomingDays", () => {
  const from = new Date(2026, 8, 12); // Saturday

  it("starts today and runs forward", () => {
    const days = upcomingDays(7, from);
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe("2026-09-12");
    expect(days[6].date).toBe("2026-09-18");
  });

  it("marks only the first day as today", () => {
    const days = upcomingDays(5, from);
    expect(days.filter((d) => d.isToday)).toHaveLength(1);
    expect(days[0].isToday).toBe(true);
  });

  it("crosses a month boundary correctly", () => {
    const days = upcomingDays(3, new Date(2026, 8, 30));
    expect(days.map((d) => d.date)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("crosses a year boundary correctly", () => {
    const days = upcomingDays(2, new Date(2026, 11, 31));
    expect(days.map((d) => d.date)).toEqual(["2026-12-31", "2027-01-01"]);
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
