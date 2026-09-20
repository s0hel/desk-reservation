/**
 * Which office the app is talking about (FR-1.9).
 *
 * Every screen that shows a day, a floor or a plan needs a site, and until now each
 * one reached for `sites[0]` independently. That is wrong in two ways at once: it
 * silently picks whichever site sorts first alphabetically, and two screens can
 * disagree the moment a tenant has more than one — the home screen showing Berlin's
 * week while "Book a space" lists Amsterdam's floors.
 *
 * The answer is the user's own: `me.home_site_id`. This hook is the only place that
 * resolves it, so there is one rule rather than four copies of a guess.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Site } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export type HomeSite = {
  site: Site | undefined;
  /** Every site in the tenant — what the first-run picker offers. */
  sites: Site[];
  loading: boolean;
  /**
   * True once we know the sites AND the user has no home site to point at. This is
   * what the root layout's guard reads, so it must be false while loading: a guard
   * that flickers true sends someone who already has a home office through the
   * picker for one frame on every cold start.
   */
  needsChoosing: boolean;
  /**
   * Re-ask for the sites. The home screen's pull-to-refresh calls it: the header is
   * rendered from this query, and the photo URL in it is a signed capability with an
   * hour's life, so "refresh" has to mean this too.
   */
  refetch: () => void;
};

export function useHomeSite(): HomeSite {
  const { token, me } = useAuth();

  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: () => api.sites(token!),
    enabled: !!token,
  });

  return {
    ...resolveHomeSite({
      sites: sites.data,
      homeSiteId: me?.home_site_id ?? null,
      signedIn: !!me,
      loading: sites.isLoading,
    }),
    refetch: () => void sites.refetch(),
  };
}

/**
 * The rule itself, kept pure so it can be tested — React Native Testing Library does
 * not run under this SDK (see CLAUDE.md), so anything only reachable through a hook
 * is only reachable through the simulator.
 */
export function resolveHomeSite({
  sites,
  homeSiteId,
  signedIn,
  loading,
}: {
  sites: Site[] | undefined;
  homeSiteId: string | null;
  signedIn: boolean;
  loading: boolean;
}): Omit<HomeSite, "refetch"> {
  const all = sites ?? [];
  const home = all.find((s) => s.id === homeSiteId);

  // Falling back to the first site is deliberate and is NOT the old `sites[0]` under a
  // new name: it applies only where no choice has been recorded and none is being
  // asked for — a tenant with exactly one office — so the app is usable rather than
  // blank. Wherever there is a real choice, `needsChoosing` sends the user to make it.
  return {
    site: home ?? all[0],
    sites: all,
    loading,
    // A home site that names a site this tenant no longer has counts as unanswered:
    // `find` returns undefined, so a closed office sends the user back to the picker
    // rather than silently reassigning them to whichever site sorts first.
    needsChoosing: signedIn && !loading && !home && all.length > 1,
  };
}


/**
 * Change which office the app is about.
 *
 * Here rather than in either screen that offers it, because the two callers — the
 * first-run picker and the Me tab — have to do the same three things in the same
 * order, and the list of caches to drop is exactly the sort of thing that grows in
 * one copy and not the other. The order matters: `refreshMe` is last, because it is
 * what flips `needsChoosing` and unmounts the picker, and anything invalidated after
 * that would be invalidating caches for a screen that has already gone.
 */
export function useSetHomeSite(onDone?: () => void) {
  const { token, refreshMe } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (siteId: string) => api.updateMe(token!, { home_site_id: siteId }),
    onSuccess: async () => {
      // Everything keyed on a site belongs to the office that just changed. Without
      // this the tabs render the previous site's week for a beat — and the floor list
      // would offer floors from a building the user no longer says they work in.
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      queryClient.invalidateQueries({ queryKey: ["availability"] });
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["presence"] });
      await refreshMe();
      onDone?.();
    },
  });
}
