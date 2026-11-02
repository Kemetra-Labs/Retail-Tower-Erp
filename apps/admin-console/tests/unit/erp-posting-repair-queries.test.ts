import { beforeEach, describe, expect, test, vi } from "vitest";

const POST = vi.fn();
vi.mock("@/generated/client", () => ({
  apiClient: { POST: (...a: unknown[]) => POST(...a) },
}));

import { IDEMPOTENCY_IN_PROGRESS_STATUS, repairPosting } from "@/lib/erp-posting-repair-queries";

const WORK_ITEM = "0190f000-0000-7000-8000-0000000009a1";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";

function response(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

/**
 * RT-1072 wrapper over `repairPosting`. RT-977 §10: the 425 `idempotency_in_progress`
 * answer is not declared in `reconciliation.yaml`, so this proves the wrapper can
 * branch on it and read its `Retry-After`.
 */
describe("repairPosting wrapper (RT-1072)", () => {
  beforeEach(() => POST.mockReset());

  test("posts to the handle's path with the Idempotency-Key and an empty body", async () => {
    const data = { outcome: "eligible_again" };
    POST.mockResolvedValue({ data, response: response(201) });
    const res = await repairPosting(WORK_ITEM, KEY);
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair",
      {
        params: { path: { workItemRef: WORK_ITEM }, header: { "Idempotency-Key": KEY } },
        body: {},
      },
    );
    expect(res).toEqual({ status: 201, data, error: undefined, retryAfter: undefined });
  });

  test("a 425 (undeclared) is returned as itself, with its Retry-After seconds", async () => {
    const error = { error: { code: "idempotency_in_progress" } };
    POST.mockResolvedValue({ error, response: response(425, { "Retry-After": "2" }) });
    const res = await repairPosting(WORK_ITEM, KEY);
    expect(IDEMPOTENCY_IN_PROGRESS_STATUS).toBe(425);
    expect(res).toEqual({ status: 425, data: undefined, error, retryAfter: 2 });
  });

  test("a 429 carries its Retry-After; other answers carry none", async () => {
    POST.mockResolvedValue({ error: {}, response: response(429, { "Retry-After": "7" }) });
    expect((await repairPosting(WORK_ITEM, KEY)).retryAfter).toBe(7);
    POST.mockResolvedValue({ error: {}, response: response(404, { "Retry-After": "7" }) });
    expect((await repairPosting(WORK_ITEM, KEY)).retryAfter).toBeUndefined();
  });
});
