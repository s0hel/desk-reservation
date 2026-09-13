"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { describeAll } from "@/lib/messages";
import type { Violation } from "@/lib/types";

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("dana.okafor@example.com");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string; violations?: Violation[] };
        setError(describeAll(problem.violations ?? [], problem.detail));
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not reach the console's server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "12vh auto", padding: 16 }}>
      <h1 style={{ marginBottom: 4 }}>Deskflow admin</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Sign in with your work email
      </p>

      <form onSubmit={submit} className="card stack">
        <div>
          <label htmlFor="email">Work email address</label>
          <input
            id="email"
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
        {error ? <p className="error small">{error}</p> : null}
      </form>

      <p className="muted small" style={{ marginTop: 20 }}>
        Phase 0 uses the development sign-in endpoint; the real flow is OIDC with the API
        acting as relying party (TDD §12.1). Seeded admins are{" "}
        <code>dana.okafor@example.com</code> (site admin) and{" "}
        <code>sam.vasquez@example.com</code> (organization admin).
      </p>
    </div>
  );
}
