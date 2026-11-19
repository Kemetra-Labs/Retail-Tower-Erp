import { beforeEach, describe, expect, test, vi } from "vitest";

const GET = vi.fn();
const POST = vi.fn();
vi.mock("@/generated/client", () => ({
  apiClient: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));

import {
  consoleGetQuarantinedSale,
  consoleListQuarantinedSales,
  consoleRepairQuarantinedSale,
  consoleWriteOffQuarantinedSale,
} from "@/lib/sale-quarantine-queries";
import { QUARANTINE_REF, STORE, idempotencyKey } from "./sale-quarantine-fixtures";

function response(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

/**
 * RT-1312 slice B and C Console wrappers: each calls exactly its generated path with
 * the contract's params and returns `{ status, data, error, retryAfter }`.
 */
describe("sale quarantine wrappers", () => {
  beforeEach(() => {
    GET.mockReset();
    POST.mockReset();
  });

  test("consoleListQuarantinedSales passes store_id, state and cursor as query", async () => {
    GET.mockResolvedValue({ data: { items: [], nextCursor: null }, response: response(200) });
    const query = { store_id: STORE, state: "written-off", cursor: QUARANTINE_REF } as const;
    const res = await consoleListQuarantinedSales(query);
    expect(GET).toHaveBeenCalledWith("/api/v1/catalog/sale-sync-ops/quarantined-sales", {
      params: { query },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ items: [], nextCursor: null });
  });

  test("consoleGetQuarantinedSale reads one item by its path ref", async () => {
    const error = { error: { code: "not_found", message: "Not found." } };
    GET.mockResolvedValue({ error, response: response(404) });
    const res = await consoleGetQuarantinedSale(QUARANTINE_REF);
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}",
      { params: { path: { quarantineRef: QUARANTINE_REF } } },
    );
    expect(res.status).toBe(404);
    expect(res.error).toEqual(error);
  });

  test("consoleWriteOffQuarantinedSale posts the note with the Idempotency-Key header", async () => {
    GET.mockReset();
    POST.mockResolvedValue({
      data: { quarantineRef: QUARANTINE_REF },
      response: response(200),
    });
    const key = idempotencyKey("a");
    const res = await consoleWriteOffQuarantinedSale(QUARANTINE_REF, "Refunded in cash", key);
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/write-off",
      {
        params: { path: { quarantineRef: QUARANTINE_REF }, header: { "Idempotency-Key": key } },
        body: { note: "Refunded in cash" },
      },
    );
    expect(res.status).toBe(200);
    expect(GET).not.toHaveBeenCalled();
  });

  test("a 429 carries the server's Retry-After seconds", async () => {
    POST.mockResolvedValue({
      error: { error: { code: "rate_limited" } },
      response: response(429, { "Retry-After": "12" }),
    });
    const res = await consoleWriteOffQuarantinedSale(QUARANTINE_REF, "x", idempotencyKey("b"));
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe(12);
  });

  test("consoleRepairQuarantinedSale posts to the repair path with the key and no body", async () => {
    POST.mockResolvedValue({ data: { quarantineRef: QUARANTINE_REF }, response: response(200) });
    const key = idempotencyKey("c");
    const res = await consoleRepairQuarantinedSale(QUARANTINE_REF, key);
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/repair",
      { params: { path: { quarantineRef: QUARANTINE_REF }, header: { "Idempotency-Key": key } } },
    );
    expect(res.status).toBe(200);
  });
});
