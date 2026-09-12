/**
 * Policy refusal codes (TDD §9, §11).
 *
 * The server never sends user-facing prose. It sends a code plus params; the client
 * renders a localized message. That is what keeps FR-6.9 (every refusal explains
 * itself) compatible with FR-10.4 (four launch languages).
 *
 * Mirrored in services/api/app/policy/codes.py. CI fails if a code exists on one side
 * without the other, or without a message key in every locale.
 */

export const REASON_CODES = {
  HORIZON_EXCEEDED: "policy.horizon_exceeded",
  MAX_CONCURRENT_REACHED: "policy.max_concurrent_reached",
  SITE_CAPACITY_REACHED: "policy.site_capacity_reached",
  ZONE_NOT_PERMITTED: "policy.zone_not_permitted",
  ZONE_NOT_YET_OPEN: "policy.zone_not_yet_open",
  BLACKOUT: "policy.blackout",
  OUTSIDE_OPENING_HOURS: "policy.outside_opening_hours",
  QUOTA_REACHED: "policy.quota_reached",
  QUOTA_MINIMUM_UNMET: "policy.quota_minimum_unmet",
  ASSIGNED_DESK_OWNER_PRESENT: "policy.assigned_desk_owner_present",
  CANCELLATION_CUTOFF_PASSED: "policy.cancellation_cutoff_passed",
  NO_SHOW_RESTRICTED: "policy.no_show_restricted",
  ALREADY_BOOKED_TODAY: "policy.already_booked_today",
  DELEGATION_NOT_PERMITTED: "policy.delegation_not_permitted",
  ROOM_MAX_DURATION: "policy.room_max_duration",
  ROOM_ADVANCE_LIMIT: "policy.room_advance_limit",
  ROOM_CAPACITY_FIT: "policy.room_capacity_fit", // severity: warn, not block
  RESOURCE_UNAVAILABLE: "resource.unavailable",
  RESOURCE_OUT_OF_SERVICE: "resource.out_of_service",
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
export type Severity = "block" | "warn";

export type Violation = {
  code: ReasonCode | string;
  params: Record<string, unknown>;
  severity: Severity;
};
