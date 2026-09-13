/**
 * The browser's only route to the API.
 *
 * The editor is a client component and has to call the API as the signed-in admin, but
 * the access token lives in an httpOnly cookie precisely so that client JavaScript
 * cannot read it. This handler is the join: the browser calls `/api/proxy/v1/...`, and
 * the token is attached here, server-side.
 *
 * It forwards only to `/v1/...` — a proxy that will forward anywhere is an SSRF waiting
 * to happen, and it would be reachable by anyone who can load the console.
 */

import { NextResponse } from "next/server";

import { API_BASE_URL } from "@/lib/api";
import { getAccessToken } from "@/lib/session";

const FORWARDED_REQUEST_HEADERS = ["content-type", "idempotency-key"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag"];

async function handler(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;

  // Path segments come from the URL, so they are attacker-controlled. Anchor the
  // forward at /v1 and rebuild the path from segments rather than pasting a string.
  if (path[0] !== "v1") {
    return NextResponse.json({ title: "Not found", status: 404 }, { status: 404 });
  }
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json(
      { title: "Authentication required", status: 401, detail: "No admin session" },
      { status: 401 },
    );
  }

  const target = new URL(`/${path.map(encodeURIComponent).join("/")}`, API_BASE_URL);
  target.search = new URL(request.url).search;

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    // Streaming the body through is what keeps a 25MB plan upload from being buffered
    // in the console's memory on its way past.
    body: hasBody ? request.body : undefined,
    // @ts-expect-error duplex is required by undici for a streamed body and is not yet
    // in the DOM RequestInit types.
    duplex: hasBody ? "half" : undefined,
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
