/**
 * Reason codes -> prose (TDD §9, §11). The server sends no user-facing English, so this
 * map is the only thing standing between a policy refusal and a raw slug on screen.
 */

import type { Violation } from "../api";
import { describe as describeViolation, describeAll, refusal } from "../messages";

const v = (code: string, params: Record<string, unknown> = {}, severity = "block"): Violation =>
  ({ code, params, severity }) as Violation;

describe("describe", () => {
  it("renders the horizon refusal with its limit", () => {
    expect(describeViolation(v("policy.horizon_exceeded", { max_days: 14 }))).toBe(
      "You can only book up to 14 days ahead.",
    );
  });

  it("formats ISO dates rather than showing them raw", () => {
    const text = describeViolation(v("policy.already_booked_today", { date: "2026-09-14" }));
    expect(text).toContain("Monday");
    expect(text).not.toContain("2026-09-14");
  });

  it("distinguishes a closed office from an out-of-hours time", () => {
    const closed = describeViolation(
      v("policy.outside_opening_hours", { date: "2026-09-12", closed: true }),
    );
    const outOfHours = describeViolation(
      v("policy.outside_opening_hours", { date: "2026-09-14", closed: false }),
    );
    expect(closed).toContain("closed");
    expect(outOfHours).toContain("opening hours");
    expect(closed).not.toBe(outOfHours);
  });

  it("names the desk that was taken", () => {
    expect(describeViolation(v("resource.unavailable", { resource_code: "4F-A-01" }))).toContain(
      "4F-A-01",
    );
  });

  it("falls back to something useful for an unmapped code", () => {
    // A new server rule must never surface as a raw slug.
    const text = describeViolation(v("policy.brand_new_rule", { x: 1 }));
    expect(text).not.toContain("policy.brand_new_rule");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("describeAll", () => {
  it("joins every blocking reason so the user learns all of them at once", () => {
    const text = describeAll(
      [
        v("policy.horizon_exceeded", { max_days: 14 }),
        v("policy.site_capacity_reached", { date: "2026-09-14", capacity: 100 }),
      ],
      "fallback",
    );
    expect(text).toContain("14 days");
    expect(text).toContain("full");
  });

  it("ignores warnings, which must not block or alarm", () => {
    const text = describeAll([v("policy.room_capacity_fit", {}, "warn")], "fallback");
    expect(text).toBe("fallback");
  });

  it("uses the fallback when there are no violations at all", () => {
    expect(describeAll([], "Could not reach the server.")).toBe("Could not reach the server.");
  });
});

describe("refusal", () => {
  it("never says the same thing twice", () => {
    // The sheet shows headline and detail stacked. Rendering `describe` for the first
    // violation printed the identical sentence in both, which is what shipped.
    const r = refusal([v("policy.already_booked_today", { date: "2026-09-14" })], "x");
    expect(r.headline).toContain("Monday");
    expect(r.detail).not.toBe(r.headline);
    expect(r.detail).toBe("");
  });

  it("keeps the number that makes the rule credible", () => {
    const r = refusal(
      [v("policy.site_capacity_reached", { date: "2026-09-14", capacity: 80 })],
      "x",
    );
    expect(r.headline).toContain("full");
    expect(r.detail).toContain("80");
  });

  it("offers a fix when the rule implies one the user can act on", () => {
    const r = refusal([v("policy.max_concurrent_reached", { held: 5, max: 5 })], "x");
    expect(r.fix).toContain("Cancel");
  });

  it("flags the refusals another day would solve, and not the others", () => {
    expect(refusal([v("policy.site_capacity_reached", { date: "2026-09-14" })], "x").otherDaysHelp)
      .toBe(true);
    expect(refusal([v("policy.max_concurrent_reached", { held: 5, max: 5 })], "x").otherDaysHelp)
      .toBe(false);
  });

  it("still states every further violation, so one fix does not reveal the next", () => {
    const r = refusal(
      [
        v("policy.already_booked_today", { date: "2026-09-14" }),
        v("policy.horizon_exceeded", { max_days: 14 }),
      ],
      "x",
    );
    expect(r.detail).toContain("14 days");
  });

  it("falls back to the sentence for an unmapped code rather than showing a slug", () => {
    const r = refusal([v("policy.brand_new_rule", {})], "x");
    expect(r.headline).not.toContain("policy.brand_new_rule");
    expect(r.detail.length).toBeGreaterThan(0);
    // The code itself is still carried, for the support line at the foot of the sheet.
    expect(r.code).toBe("policy.brand_new_rule");
  });

  it("keeps the network fallback when there are no violations at all", () => {
    const r = refusal([], "Could not reach the server.");
    expect(r.detail).toBe("Could not reach the server.");
    expect(r.code).toBeNull();
  });

  it("ignores warnings, which must not produce a refusal sheet at all", () => {
    const r = refusal([v("policy.room_capacity_fit", {}, "warn")], "fallback");
    expect(r.headline).toBe("Something went wrong");
    expect(r.detail).toBe("fallback");
  });
});
