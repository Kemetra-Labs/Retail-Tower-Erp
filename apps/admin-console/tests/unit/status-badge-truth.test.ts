/**
 * RT-956 status badge truth (DESIGN.md §3): UNKNOWN is red, never amber or
 * neutral. Every status mapper that feeds a `.badge` is enumerated here with an
 * unrecognised code and must answer with the danger variant.
 */
import { statusBadgeClass } from "@/catalog/catalogLogic";
import { lastSeenView, trustBadgeClass } from "@/devices/deviceLogic";
import { ar } from "@/i18n/messages/ar";
import { en } from "@/i18n/messages/en";
import { syncStatusView } from "@/sale-sync/saleSyncLogic";
import { erpChipClass, returnChipClass, syncChipClass } from "@/sales/saleLogic";
import { tenantStatusClass } from "@/tenants/tenantStatus";
import { describe, expect, test } from "vitest";

const UNRECOGNISED = ["", "posted-ish", "UNKNOWN", "__proto__", "toString"];

describe("an unrecognised status renders danger (AC 1)", () => {
  test.each(UNRECOGNISED)("sale sync section %j", (code) => {
    expect(syncStatusView(code).badge).toBe("badge--danger");
  });
  test.each(UNRECOGNISED)("sale sync chip %j", (code) => {
    expect(syncChipClass({ syncStatus: code })).toBe("badge badge--danger");
  });
  test.each(UNRECOGNISED)("ERP posting chip %j", (code) => {
    expect(erpChipClass({ erpPostingState: code })).toBe("badge badge--danger");
  });
  test("ERP posting `unknown` (the contract's own value) is danger too", () => {
    expect(erpChipClass({ erpPostingState: "unknown" })).toBe("badge badge--danger");
  });
  test.each(UNRECOGNISED)("return chip %j", (code) => {
    expect(returnChipClass({ returnState: code })).toBe("badge badge--danger");
  });
  test.each(UNRECOGNISED)("device trust %j", (code) => {
    expect(trustBadgeClass({ trustState: code })).toBe("badge badge--danger");
  });
  test.each(UNRECOGNISED)("tenant status %j", (code) => {
    expect(tenantStatusClass(code)).toBe("badge badge--danger");
  });
  test.each(UNRECOGNISED)("catalog product status %j", (code) => {
    expect(statusBadgeClass(code)).toBe("badge badge--danger");
  });
});

describe("recognised states keep their role", () => {
  test("ERP `failed` is danger, `pending` info, `posted` neutral (AC 2)", () => {
    expect(erpChipClass({ erpPostingState: "failed" })).toBe("badge badge--danger");
    expect(erpChipClass({ erpPostingState: "pending" })).toBe("badge badge--pending");
    expect(erpChipClass({ erpPostingState: "posted" })).toBe("badge");
  });
  test("sale sync: failures are a warning, the rest neutral in the chip", () => {
    expect(syncChipClass({ syncStatus: "failed-retryable" })).toBe("badge badge--warning");
    expect(syncChipClass({ syncStatus: "failed-needs-repair" })).toBe("badge badge--warning");
    expect(syncChipClass({ syncStatus: "captured" })).toBe("badge");
    expect(syncChipClass({ syncStatus: "synced" })).toBe("badge");
    expect(syncStatusView("failed-needs-repair").badge).toBe("badge--warning");
  });
  test("a known return state stays neutral", () => {
    for (const state of ["none", "partial", "full"]) {
      expect(returnChipClass({ returnState: state })).toBe("badge");
    }
  });
  test("device trust: active neutral, revoked danger, retired muted", () => {
    expect(trustBadgeClass({ trustState: "active" })).toBe("badge");
    expect(trustBadgeClass({ trustState: "revoked" })).toBe("badge badge--danger");
    expect(trustBadgeClass({ trustState: "retired" })).toBe("badge device-trust--muted");
  });
  test("tenant status: active success, suspended warning, pending info", () => {
    expect(tenantStatusClass("active")).toBe("badge badge--success");
    expect(tenantStatusClass("suspended")).toBe("badge badge--warning");
    expect(tenantStatusClass("pending")).toBe("badge badge--pending");
  });
  test("catalog product status: known codes stay neutral", () => {
    for (const status of ["active", "inactive", "retired"]) {
      expect(statusBadgeClass(status)).toBe("badge");
    }
  });
});

describe("a value the server does not record is neutral, not UNKNOWN (AC 3)", () => {
  test("device last activity with no value is «غير مسجّل» / Not recorded", () => {
    const view = lastSeenView({ lastSeenAt: null, lastSeenSource: null });
    expect(view).toEqual({ kind: "notRecorded", key: "devices.lastSeen.notRecorded" });
    expect(ar["devices.lastSeen.notRecorded"]).toBe("غير مسجّل");
    expect(en["devices.lastSeen.notRecorded"]).toBe("Not recorded");
  });
});
