/**
 * Which office the app is about (FR-1.9).
 *
 * The failure this guards against is quiet: every screen used to reach for `sites[0]`
 * on its own, so a tenant with two buildings could get the home screen showing one
 * site's week and "Book a space" listing the other site's floors, with nothing
 * reported anywhere.
 */

import { placeName, type Site } from "@/lib/api";
import { resolveHomeSite } from "@/lib/site";

function site(id: string, over: Partial<Site> = {}): Site {
  return {
    id,
    name: `${id} HQ`,
    short_name: null,
    timezone: "Europe/Berlin",
    address: null,
    checkin_enabled: true,
    photo: null,
    ...over,
  };
}

const berlin = site("berlin");
const tampa = site("tampa");

describe("resolveHomeSite", () => {
  it("picks the user's own home site, not the first one", () => {
    const resolved = resolveHomeSite({
      sites: [berlin, tampa],
      homeSiteId: "tampa",
      signedIn: true,
      loading: false,
    });
    expect(resolved.site?.id).toBe("tampa");
    expect(resolved.needsChoosing).toBe(false);
  });

  it("asks when there is a real choice and no answer recorded", () => {
    const resolved = resolveHomeSite({
      sites: [berlin, tampa],
      homeSiteId: null,
      signedIn: true,
      loading: false,
    });
    expect(resolved.needsChoosing).toBe(true);
  });

  it("does not ask a single-office tenant to choose", () => {
    const resolved = resolveHomeSite({
      sites: [berlin],
      homeSiteId: null,
      signedIn: true,
      loading: false,
    });
    expect(resolved.needsChoosing).toBe(false);
    expect(resolved.site?.id).toBe("berlin");
  });

  it("never asks while the sites are still loading", () => {
    // The guard in app/_layout.tsx reads this directly. A true here on the first
    // render flashes the picker past somebody who answered months ago.
    const resolved = resolveHomeSite({
      sites: undefined,
      homeSiteId: "tampa",
      signedIn: true,
      loading: true,
    });
    expect(resolved.needsChoosing).toBe(false);
    expect(resolved.site).toBeUndefined();
  });

  it("never asks before we know who is signed in", () => {
    const resolved = resolveHomeSite({
      sites: [berlin, tampa],
      homeSiteId: null,
      signedIn: false,
      loading: false,
    });
    expect(resolved.needsChoosing).toBe(false);
  });

  it("asks again when the recorded home site no longer exists", () => {
    // A closed office. Silently reassigning this person to whichever site sorts
    // first would put them in the wrong building with no indication it had happened.
    const resolved = resolveHomeSite({
      sites: [berlin, tampa],
      homeSiteId: "amsterdam",
      signedIn: true,
      loading: false,
    });
    expect(resolved.needsChoosing).toBe(true);
  });
});

describe("placeName", () => {
  it("prefers the short name, which is what a greeting wants", () => {
    expect(placeName(site("x", { name: "Tampa — Rocky Point", short_name: "Tampa" }))).toBe(
      "Tampa",
    );
  });

  it("falls back to the full name rather than trimming one out of it", () => {
    expect(placeName(site("x", { name: "Tampa — Rocky Point" }))).toBe("Tampa — Rocky Point");
  });

  it("treats a whitespace-only short name as unset", () => {
    expect(placeName(site("x", { name: "Berlin HQ", short_name: "   " }))).toBe("Berlin HQ");
  });

  it("is empty rather than undefined when there is no site yet", () => {
    expect(placeName(undefined)).toBe("");
  });
});
