/**
 * The API client is the only module allowed to call fetch (TDD §13.1), which makes its
 * error translation the single place a problem+json response becomes something the UI
 * can act on.
 */

import { ProblemError, api, newIdempotencyKey } from "../api";

const TOKEN = "test-token";

function mockFetch(status: number, body: unknown, capture?: (init: RequestInit) => void) {
  return jest.fn(async (_url: string, init: RequestInit) => {
    capture?.(init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    } as Response;
  });
}

afterEach(() => jest.restoreAllMocks());

describe("error translation", () => {
  it("turns a policy refusal into a ProblemError carrying its violations", async () => {
    globalThis.fetch = mockFetch(422, {
      title: "Booking not permitted",
      detail: "Booking exceeds the horizon",
      violations: [
        { code: "policy.horizon_exceeded", params: { max_days: 14 }, severity: "block" },
      ],
    }) as never;

    await expect(
      api.createBooking(TOKEN, { resource_id: "r", local_date: "2027-01-01" }, "k"),
    ).rejects.toMatchObject({
      status: 422,
      violations: [expect.objectContaining({ code: "policy.horizon_exceeded" })],
    });
  });

  it("surfaces a 409 so the UI can distinguish losing a race from being refused", async () => {
    globalThis.fetch = mockFetch(409, {
      title: "Resource is no longer available",
      detail: "taken",
      violations: [{ code: "resource.unavailable", params: {}, severity: "block" }],
    }) as never;

    const error = await api
      .createBooking(TOKEN, { resource_id: "r", local_date: "2026-09-14" }, "k")
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error.status).toBe(409);
  });

  it("does not choke on a non-JSON error body", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new SyntaxError("not json");
      },
    })) as never;

    const error = await api.sites(TOKEN).catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error.status).toBe(502);
    expect(error.violations).toEqual([]);
  });
});

describe("request shape", () => {
  it("sends the bearer token on authenticated calls", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = mockFetch(200, [], (init) => (seen = init)) as never;
    await api.sites(TOKEN);
    expect((seen?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the idempotency key so a retry replays instead of double-booking", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = mockFetch(200, {}, (init) => (seen = init)) as never;
    await api.createBooking(TOKEN, { resource_id: "r", local_date: "2026-09-14" }, "key-123");
    expect((seen?.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-123");
  });

  it("omits empty query parameters", async () => {
    const fetchMock = mockFetch(200, []);
    globalThis.fetch = fetchMock as never;
    await api.bookings(TOKEN);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/bookings$/);
  });
});

describe("newIdempotencyKey", () => {
  it("produces distinct keys, so separate intents are separate bookings", () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
  });
});
