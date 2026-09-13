"use client";

/**
 * The right-hand panel: what is selected, and how to change all of it at once.
 *
 * Multi-select editing is the point (TDD §14.3, "multi-select → set attributes on all
 * selected"). A field shows a value when the whole selection agrees and "mixed"
 * otherwise, and touching it applies to everything selected — which is what makes
 * "these forty desks are sit-stand" one action rather than forty.
 */

import type {
  Group,
  LayoutResource,
  LayoutZone,
  ZonePermissionMode,
} from "@/lib/types";

type Props = {
  selection: LayoutResource[];
  zones: LayoutZone[];
  activeZone: LayoutZone | null;
  groups: Group[];
  onPatch: (patch: Partial<Omit<LayoutResource, "key" | "id">>) => void;
  onPatchAttributes: (attributes: Record<string, unknown>) => void;
  onDelete: () => void;
  onPatchZone: (key: string, patch: Partial<Omit<LayoutZone, "key" | "id">>) => void;
  onDeleteZone: (key: string) => void;
};

const DESK_FLAGS = [
  ["sit_stand", "Sit-stand"],
  ["window", "Window"],
  ["quiet", "Quiet"],
  ["accessible", "Accessible"],
] as const;

const ROOM_FLAGS = [
  ["display", "Display"],
  ["video_conf", "Video conferencing"],
  ["whiteboard", "Whiteboard"],
  ["phone", "Phone"],
] as const;

const DOCKS = ["none", "usb_c", "thunderbolt", "dual"] as const;

const MODES: { id: ZonePermissionMode; label: string }[] = [
  { id: "exclusive", label: "Exclusive — only this group may book" },
  { id: "preferred", label: "Preferred — this group is offered it first" },
  { id: "open_after", label: "Open after — reserved until a cut-off, then open" },
];

/** A shared value, or `undefined` when the selection disagrees. */
function common<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first] = values;
  return values.every((value) => value === first) ? first : undefined;
}

/** A checkbox that can also be neither on nor off. */
function TriCheckbox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="row" style={{ margin: 0, color: "var(--text)", fontSize: 13 }}>
      <input
        type="checkbox"
        checked={value === true}
        // An indeterminate box is how a mixed selection says so without lying in either
        // direction; a plain unchecked box would read as "none of these are sit-stand".
        ref={(element) => {
          if (element) element.indeterminate = value === undefined;
        }}
        onChange={(event) => onChange(event.target.checked)}
        style={{ width: "auto" }}
      />
      {label}
    </label>
  );
}

