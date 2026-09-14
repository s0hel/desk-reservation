"""Mirror of packages/shared/src/reason-codes.ts. Kept in sync by CI (TDD §9)."""

from typing import Final

HORIZON_EXCEEDED: Final = "policy.horizon_exceeded"
MAX_CONCURRENT_REACHED: Final = "policy.max_concurrent_reached"
SITE_CAPACITY_REACHED: Final = "policy.site_capacity_reached"
ZONE_NOT_PERMITTED: Final = "policy.zone_not_permitted"
ZONE_NOT_YET_OPEN: Final = "policy.zone_not_yet_open"
BLACKOUT: Final = "policy.blackout"
OUTSIDE_OPENING_HOURS: Final = "policy.outside_opening_hours"
QUOTA_REACHED: Final = "policy.quota_reached"
QUOTA_MINIMUM_UNMET: Final = "policy.quota_minimum_unmet"
ASSIGNED_DESK_OWNER_PRESENT: Final = "policy.assigned_desk_owner_present"
CANCELLATION_CUTOFF_PASSED: Final = "policy.cancellation_cutoff_passed"
NO_SHOW_RESTRICTED: Final = "policy.no_show_restricted"
ALREADY_BOOKED_TODAY: Final = "policy.already_booked_today"
DELEGATION_NOT_PERMITTED: Final = "policy.delegation_not_permitted"
ROOM_MAX_DURATION: Final = "policy.room_max_duration"
ROOM_ADVANCE_LIMIT: Final = "policy.room_advance_limit"
ROOM_CAPACITY_FIT: Final = "policy.room_capacity_fit"  # severity: warn
ABSENCE_CONFLICTS_WITH_BOOKING: Final = "presence.absence_conflicts_with_booking"
ABSENCE_KIND_UNKNOWN: Final = "presence.absence_kind_unknown"
VISIBILITY_UNKNOWN: Final = "presence.visibility_unknown"
#: Admin-console refusals (FR-8.4). They travel in the same problem+json envelope as a
#: booking refusal, for the same reason: the console renders its own sentence from the
#: code and params, and an admin refusal needs to name what is in the way just as much
#: as an employee's does.
LAST_ORG_ADMIN: Final = "admin.last_org_admin"
GROUP_IN_USE: Final = "admin.group_in_use"
EMAIL_TAKEN: Final = "admin.email_taken"
UNKNOWN_ROLE: Final = "admin.unknown_role"
RESOURCE_UNAVAILABLE: Final = "resource.unavailable"
RESOURCE_OUT_OF_SERVICE: Final = "resource.out_of_service"

ALL: Final = tuple(
    v for k, v in list(globals().items()) if k.isupper() and isinstance(v, str) and "." in v
)
