import { beforeEach, describe, expect, test, vi } from "vitest";

const GET = vi.fn();
vi.mock("@/generated/client", () => ({
  apiClient: { GET: (...a: unknown[]) => GET(...a) },
}));

import { consoleGetSalesByStore, mapSalesByStoreError } from "@/lib/sales-by-store-queries";

const REQUEST_ID = "0190f000-0000-7000-8000-0000000000b2";
const QUERY = { from: "2026-10-01", to: "2026-10-07", currency: "EGP", compare: "none" } as const;

function envelope(code: string) {
  return { error: { code, message: "x", request_id: REQUEST_ID } };
}

describe("consoleGetSalesByStore wrapper (RT-1054)", () => {
  beforeEach(() => GET.mockReset());

  test("calls GET /api/v1/sales-by-store with the query and returns the uniform shape", async () => {
    const data = { storeCount: 0 };
    GET.mockResolvedValue({ data, response: { status: 200 } });
    const res = await consoleGetSalesByStore(QUERY);
    expect(GET).toHaveBeenCalledWith("/api/v1/sales-by-store", { params: { query: QUERY } });
    expect(res).toEqual({ status: 200, data, error: undefined });
  });

  test("passes a refusal through as status + error", async () => {
    const error = envelope("not_found");
    GET.mockResolvedValue({ error, response: { status: 404 } });
    expect(await consoleGetSalesByStore(QUERY)).toEqual({ status: 404, data: undefined, error });
  });
});

describe("mapSalesByStoreError", () => {
  test("400 scope_too_large is told apart by its stable code", () => {
    expect(
      mapSalesByStoreError({ status: 400, error: envelope("scope_too_large"), query: QUERY }),
    ).toEqual({ kind: "scope-too-large", requestId: REQUEST_ID });
  });

  test("400 on a reversed or too-wide range is a range problem, told by the request that was sent", () => {
    expect(
      mapSalesByStoreError({
        status: 400,
        error: envelope("validation_error"),
        query: { ...QUERY, from: "2026-10-07", to: "2026-10-01" },
      }),
    ).toEqual({ kind: "range", problem: "to-before-from", requestId: REQUEST_ID });
    expect(
      mapSalesByStoreError({
        status: 400,
        error: envelope("validation_error"),
        query: { ...QUERY, to: "2026-12-01" },
      }),
    ).toEqual({ kind: "range", problem: "range-too-wide", requestId: REQUEST_ID });
  });

  test("any other 400 is a field problem", () => {
    expect(
      mapSalesByStoreError({ status: 400, error: envelope("validation_error"), query: QUERY }),
    ).toEqual({ kind: "field", requestId: REQUEST_ID });
    expect(mapSalesByStoreError({ status: 400 })).toEqual({ kind: "field", requestId: undefined });
  });

  test("404 is non-disclosing: no request id, no cause", () => {
    expect(mapSalesByStoreError({ status: 404, error: envelope("not_found") })).toEqual({
      kind: "not-found",
    });
  });

  test("429 is the shared rate-limit banner's", () => {
    expect(mapSalesByStoreError({ status: 429, error: envelope("rate_limited") })).toEqual({
      kind: "rate-limited",
    });
  });

  test("5xx is retryable and carries the request id", () => {
    expect(mapSalesByStoreError({ status: 503, error: envelope("system_failure") })).toEqual({
      kind: "server",
      messageKey: "errors.server",
      requestId: REQUEST_ID,
      retryable: true,
    });
  });

  test("401 and an undocumented status are the generic error", () => {
    expect(mapSalesByStoreError({ status: 401 })).toEqual({
      kind: "generic",
      messageKey: "errors.generic",
      requestId: undefined,
    });
    expect(mapSalesByStoreError({ status: 418 }).kind).toBe("generic");
  });
});
