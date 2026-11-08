import { tenantNav } from "@/shell/nav-model";
import {
  actorLabel,
  canOpenTracking,
  canReadHolds,
  canReleaseHold,
  checkKey,
  findingProductIds,
  groupFindings,
  holdKindKey,
  reasonKey,
  showTrackingNav,
  tabForKey,
  tabFromSearch,
  tabsFor,
} from "@/tracking/trackingLogic";
import { describe, expect, test } from "vitest";

/**
 * RT-455 pure helpers: the roles mirrored from the contract, the TR-6 nav gate,
 * the TR-5 reason labels, the findings split (TR-8, OD-8) and the tab model.
 */
const P1 = "0190f000-0000-7000-8000-0000000007c1";
const P2 = "0190f000-0000-7000-8000-0000000007c2";

const hold = {
  kind: "active_tracking_hold" as const,
  severity: "critical" as const,
  holdId: "h1",
  holdKind: "quality_hold" as const,
  recallId: null,
  trackingIdentityId: "i1",
  tenantProductRef: P1,
  identityKind: "batch" as const,
  identityCode: "LOT-1",
  expiryDate: null,
  placedAt: "2026-10-30T09:14:00Z",
  storeIds: [],
};
const expired = {
  kind: "expired_lot_sellable" as const,
  severity: "critical" as const,
  trackingIdentityId: "i2",
  tenantProductRef: P2,
  identityKind: "batch" as const,
  identityCode: "LOT-2",
  expiryDate: "2026-10-29",
  storeId: "s1",
  storeBusinessDate: "2026-10-31",
  sellableQuantity: "14",
  stockingUnit: "pcs",
};
const consistency = {
  kind: "tracking_consistency" as const,
  severity: "critical" as const,
  check: "profile_erp_flag_mismatch" as const,
  tenantProductRef: P1,
  trackingIdentityId: null,
  storeId: null,
  stockingUnit: null,
};
const expiring = { ...expired, kind: "expiring_lot" as const, severity: "warning" as const };

describe("tracking roles (RT-455)", () => {
  test.each([
    ["owner", true, true, true],
    ["tenant_admin", true, true, false],
    ["store_manager", true, false, false],
    ["cashier", false, false, false],
    [null, false, false, false],
  ])("%s: open %s, holds %s, release %s", (role, open, holds, release) => {
    expect(canOpenTracking(role)).toBe(open);
    expect(canReadHolds(role)).toBe(holds);
    expect(canReleaseHold(role)).toBe(release);
  });

  test("the nav entry needs the role AND a summary that answered true (TR-6) AND the switch on (OD-T4)", () => {
    expect(showTrackingNav("owner", true, true)).toBe(true);
    expect(showTrackingNav("store_manager", true, true)).toBe(true);
    expect(showTrackingNav("owner", false, true)).toBe(false);
    expect(showTrackingNav("owner", undefined, true)).toBe(false);
    expect(showTrackingNav("cashier", true, true)).toBe(false);
    // RT-455 part 1: off, unknown (loading, failed, the gate's 404) all hide it.
    expect(showTrackingNav("owner", true, false)).toBe(false);
    expect(showTrackingNav("owner", true, undefined)).toBe(false);
  });

  test("tenantNav lists «tracking» after inventory only with both signals", () => {
    const entries = (signal?: boolean, ...rest: [on?: boolean]) =>
      tenantNav("owner", false, {
        hasTrackedProducts: signal,
        trackedSellingOn: rest.length === 0 ? true : rest[0],
      }).flatMap((g) => g.entries.map((e) => e.to));
    expect(entries()).not.toContain("/tracking");
    expect(entries(false)).not.toContain("/tracking");
    expect(entries(true, false)).not.toContain("/tracking");
    expect(entries(true, undefined)).not.toContain("/tracking");
    const shown = entries(true);
    expect(shown.indexOf("/tracking")).toBe(shown.indexOf("/inventory") + 1);
    // A support session lists no tenant destination at all.
    expect(
      tenantNav("owner", true, { hasTrackedProducts: true, trackedSellingOn: true }).flatMap(
        (g) => g.entries,
      ),
    ).not.toContainEqual(expect.objectContaining({ to: "/tracking" }));
  });
});

describe("tracking codes", () => {
  test("the four fixed reasons have labels; any other stored code has none", () => {
    expect(reasonKey("supplier_notice")).toBe("tracking.reason.supplier_notice");
    expect(reasonKey("other")).toBe("tracking.reason.other");
    expect(reasonKey("legacy_code")).toBeUndefined();
    expect(reasonKey("hasOwnProperty")).toBeUndefined();
  });

  test("hold kinds and checks fall back to Unknown", () => {
    expect(holdKindKey("recall_hold")).toBe("tracking.holdKind.recall_hold");
    expect(holdKindKey("x")).toBe("inventory.value.unknown");
    expect(checkKey("serial_position_out_of_range")).toBe(
      "tracking.check.serial_position_out_of_range",
    );
    expect(checkKey("x")).toBe("inventory.value.unknown");
  });
});

describe("findings", () => {
  test("split by kind in server order; expiring_lot has no group (never a zero)", () => {
    const groups = groupFindings([hold, expired, expiring, consistency]);
    expect(groups.holds).toEqual([hold]);
    expect(groups.expired).toEqual([expired]);
    expect(groups.consistency).toEqual([consistency]);
    expect(findingProductIds(groups)).toEqual([P1, P2]);
  });
});

describe("tabs", () => {
  test("the hold and recall lists are owner / tenant_admin only", () => {
    expect(tabsFor("owner")).toEqual([
      "active",
      "expired",
      "expiring",
      "released",
      "recalls",
      "resolution",
      "saleLines",
    ]);
    expect(tabsFor("store_manager")).toEqual([
      "active",
      "expired",
      "expiring",
      "resolution",
      "saleLines",
    ]);
  });

  test("the URL names a tab only when the role has it", () => {
    const tabs = tabsFor("store_manager");
    expect(tabFromSearch(new URLSearchParams("tab=expired"), tabs)).toBe("expired");
    expect(tabFromSearch(new URLSearchParams("tab=recalls"), tabs)).toBe("active");
    expect(tabFromSearch(new URLSearchParams(), tabs)).toBe("active");
  });

  test("arrows follow reading direction and wrap; Home and End jump", () => {
    const tabs = tabsFor("owner");
    expect(tabForKey("ArrowLeft", "active", tabs, true)).toBe("expired");
    expect(tabForKey("ArrowRight", "active", tabs, false)).toBe("expired");
    expect(tabForKey("ArrowRight", "active", tabs, true)).toBe("saleLines");
    expect(tabForKey("End", "active", tabs, true)).toBe("saleLines");
    expect(tabForKey("Home", "recalls", tabs, false)).toBe("active");
    expect(tabForKey("Enter", "active", tabs, false)).toBeUndefined();
  });
});

describe("actors (OD-3)", () => {
  const members = [
    { userId: "U-1", displayName: "  ", email: "amal@x.eg" },
    { userId: "u-2", displayName: "Omar", email: "omar@x.eg" },
  ];
  test("name, else email; a non-member or an unread list has no label", () => {
    expect(actorLabel(members, "u-2")).toBe("Omar");
    expect(actorLabel(members, "u-1")).toBe("amal@x.eg");
    expect(actorLabel(members, "u-9")).toBeUndefined();
    expect(actorLabel(undefined, "u-2")).toBeUndefined();
  });
});
