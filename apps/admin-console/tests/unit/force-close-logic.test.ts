/**
 * RT-1440 (U1): the client-side gates of the close-without-a-count action. They only HIDE the
 * control (AC4); the server stays authoritative and answers 404 or 403 to anyone else (D1).
 */
import {
  REASON_MAX,
  canForceClose,
  commitReady,
  effectKeys,
  reasonProblem,
} from "@/force-actions/forceCloseLogic";
import { describe, expect, it } from "vitest";

describe("canForceClose", () => {
  it("is offered to owner and tenant_admin", () => {
    expect(canForceClose("owner", false)).toBe(true);
    expect(canForceClose("tenant_admin", false)).toBe(true);
  });

  it("is hidden from every other role, an unknown role and no role at all", () => {
    for (const role of ["store_manager", "store_staff", "cashier", "platform_admin", "x", "", undefined, null]) {
      expect(canForceClose(role, false)).toBe(false);
    }
  });

  it("is hidden inside a support session, whatever the role (read-only by construction)", () => {
    expect(canForceClose("owner", true)).toBe(false);
    expect(canForceClose("tenant_admin", true)).toBe(false);
  });
});

describe("reasonProblem", () => {
  it("requires a reason", () => {
    expect(reasonProblem("")).toBe("forceActions.close.reason.required");
    expect(reasonProblem("   \n ")).toBe("forceActions.close.reason.required");
  });

  it("accepts 1 to 200 characters after trimming, and refuses 201", () => {
    expect(reasonProblem("a")).toBeNull();
    expect(reasonProblem(` ${"a".repeat(REASON_MAX)} `)).toBeNull();
    expect(reasonProblem("a".repeat(REASON_MAX + 1))).toBe("forceActions.close.reason.tooLong");
  });
});

describe("commitReady", () => {
  const ready = { eligible: true, reason: "till died", acknowledged: true, pending: false };

  it("needs an eligible verdict, a valid reason, the acknowledgement and no request in flight", () => {
    expect(commitReady(ready)).toBe(true);
    expect(commitReady({ ...ready, eligible: false })).toBe(false);
    expect(commitReady({ ...ready, reason: " " })).toBe(false);
    expect(commitReady({ ...ready, acknowledged: false })).toBe(false);
    expect(commitReady({ ...ready, pending: true })).toBe(false);
  });
});

describe("effectKeys", () => {
  it("maps the server's closed effect lists to catalog keys, in order", () => {
    expect(effectKeys("willChange", ["shift_closed_not_counted", "timezone_change_unblocked"])).toEqual([
      "forceActions.close.effect.willChange.shift_closed_not_counted",
      "forceActions.close.effect.willChange.timezone_change_unblocked",
    ]);
  });

  it("an effect code this build does not know is dropped, never shown raw", () => {
    expect(effectKeys("willNotChange", ["sales_unchanged", "brand_new_effect"])).toEqual([
      "forceActions.close.effect.willNotChange.sales_unchanged",
    ]);
  });
});
