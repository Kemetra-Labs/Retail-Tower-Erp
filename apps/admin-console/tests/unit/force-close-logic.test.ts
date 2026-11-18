/**
 * RT-1440 (U1): the client-side gates of the close-without-a-count action. They only HIDE the
 * control (AC4); the server stays authoritative and answers 404 or 403 to anyone else (D1).
 */
import {
  REASON_MAX,
  canForceClose,
  commitReady,
  effectKeys,
  hasUnknownEffect,
  reasonProblem,
} from "@/force-actions/forceCloseLogic";
import { describe, expect, it } from "vitest";

describe("canForceClose", () => {
  it("is offered to owner and tenant_admin who are not platform admins", () => {
    expect(canForceClose("owner", false, false)).toBe(true);
    expect(canForceClose("tenant_admin", false, false)).toBe(true);
  });

  it("is hidden from every other role, an unknown role and no role at all", () => {
    for (const role of [
      "store_manager",
      "store_staff",
      "cashier",
      "platform_admin",
      "x",
      "",
      undefined,
      null,
    ]) {
      expect(canForceClose(role, false, false)).toBe(false);
    }
  });

  it("is hidden inside a support session for a caller who is not a platform admin", () => {
    expect(canForceClose("owner", true, false)).toBe(false);
    expect(canForceClose("tenant_admin", true, false)).toBe(false);
  });

  // RT-1462 (owner decision 2026-11-18): the server admits a platform admin whatever their role in
  // the tenant, with or without a support session, so the control follows.
  it("is offered to a platform admin whatever the membership role, or none", () => {
    for (const role of [
      "owner",
      "tenant_admin",
      "store_manager",
      "store_staff",
      "",
      "x",
      undefined,
      null,
    ]) {
      expect(canForceClose(role, false, true)).toBe(true);
    }
  });

  it("is offered to a platform admin inside a support session too", () => {
    expect(canForceClose(null, true, true)).toBe(true);
    expect(canForceClose("owner", true, true)).toBe(true);
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
  const ready = {
    eligible: true,
    reason: "till died",
    acknowledged: true,
    pending: false,
    fetching: false,
  };

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
    expect(
      effectKeys("willChange", ["shift_closed_not_counted", "timezone_change_unblocked"]),
    ).toEqual([
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

describe("hasUnknownEffect", () => {
  it("is true only when the server lists an effect code this build does not know", () => {
    expect(hasUnknownEffect("willChange", ["shift_closed_not_counted"])).toBe(false);
    expect(hasUnknownEffect("willChange", ["shift_closed_not_counted", "brand_new_change"])).toBe(
      true,
    );
  });
});

describe("commitReady while the preview is being read again", () => {
  it("waits for the new preview, so a commit cannot go out against the old one", () => {
    expect(
      commitReady({
        eligible: true,
        reason: "x",
        acknowledged: true,
        pending: false,
        fetching: true,
      }),
    ).toBe(false);
    expect(
      commitReady({
        eligible: true,
        reason: "x",
        acknowledged: true,
        pending: false,
        fetching: false,
      }),
    ).toBe(true);
  });
});