export function Inspector({
  selection,
  zones,
  activeZone,
  groups,
  onPatch,
  onPatchAttributes,
  onDelete,
  onPatchZone,
  onDeleteZone,
}: Props) {
  const single = selection.length === 1 ? selection[0] : null;
  const kind = common(selection.map((r) => r.kind));
  const bookable = common(selection.map((r) => r.bookable));
  const zoneKey = common(selection.map((r) => r.zone_key));
  const capacity = common(selection.map((r) => r.capacity));
  const flags = kind === "room" ? ROOM_FLAGS : DESK_FLAGS;

  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--panel)",
        padding: 14,
        overflowY: "auto",
      }}
    >
      {activeZone ? (
        <section className="stack" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Zone</h3>
          <div>
            <label htmlFor="zone-name">Name</label>
            <input
              id="zone-name"
              type="text"
              value={activeZone.name}
              onChange={(event) => onPatchZone(activeZone.key, { name: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="zone-color">Colour</label>
            <input
              id="zone-color"
              type="color"
              value={activeZone.color ?? "#4f7df3"}
              onChange={(event) => onPatchZone(activeZone.key, { color: event.target.value })}
              style={{ width: 60, height: 30, padding: 2 }}
            />
          </div>

          <div>
            <label>Who can book inside it (FR-6.4)</label>
            {activeZone.permissions.length === 0 ? (
              <p className="muted small" style={{ margin: "4px 0" }}>
                Open to everyone.
              </p>
            ) : null}
            {activeZone.permissions.map((permission, index) => (
              <div key={index} className="stack" style={{ marginBottom: 8 }}>
                <select
                  value={permission.group_id}
                  onChange={(event) =>
                    onPatchZone(activeZone.key, {
                      permissions: activeZone.permissions.map((p, i) =>
                        i === index ? { ...p, group_id: event.target.value } : p,
                      ),
                    })
                  }
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <select
                  value={permission.mode}
                  onChange={(event) =>
                    onPatchZone(activeZone.key, {
                      permissions: activeZone.permissions.map((p, i) =>
                        i === index
                          ? { ...p, mode: event.target.value as ZonePermissionMode }
                          : p,
                      ),
                    })
                  }
                >
                  {MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </select>
                <button
                  className="danger"
                  onClick={() =>
                    onPatchZone(activeZone.key, {
                      permissions: activeZone.permissions.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove rule
                </button>
              </div>
            ))}
            <button
              disabled={groups.length === 0}
              title={groups.length === 0 ? "No groups exist yet" : undefined}
              onClick={() =>
                onPatchZone(activeZone.key, {
                  permissions: [
                    ...activeZone.permissions,
                    { group_id: groups[0].id, mode: "exclusive", opens_at_local: null },
                  ],
                })
              }
            >
              Add rule
            </button>
          </div>

          <button className="danger" onClick={() => onDeleteZone(activeZone.key)}>
            Delete zone
          </button>
        </section>
      ) : null}

      <section className="stack">
        <h3 style={{ margin: 0, fontSize: 14 }}>
          {selection.length === 0
            ? "Nothing selected"
            : single
              ? single.code
              : `${selection.length} selected`}
        </h3>

        {selection.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Click a desk, drag a marquee, or use the Grid tool to lay out a block at
            once.
          </p>
        ) : null}

        {single ? (
          <>
            <div>
              <label htmlFor="code">Code</label>
              <input
                id="code"
                type="text"
                value={single.code}
                onChange={(event) => onPatch({ code: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="name">Name (optional)</label>
              <input
                id="name"
                type="text"
                value={single.name ?? ""}
                placeholder={single.kind === "room" ? "Ada" : ""}
                onChange={(event) => onPatch({ name: event.target.value || null })}
              />
            </div>
          </>
        ) : null}

        {selection.length > 0 ? (
          <>
            <div>
              <label htmlFor="kind">Type</label>
              <select
                id="kind"
                value={kind ?? ""}
                onChange={(event) =>
                  onPatch({ kind: event.target.value as LayoutResource["kind"] })
                }
              >
                {kind === undefined ? <option value="">mixed</option> : null}
                <option value="desk">Desk</option>
                <option value="room">Room</option>
              </select>
            </div>

            {kind === "room" ? (
              <div>
                <label htmlFor="capacity">Seats</label>
                <input
                  id="capacity"
                  type="number"
                  min={1}
                  max={500}
                  value={capacity ?? ""}
                  placeholder={capacity === undefined ? "mixed" : undefined}
                  onChange={(event) => onPatch({ capacity: Number(event.target.value) || 1 })}
                />
              </div>
            ) : null}

            <div>
              <label htmlFor="zone">Zone</label>
              <select
                id="zone"
                value={zoneKey ?? ""}
                onChange={(event) => onPatch({ zone_key: event.target.value || null })}
              >
                {zoneKey === undefined ? <option value="">mixed</option> : null}
                <option value="">No zone</option>
                {zones.map((zone) => (
                  <option key={zone.key} value={zone.key}>
                    {zone.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <label style={{ marginBottom: 0 }}>Attributes</label>
              {flags.map(([key, label]) => (
                <TriCheckbox
                  key={key}
                  label={label}
                  value={common(selection.map((r) => r.attributes[key] === true))}
                  onChange={(next) => onPatchAttributes({ [key]: next })}
                />
              ))}
            </div>

            {kind !== "room" ? (
              <>
                <div>
                  <label htmlFor="monitors">Monitors</label>
                  <input
                    id="monitors"
                    type="number"
                    min={0}
                    max={6}
                    value={String(common(selection.map((r) => r.attributes.monitors)) ?? "")}
                    placeholder="mixed"
                    onChange={(event) =>
                      onPatchAttributes({ monitors: Number(event.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <label htmlFor="dock">Dock</label>
                  <select
                    id="dock"
                    value={String(common(selection.map((r) => r.attributes.dock)) ?? "")}
                    onChange={(event) => onPatchAttributes({ dock: event.target.value })}
                  >
                    {common(selection.map((r) => r.attributes.dock)) === undefined ? (
                      <option value="">mixed</option>
                    ) : null}
                    {DOCKS.map((dock) => (
                      <option key={dock} value={dock}>
                        {dock.replace("_", "-")}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}

            <div className="stack" style={{ gap: 6 }}>
              <TriCheckbox
                label="Bookable"
                value={bookable}
                onChange={(next) =>
                  onPatch({
                    bookable: next,
                    // Clearing the reason with the flag keeps the two from disagreeing,
                    // which is what would otherwise show "out of service: broken
                    // monitor" on a desk that is bookable again.
                    out_of_service_reason: next ? null : single?.out_of_service_reason ?? null,
                  })
                }
              />
              {bookable === false ? (
                <div>
                  <label htmlFor="reason">Out of service because</label>
                  <input
                    id="reason"
                    type="text"
                    value={single?.out_of_service_reason ?? ""}
                    placeholder="Broken monitor arm"
                    onChange={(event) =>
                      onPatch({ out_of_service_reason: event.target.value || null })
                    }
                  />
                  <p className="warn small" style={{ marginBottom: 0 }}>
                    Publishing this cancels any future bookings on it, and tells the
                    people who lose them.
                  </p>
                </div>
              ) : null}
            </div>

            <button className="danger" onClick={onDelete}>
              Delete {selection.length === 1 ? single?.code : `${selection.length} resources`}
            </button>
          </>
        ) : null}
      </section>
    </aside>
  );
}
