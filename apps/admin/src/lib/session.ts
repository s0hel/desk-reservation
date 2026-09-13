/**
 * The console's session (TDD §14.1: "auth reuses the API's OIDC flow with a browser
 * session cookie").
 *
 * Tokens live in httpOnly cookies and never reach browser JavaScript. Every call the
 * browser makes goes through `/api/proxy`, which attaches the bearer token server-side.
 * The console therefore has no credential to leak through an XSS in the editor — which
 * matters more here than in the mobile app, because this is the surface that can
 * rewrite a floor and cancel other people's bookings.
 *
 * Phase 0's dev-login stands in for OIDC. The cookie shape does not depend on which
 * one minted the token, so swapping in the real flow is a change to `/api/session`
 * alone.
 */

import { cookies } from "next/headers";

export const ACCESS_COOKIE = "deskflow_admin_access";
export const REFRESH_COOKIE = "deskflow_admin_refresh";
export const IDENTITY_COOKIE = "deskflow_admin_identity";

/** What the console shows about who is signed in. Not a credential. */
export type Identity = {
  email: string;
  display_name: string;
  roles: string[];
  organization_id: string;
};

export const ADMIN_ROLES = ["site_admin", "org_admin"] as const;

export function isAdmin(identity: Identity | null): boolean {
  return !!identity?.roles.some((role) => (ADMIN_ROLES as readonly string[]).includes(role));
}

export async function getAccessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS_COOKIE)?.value ?? null;
}

export async function getIdentity(): Promise<Identity | null> {
  const raw = (await cookies()).get(IDENTITY_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Identity;
  } catch {
    // A malformed cookie is a signed-out user, not a crash.
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  // Secure is skipped on http://localhost only — a Secure cookie is simply not stored
  // there, which would make the console impossible to use in development.
  secure: process.env.NODE_ENV === "production",
};

/** The identity cookie is readable by the client so the header can render without a
 *  round trip. It carries no token, only who you are. */
export const identityCookieOptions = { ...cookieOptions, httpOnly: false };
