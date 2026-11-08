import { describe, expect, test } from "vitest";

/**
 * RT-455 part 1: the pure helpers of the tracked-selling switch. Roles mirror
 * the contract (OD-T2, OD-T6); reads and commands are classified from the
 * server's answer; the tracking pages show only on a confirmed "on" (OD-T4).
 */
import {
  PRECONDITIONS,
  PRECONDITIONS_UNMET,
  canReadTrackedSelling,
  classifyRead,
  classifyWrite,
  preconditionKey,
  showPreconditionWarning,
  trackedSellingOn,
  trackedSellingViewFor,
} from "@/tracked-selling/trackedSellingLogic";

const setting = {
  enabled: true,
  changedAt: "2026-11-08T18:00:00Z",
  changedBy: "0190f000-0000-7000-8000-0000000000c1",
  preconditionsMet: true,
  unmetPreconditions: [],
};

describe("roles", () => {
  test.each([
    ["owner", true, "manage"],
    ["tenant_admin", true, "manage"],
    ["store_manager", true, "status"],
    ["cashier", false, undefined],
    ["store_staff", false, undefined],
    [null, false, undefined],
  ] as const)("%s: read %s, view %s", (role, read, view) => {
    expect(canReadTrackedSelling(role)).toBe(read);
    expect(trackedSellingViewFor(role)).toBe(view);
  });
});

describe("read", () => {
  test("200 with the contract's shape is ok; 404 is the gate", () => {
    expect(classifyRead({ status: 200, data: setting })).toEqual({ kind: "ok", setting });
    expect(classifyRead({ status: 404 })).toEqual({ kind: "unavailable" });
  });

  test("a 200 without the shape is a failed read, never off", () => {
    expect(classifyRead({ status: 200, data: {} })).toEqual({
      kind: "error",
      status: 0,
      requestId: undefined,
    });
  });

  test("other statuses are errors with the request id", () => {
    expect(
      classifyRead({ status: 500, error: { error: { code: "x", request_id: "req_1" } } }),
    ).toEqual({ kind: "error", status: 500, requestId: "req_1" });
  });

  test("the pages show only on a confirmed on (OD-T4)", () => {
    expect(trackedSellingOn({ kind: "ok", setting })).toBe(true);
    expect(trackedSellingOn({ kind: "ok", setting: { ...setting, enabled: false } })).toBe(false);
    expect(trackedSellingOn({ kind: "unavailable" })).toBe(false);
    expect(trackedSellingOn({ kind: "error", status: 500 })).toBe(false);
    expect(trackedSellingOn(undefined)).toBe(false);
  });

  test("OD-T7 warning: on with preconditionsMet false only", () => {
    expect(showPreconditionWarning({ ...setting, preconditionsMet: false })).toBe(true);
    expect(showPreconditionWarning(setting)).toBe(false);
    expect(showPreconditionWarning({ ...setting, enabled: false, preconditionsMet: false })).toBe(
      false,
    );
    // A store_manager's null is not a warning.
    expect(showPreconditionWarning({ ...setting, preconditionsMet: null })).toBe(false);
  });
});

describe("preconditions", () => {
  test("every contract precondition has a plain-words label; others have none", () => {
    for (const code of PRECONDITIONS) {
      expect(preconditionKey(code)).toBe(`trackedSelling.precondition.${code}`);
    }
    expect(preconditionKey("hasOwnProperty")).toBeUndefined();
    expect(preconditionKey("new_condition")).toBeUndefined();
  });
});

describe("write", () => {
  test("200 is saved with the server's setting", () => {
    expect(classifyWrite({ status: 200, data: setting })).toEqual({ kind: "saved", setting });
  });

  test("409 tracked_selling_preconditions_unmet is unmet", () => {
    expect(
      classifyWrite({
        status: 409,
        error: { error: { code: PRECONDITIONS_UNMET, request_id: "req_2" } },
      }),
    ).toEqual({ kind: "unmet", requestId: "req_2" });
  });

  test("another 409 is a plain refusal with its code", () => {
    expect(classifyWrite({ status: 409, error: { error: { code: "other_conflict" } } })).toEqual({
      kind: "rejected",
      status: 409,
      code: "other_conflict",
      requestId: undefined,
    });
  });

  test("404, 403 and 429", () => {
    expect(classifyWrite({ status: 404 })).toEqual({ kind: "unavailable" });
    expect(classifyWrite({ status: 403 }).kind).toBe("forbidden");
    expect(classifyWrite({ status: 401 })).toEqual({ kind: "sessionExpired" });
    expect(classifyWrite({ status: 429, retryAfter: 12 })).toEqual({
      kind: "rateLimited",
      retryAfter: 12,
    });
  });

  test("a 5xx or a 200 without the shape leaves the outcome unknown", () => {
    expect(classifyWrite({ status: 503 })).toEqual({ kind: "failed" });
    expect(classifyWrite({ status: 200, data: null })).toEqual({ kind: "failed" });
  });
});
