/**
 * Sign in and out of the console.
 *
 * POST exchanges an email for a token pair and stores it in httpOnly cookies; the
 * browser never sees the token (see `lib/session.ts`). Phase 0 uses the API's dev-login
 * endpoint, which is gated to development on the server side; the real flow is OIDC
 * with the API as relying party (TDD §12.1), and it replaces this handler alone.
 *
 * Being an admin is checked here as a courtesy, so the console can say "this account is
 * not an admin" rather than showing an empty page that 403s on every call. It is not
 * the control: every admin endpoint independently requires the role (`require_role` in
 * `app/api/v1/admin.py`), and a forged identity cookie buys nothing.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { apiJson } from "@/lib/api";
import {
  ACCESS_COOKIE,
  IDENTITY_COOKIE,
  REFRESH_COOKIE,
  cookieOptions,
  identityCookieOptions,
  isAdmin,
  type Identity,
} from "@/lib/session";
import { ProblemError } from "@/lib/types";

type TokenPair = { access_token: string; refresh_token: string; expires_in?: number };

export async function POST(request: Request) {
  const { email } = (await request.json()) as { email?: string };
  if (!email) {
    return NextResponse.json(
      { title: "Email required", status: 422, violations: [{ code: "auth.email_required" }] },
      { status: 422 },
    );
  }

  let pair: TokenPair;
  try {
    pair = await apiJson<TokenPair>("/v1/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  } catch (error) {
    if (error instanceof ProblemError) {
      return NextResponse.json(
        { title: error.title, status: error.status, detail: error.detail, violations: error.violations },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { title: "Could not reach the API", status: 502, violations: [{ code: "auth.api_unreachable" }] },
      { status: 502 },
    );
  }

  const me = await apiJson<Identity & { id: string }>("/v1/me", { token: pair.access_token });
  const identity: Identity = {
    email: me.email,
    display_name: me.display_name,
    roles: me.roles,
    organization_id: me.organization_id,
  };

  if (!isAdmin(identity)) {
    return NextResponse.json(
      {
        title: "Not permitted",
        status: 403,
        detail: `${me.email} is not a site or organization admin`,
        violations: [{ code: "auth.not_admin", params: { roles: me.roles } }],
      },
      { status: 403 },
    );
  }

  const jar = await cookies();
  jar.set(ACCESS_COOKIE, pair.access_token, cookieOptions);
  jar.set(REFRESH_COOKIE, pair.refresh_token, cookieOptions);
  jar.set(IDENTITY_COOKIE, JSON.stringify(identity), identityCookieOptions);
  return NextResponse.json({ identity });
}

export async function DELETE() {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, IDENTITY_COOKIE]) jar.delete(name);
  return new NextResponse(null, { status: 204 });
}
