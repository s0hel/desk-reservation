/**
 * The only module permitted to call fetch (TDD §13.1).
 *
 * Phase 1 replaces the hand-written types below with @repo/api-client, generated from
 * the API's OpenAPI schema in CI so the contract cannot drift silently.
 */

const BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export type Violation = { code: string; params: Record<string, unknown>; severity: "block" | "warn" };

/** RFC 9457 problem+json. `detail` is for developers; users see messages rendered
 *  from `code` + `params`, which is what keeps refusals explainable AND localizable. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly violations: Violation[] = [],
  ) {
    super(detail || title);
  }
}

export type Site = {
  id: string; name: string; timezone: string; address: string | null; checkin_enabled: boolean;
};
export type Floor = {
  id: string; site_id: string; name: string; ordinal: number;
  plan_width_px: number | null; plan_height_px: number | null;
};
export type Resource = {
  id: string; floor_id: string; zone_id: string | null; kind: "desk" | "room";
  code: string; name: string | null; capacity: number;
  position: { x?: number; y?: number; rotation?: number };
  attributes: Record<string, unknown>; bookable: boolean; site_timezone: string;
};
export type Visibility = "everyone" | "team_only" | "nobody";

export type Me = {
  id: string; organization_id: string; email: string; display_name: string;
  locale: string; home_site_id: string | null; presence_visibility: Visibility; roles: string[];
  /**
   * Server-owned. `presence` is the org kill switch (PRD Q6): when it is false the app
   * must drop the feature — no Team tab, no colleagues on the plan — rather than offer
   * it and let every call 404.
   */
  features: Record<string, boolean>;
};
export type ResourceAvailability = {
  id: string; code: string; name: string | null; kind: "desk" | "room";
  capacity: number; position: { x?: number; y?: number; rotation?: number };
  attributes: Record<string, unknown>; zone_id: string | null;
  available: boolean; bookable: boolean;
  /**
   * Why THIS viewer may not book it — a zone held for another team (FR-6.4). Distinct
   * from `bookable`, which is a fact about the desk. Rendered from the code like any
   * other refusal.
   */
  restriction: { code: string; params: Record<string, unknown> } | null;
  out_of_service_reason: string | null; occupied_by_me: boolean;
};

export type Zone = {
  id: string; name: string; polygon: number[][]; color: string | null;
};

/** The published plan image. Null until an admin publishes one (TDD §14.3). */
export type Plan = {
  url: string; width_px: number; height_px: number; aspect_ratio: number;
};

export type Availability = {
  floor_id: string; local_date: string; slot: Slot;
  starts_at: string; ends_at: string; site_timezone: string;
  total: number; available: number; resources: ResourceAvailability[]; zones: Zone[];
  plan: Plan | null;
};

export type Slot = "full_day" | "am" | "pm" | "custom";

export type Booking = {
  id: string; resource_id: string; resource_code: string | null; site_id: string;
  user_id: string; local_date: string; slot: string; status: string;
  starts_at: string; ends_at: string; site_timezone: string | null;
};

/** One day in the week strip (FR-2.1). */
export type DayAvailability = {
  local_date: string;
  /** False when the site does not open at all. Not the same as 0 free. */
  is_open: boolean;
  total: number;
  available: number;
  /**
   * An admin has closed the day (FR-6.5). Not the same as the office being shut for the
   * weekend. The flag is separate from the reason because the reason is optional: a
   * closure with no reason must still read as closed.
   */
  blackout: boolean;
  blackout_reason: string | null;
  my_booking: {
    id: string;
    resource_code: string | null;
    floor_id: string;
    floor_name: string;
    status: string;
    starts_at: string;
    ends_at: string;
  } | null;
};

export type WeekAvailability = {
  site_id: string;
  site_name: string;
  site_timezone: string;
  /** Today at the SITE, which is the day the strip highlights (TDD §5). */
  today: string;
  days: DayAvailability[];
};

/** Where a colleague is sitting. `position` is normalized plan space (TDD §14.2). */
export type Seat = {
  floor_id: string; floor_name: string; resource_id: string; resource_code: string;
  position: { x?: number; y?: number; rotation?: number };
};

export type Person = {
  user_id: string; display_name: string; initials: string; avatar_url: string | null;
  status: string; seat: Seat | null; is_me: boolean;
};

/**
 * Who is in, on one day.
 *
 * No total, deliberately, and the client must not invent one from elsewhere: a count
 * larger than this list would identify the people who opted out of being named
 * (TDD §11, PRD Q6). How full the office is comes from availability, which names
 * nobody.
 */
export type Presence = { site_id: string; local_date: string; people: Person[] };

export type DayPresence = { local_date: string; status: string; seat: Seat | null };

export type UserPresence = {
  user_id: string; display_name: string; initials: string; avatar_url: string | null;
  days: DayPresence[];
};

export type Colleague = {
  user_id: string; display_name: string; initials: string;
  avatar_url: string | null; is_me: boolean;
};

export type TeamMember = Colleague & { days: DayPresence[] };

export type Team = {
  group_id: string | null; group_name: string | null;
  dates: string[]; members: TeamMember[];
};

export type Absence = { local_date: string; kind: "remote" | "leave" | "travel" };

