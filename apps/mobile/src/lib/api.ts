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
export type Me = {
  id: string; organization_id: string; email: string; display_name: string;
  locale: string; home_site_id: string | null; presence_visibility: string; roles: string[];
};
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
};
