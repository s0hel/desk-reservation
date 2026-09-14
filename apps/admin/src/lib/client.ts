/**
 * Browser-side API access. Everything goes through `/api/proxy`, which attaches the
 * bearer token server-side — no token is ever readable from client JavaScript.
 *
 * The mirror of `apps/mobile/src/lib/api.ts`: one module per client is allowed to call
 * `fetch`, so there is exactly one place that knows the error contract.
 */

"use client";

import { ProblemError, type Violation } from "@/lib/types";

async function toProblem(response: Response): Promise<ProblemError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies happen (a dead proxy, an HTML error page). Keep the status.
  }
  return new ProblemError(
    response.status,
    (body.title as string) ?? response.statusText,
    (body.detail as string) ?? "",
    (body.violations as Violation[]) ?? [],
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/proxy${path}`, init);
  if (!response.ok) throw await toProblem(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/** Multipart upload. No content-type header: the browser has to set the boundary. */
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/proxy${path}`, { method: "POST", body: form });
  if (!response.ok) throw await toProblem(response);
  return (await response.json()) as T;
}

export async function signOut(): Promise<void> {
  await fetch("/api/session", { method: "DELETE" });
}
