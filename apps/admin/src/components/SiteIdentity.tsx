/**
 * What the mobile home screen greets somebody with: the place, and a photo of it
 * (FR-2.1).
 *
 * A client component inside the otherwise server-rendered sites page, because both
 * halves are edits and one of them is a file upload. It re-renders from whatever the
 * API answers with — every one of these routes returns the whole site — rather than
 * from optimistic local state, so a refusal leaves the form showing what is true.
 *
 * `router.refresh()` at the end is what keeps the server-rendered page around it
 * honest; without it the floor table above would still show the old name.
 */

"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { describeAdmin } from "@/lib/admin-messages";
import { del, patch, upload } from "@/lib/client";
import { ProblemError, type SiteSummary } from "@/lib/types";

export function SiteIdentity({ site: initial }: { site: SiteSummary }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);

  const [site, setSite] = useState(initial);
  const [shortName, setShortName] = useState(initial.short_name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = shortName.trim() !== (site.short_name ?? "");

  async function run(work: () => Promise<SiteSummary>) {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      setSite(next);
      setShortName(next.short_name ?? "");
      router.refresh();
    } catch (problem) {
      setError(
        problem instanceof ProblemError
          ? describeAdmin(problem)
          : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <Photo site={site} />

        <div style={{ flex: 1 }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label htmlFor={`short-${site.id}`}>Short name</label>
              <input
                id={`short-${site.id}`}
                type="text"
                value={shortName}
                placeholder={site.name}
                onChange={(event) => setShortName(event.target.value)}
              />
            </div>
            <button
              disabled={busy || !dirty}
              onClick={() =>
                run(() =>
                  patch<SiteSummary>(`/v1/admin/sites/${site.id}`, {
                    // Empty means "no short name", not the empty string: the app
                    // falls back to the full name, which is a correct sentence.
                    short_name: shortName.trim() || null,
                  }),
                )
              }
            >
              Save
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            The app greets people with this — “Welcome to {shortName.trim() || site.name},
            Priya”. Leave it empty to use the full site name.
          </p>

          <div className="row" style={{ marginTop: 12 }}>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                // Cleared before the upload, not after: re-picking the same file
                // after a failure fires no change event otherwise.
                event.target.value = "";
                if (chosen) {
                  void run(() =>
                    upload<SiteSummary>(`/v1/admin/sites/${site.id}/photo`, chosen),
                  );
                }
              }}
            />
            <button disabled={busy} onClick={() => file.current?.click()}>
              {busy ? "Working…" : site.photo ? "Replace photo" : "Upload photo"}
            </button>
            {site.photo ? (
              <button
                className="danger"
                disabled={busy}
                onClick={() => run(() => del<SiteSummary>(`/v1/admin/sites/${site.id}/photo`))}
              >
                Remove
              </button>
            ) : null}
            <span className="muted small">JPEG, PNG or WebP. Landscape works best.</span>
          </div>

          {error ? (
            <p className="error" style={{ marginTop: 8 }}>
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The same box whether or not there is a photo, so the row does not jump when one is
 * added — and so "no photo yet" is a visible state rather than an absence.
 */
function Photo({ site }: { site: SiteSummary }) {
  const width = 200;
  const ratio = site.photo?.aspect_ratio && site.photo.aspect_ratio > 0
    ? site.photo.aspect_ratio
    : 16 / 9;

  return (
    <div
      style={{
        width,
        height: Math.round(width / ratio),
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--surface-alt, #f1f0ec)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {site.photo ? (
        // `unoptimized`: the URL carries a short-lived signed token (TDD §11), so
        // Next's image proxy would cache a copy that outlives it and then 404.
        <Image
          src={site.photo.url}
          alt={site.name}
          width={site.photo.width_px}
          height={site.photo.height_px}
          unoptimized
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span className="muted small">No photo</span>
      )}
    </div>
  );
}
