/**
 * Server-side API access. The only module that knows the API's address.
 *
 * Two callers: React Server Components rendering a page, and the route handlers under
 * `src/app/api`. The browser never calls the API directly — see `client.ts`.
 */

import "server-only";

import { ProblemError, type Violation } from "@/lib/types";

export const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8000";

type Json = Record<string, unknown>;

async function toProblem(response: Response): Promise<ProblemError> {
  let body: Json = {};
  try {
    body = (await response.json()) as Json;
  } catch {
    // A proxy or a crash can return HTML. Do not let that become a parse error that
    // hides the status code the caller actually needs.
  }
  return new ProblemError(
    response.status,
    (body.title as string) ?? response.statusText,
    (body.detail as string) ?? "",
    (body.violations as Violation[]) ?? [],
  );
}

export async function apiFetch(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    // The console is a live admin tool: a cached floor layout is a floor someone is
    // about to edit from stale data.
    cache: "no-store",
  });
}

export async function apiJson<T>(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const response = await apiFetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw await toProblem(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
