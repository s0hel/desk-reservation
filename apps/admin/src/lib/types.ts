/**
 * The editor's view of a floor. Mirrors `app/services/layout.py` — that module is the
 * authority, and CI regenerates `@repo/api-client` from its OpenAPI schema, so a drift
 * here is caught by the contract job rather than by an admin.
 */

export type Position = { x: number; y: number; rotation: number };

export type ResourceKind = "desk" | "room";

export type LayoutResource = {
  /** Stable within the editor session. Equals `id` once published. */
  key: string;
  id: string | null;
  kind: ResourceKind;
  code: string;
  name: string | null;
  position: Position;
  capacity: number;
  attributes: Record<string, unknown>;
  zone_key: string | null;
  bookable: boolean;
  out_of_service_reason: string | null;
};

export type ZonePermissionMode = "exclusive" | "preferred" | "open_after";

export type LayoutZonePermission = {
  group_id: string;
  mode: ZonePermissionMode;
  opens_at_local: string | null;
};

export type LayoutZone = {
  key: string;
  id: string | null;
  name: string;
  kind: string;
  /** Normalized [x, y] pairs in plan space (TDD §14.2). */
  polygon: [number, number][];
  color: string | null;
  permissions: LayoutZonePermission[];
};

export type Layout = {
  version: number;
  plan_asset_id: string | null;
  resources: LayoutResource[];
  zones: LayoutZone[];
};

export type Plan = {
  asset_id: string;
  url: string;
  width_px: number;
  height_px: number;
  content_type: string;
  converted?: boolean;
};

export type FloorSummary = {
  id: string;
  site_id: string;
  name: string;
  ordinal: number;
  plan_width_px: number | null;
  plan_height_px: number | null;
  published_at: string | null;
  resource_count: number;
  has_draft: boolean;
};

/** The building's photograph, shown at the top of the mobile home screen (FR-2.1). */
export type SitePhoto = {
  url: string;
  width_px: number;
  height_px: number;
  aspect_ratio: number;
};

export type SiteSummary = {
  id: string;
  name: string;
  /** What people call the place — "Tampa", where `name` is "Tampa — Rocky Point". */
  short_name: string | null;
  timezone: string;
  address: string | null;
  photo: SitePhoto | null;
};

export type Group = { id: string; name: string; kind: string };

export type FloorEditorData = {
  floor: FloorSummary;
  site: SiteSummary;
  plan: Plan | null;
  layout: Layout;
  is_draft: boolean;
  draft_updated_at: string | null;
  groups: Group[];
};

export type Orphan = {
  resource_id: string;
  code: string;
  bookings: number;
  reason: "deleted" | "unbookable";
};

export type PublishPreflight = {
  creates: number;
  updates: number;
  deletes: number;
  zone_creates: number;
  zone_updates: number;
  zone_deletes: number;
  affected_bookings: number;
  orphans: Orphan[];
  plan_changed: boolean;
  aspect_ratio_change: { from: number; to: number } | null;
  is_empty: boolean;
  published_at: string | null;
};

export type Violation = {
  code: string;
  params: Record<string, unknown>;
  severity: "block" | "warn";
};

/** RFC 9457 problem+json (TDD §11). `detail` is for developers; users see codes. */
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

export const DEFAULT_DESK_ATTRIBUTES: Record<string, unknown> = {
  sit_stand: false,
  monitors: 0,
  dock: "none",
  window: false,
  quiet: false,
  accessible: false,
};

export const DEFAULT_ROOM_ATTRIBUTES: Record<string, unknown> = {
  display: false,
  video_conf: false,
  whiteboard: false,
  phone: false,
  photos: [],
};

export function defaultAttributes(kind: ResourceKind): Record<string, unknown> {
  return { ...(kind === "room" ? DEFAULT_ROOM_ATTRIBUTES : DEFAULT_DESK_ATTRIBUTES) };
}

// ---------------------------------------------------------------- people (FR-8.4)

export type RoleName = "employee" | "team_lead" | "site_admin" | "org_admin";
export type ScopeType = "org" | "site";

export type RoleAssignment = {
  role: RoleName;
  scope_type: ScopeType;
  /** Null for an org-scoped role. The API drops it rather than storing an ignored one. */
  scope_id: string | null;
};

export type GroupRef = { id: string; name: string };

export type DirectoryUser = {
  id: string;
  email: string;
  display_name: string;
  locale: string;
  status: string;
  home_site_id: string | null;
  presence_visibility: string;
  is_active: boolean;
  roles: RoleAssignment[];
  groups: GroupRef[];
};

/** `total` counts everyone matching the filter, not the page — see the API model. */
export type UserPage = { total: number; users: DirectoryUser[] };

/** What deactivating someone would cost, asked before it is done. */
export type Deactivation = {
  bookings: number;
  sample: string[];
  groups: number;
  is_last_admin: boolean;
};

export type GroupZone = { id: string; name: string; mode: ZonePermissionMode };

export type AdminGroup = {
  id: string;
  name: string;
  kind: string;
  member_count: number;
  /** Non-empty means deleting it would silently open those zones — so it is refused. */
  zones: GroupZone[];
};

export type GroupMember = {
  user_id: string;
  display_name: string;
  email: string;
  role: string;
  is_active: boolean;
};

export const ROLE_LABELS: Record<RoleName, string> = {
  employee: "Employee",
  team_lead: "Team lead",
  site_admin: "Site admin",
  org_admin: "Org admin",
};