export type TokenPair = {
  access_token: string; refresh_token: string; expires_in: number; roles: string[];
};

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    throw new ProblemError(
      res.status,
      body.title ?? "Request failed",
      body.detail ?? res.statusText,
      body.violations ?? [],
    );
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  discover: (email: string) =>
    request<{ organization_id: string; organization_name: string; idp_kind: string }>(
      "/v1/auth/discover", { method: "POST", body: JSON.stringify({ email }) }),

  /** DEV ONLY — Phase 0 uses this until a customer IdP is configured (TDD §12.1). */
  devLogin: (email: string) =>
    request<TokenPair>("/v1/auth/dev-login", { method: "POST", body: JSON.stringify({ email }) }),

  refresh: (refresh_token: string) =>
    request<TokenPair>("/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token }) }),

  me: (t: string) => request<Me>("/v1/me", {}, t),
  sites: (t: string) => request<Site[]>("/v1/sites", {}, t),
  floors: (t: string, siteId: string) => request<Floor[]>(`/v1/sites/${siteId}/floors`, {}, t),
  resources: (t: string, floorId: string, kind?: "desk" | "room") =>
    request<Resource[]>(`/v1/floors/${floorId}/resources${kind ? `?kind=${kind}` : ""}`, {}, t),

  availability: (t: string, floorId: string, date: string, kind?: "desk" | "room", slot: Slot = "full_day") =>
    request<Availability>(
      `/v1/floors/${floorId}/availability?date=${date}&slot=${slot}${kind ? `&kind=${kind}` : ""}`,
      {}, t,
    ),

  /**
   * The whole week at one site in a single call. Seven per-floor availability calls on
   * app open is the Monday-morning spike we are trying not to create.
   */
  week: (t: string, siteId: string, from?: string, days = 7, kind: "desk" | "room" = "desk") => {
    const q = new URLSearchParams({ days: String(days), kind });
    if (from) q.set("from", from);
    return request<WeekAvailability>(`/v1/sites/${siteId}/availability?${q}`, {}, t);
  },

  createBooking: (
    t: string,
    body: { resource_id: string; local_date: string; slot?: Slot },
    idempotencyKey: string,
  ) =>
    request<Booking>("/v1/bookings", {
      method: "POST",
      body: JSON.stringify(body),
      // Mobile clients retry; the key makes a retry a replay rather than a second
      // booking (TDD §10.2). It must be stable across retries of the SAME intent,
      // so it is generated once when the user commits, not per request.
      headers: { "Idempotency-Key": idempotencyKey },
    }, t),

  bookings: (t: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const qs = q.toString();
    return request<Booking[]>(`/v1/bookings${qs ? `?${qs}` : ""}`, {}, t);
  },

  cancelBooking: (t: string, id: string) =>
    request<Booking>(`/v1/bookings/${id}`, { method: "DELETE" }, t),

  updateMe: (t: string, body: { presence_visibility?: Visibility; locale?: string }) =>
    request<Me>("/v1/me", { method: "PATCH", body: JSON.stringify(body) }, t),

  /** Who is in at a site on a day (FR-5.1). 404 when the org has presence switched off. */
  presence: (t: string, siteId: string, date?: string) => {
    const q = new URLSearchParams({ site: siteId });
    if (date) q.set("date", date);
    return request<Presence>(`/v1/presence?${q}`, {}, t);
  },

  /**
   * One colleague's upcoming days (FR-5.2). A colleague who has hidden themselves is a
   * 404 — refusing by name would confirm the very fact they hid — so the screen has to
   * treat "not found" as "nothing to show", not as an error worth reporting.
   */
  userPresence: (t: string, userId: string, siteId?: string, from?: string, days = 14) => {
    const q = new URLSearchParams({ days: String(days) });
    if (siteId) q.set("site", siteId);
    if (from) q.set("from", from);
    return request<UserPresence>(`/v1/users/${userId}/presence?${q}`, {}, t);
  },

  colleagues: (t: string, q: string, limit = 20) =>
    request<Colleague[]>(
      `/v1/colleagues?${new URLSearchParams({ q, limit: String(limit) })}`, {}, t,
    ),

  /** A week of the team's planned presence (FR-5.4). */
  team: (t: string, opts: { groupId?: string; siteId?: string; from?: string; days?: number } = {}) => {
    const q = new URLSearchParams({ days: String(opts.days ?? 7) });
    if (opts.groupId) q.set("group", opts.groupId);
    if (opts.siteId) q.set("site", opts.siteId);
    if (opts.from) q.set("from", opts.from);
    return request<Team>(`/v1/team?${q}`, {}, t);
  },

  absences: (t: string, from: string, to: string) =>
    request<Absence[]>(`/v1/absences?${new URLSearchParams({ from, to })}`, {}, t),

  /** Declare a day away (FR-5.5). Refused while a desk is still held for it. */
  declareAbsence: (t: string, localDate: string, kind: Absence["kind"]) =>
    request<Absence>(
      `/v1/absences/${localDate}`, { method: "PUT", body: JSON.stringify({ kind }) }, t,
    ),

  clearAbsence: (t: string, localDate: string) =>
    request<void>(`/v1/absences/${localDate}`, { method: "DELETE" }, t),
};

/** Stable-per-intent key for booking retries. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
