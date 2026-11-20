import {
  classifyRepair,
  isFinishedRepair,
  keepsRepairKey,
  refusedReasonKey,
} from "@/sale-quarantine/repairLogic";
import { describe, expect, test } from "vitest";
import { REQUEST_ID, SALE, failure, quarantined } from "./sale-quarantine-fixtures";

const last = (outcome: string, httpStatus: number | null, errorCode: string | null) =>
  ({ at: "2026-11-19T11:00:00Z", outcome, httpStatus, errorCode }) as never;

describe("classifyRepair: a 200 is read through the item's lastRepair", () => {
  test.each(["captured", "already-captured"] as const)("%s says a sale exists", (outcome) => {
    const item = quarantined({
      state: outcome,
      saleRef: SALE,
      lastRepair: last(outcome, null, null),
    });
    expect(classifyRepair({ status: 200, data: item })).toEqual({ kind: outcome, item });
  });

  test("refused keeps the item and explains why", () => {
    const item = quarantined({ lastRepair: last("refused", 422, "sale_line_pricing_invalid") });
    expect(classifyRepair({ status: 200, data: item })).toEqual({
      kind: "refused",
      item,
      messageKey: "saleQuarantine.repair.refused.generic",
    });
  });

  test.each([
    [last("refused", null, "repair_operator_unproven"), "saleQuarantine.repair.refused.operator"],
    [last("refused", 409, "idempotency_key_conflict"), "saleQuarantine.repair.refused.diverged"],
    [last("refused", 404, "not_found"), "saleQuarantine.repair.refused.otherStore"],
    [
      last("refused", 403, "sale_responsibility_role_refused"),
      "saleQuarantine.repair.refused.generic",
    ],
    [null, "saleQuarantine.repair.refused.generic"],
  ])("the reason for %j", (lastRepair, key) => {
    expect(refusedReasonKey(quarantined({ lastRepair }))).toBe(key);
  });

  test("no outcome, an unknown outcome or no item is never read as recorded: not confirmed", () => {
    for (const data of [
      quarantined({ lastRepair: null }),
      quarantined({ lastRepair: last("something-new", null, null) }),
      undefined,
    ]) {
      expect(classifyRepair({ status: 200, data }).kind).toBe("unconfirmed");
    }
  });
});

describe("classifyRepair: refusals by status and code", () => {
  test.each([
    [400, undefined, "rejected"],
    [401, undefined, "session"],
    [403, undefined, "forbidden"],
    [403, "origin_rejected", "forbidden"],
    [404, "not_found", "not-found"],
    [409, "repair_conflict", "conflict"],
    [409, "idempotency_key_conflict", "key-conflict"],
    [422, "anything", "rejected"],
    [500, undefined, "unconfirmed"],
    [503, undefined, "unconfirmed"],
    [408, undefined, "unconfirmed"],
    [425, undefined, "unconfirmed"],
    [0, undefined, "unconfirmed"],
  ])("%s %s is %s", (status, code, kind) => {
    const result = classifyRepair({ ...(code ? failure(status, code) : { status }) });
    expect(result.kind).toBe(kind);
  });

  test("the request id is kept for support", () => {
    const outcome = classifyRepair(failure(409, "repair_conflict"));
    expect(outcome).toMatchObject({ kind: "conflict", requestId: REQUEST_ID });
  });

  test("a 429 carries the wait", () => {
    expect(classifyRepair(failure(429, "rate_limited", 30))).toMatchObject({
      kind: "rate-limited",
      messageKey: "saleQuarantine.repair.error.rateLimitedFor",
      retryAfter: 30,
    });
    expect(classifyRepair({ status: 429 })).toMatchObject({
      messageKey: "saleQuarantine.repair.error.rateLimited",
    });
  });
});

describe("the key and the dialog", () => {
  test("only unconfirmed and rate-limited attempts keep the key", () => {
    expect(keepsRepairKey(classifyRepair({ status: 503 }))).toBe(true);
    expect(keepsRepairKey(classifyRepair({ status: 429 }))).toBe(true);
    expect(keepsRepairKey(classifyRepair(failure(400, "validation_error")))).toBe(false);
    expect(
      keepsRepairKey(
        classifyRepair({
          status: 200,
          data: quarantined({ lastRepair: last("captured", null, null) }),
        }),
      ),
    ).toBe(false);
  });

  test("the dialog is finished after an answer that leaves nothing to send", () => {
    const finished = [
      classifyRepair({
        status: 200,
        data: quarantined({ lastRepair: last("captured", null, null) }),
      }),
      classifyRepair({ status: 200, data: quarantined({ lastRepair: last("refused", 422, "x") }) }),
      classifyRepair(failure(409, "repair_conflict")),
      classifyRepair(failure(404, "not_found")),
    ];
    for (const outcome of finished) expect(isFinishedRepair(outcome)).toBe(true);
    for (const outcome of [classifyRepair({ status: 503 }), classifyRepair(failure(400, "x"))]) {
      expect(isFinishedRepair(outcome)).toBe(false);
    }
    expect(isFinishedRepair(undefined)).toBe(false);
  });
});
