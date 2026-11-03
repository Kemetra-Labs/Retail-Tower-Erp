import {
  type LevelTarget,
  buildSetBody,
  canReadStockLevels,
  canWriteStoreLevel,
  canWriteTenantLevel,
  compareLevels,
  intentFingerprint,
  isLevel,
  isUnchanged,
  keepsKey,
  keyForIntent,
  levelProblem,
  levelValuesOf,
  mapLevelWriteError,
  mergeLevelReload,
  newIntentKey,
  normalizeLevel,
  normalizeLevels,
  validateLevelForm,
} from "@/stock-levels/stockLevelLogic";
import { describe, expect, test } from "vitest";

/**
 * RT-1074 pure rules of the stock-level editor (RT-1064 TH-2 / TH-4), AC1:
 * decimal strings with no float round-trip, critical <= reorder and the 422
 * mapping, the 409 codes, the Idempotency-Key lifecycle and the role mirror.
 */
const TENANT: LevelTarget = { kind: "tenant" };
const CAIRO: LevelTarget = { kind: "store", storeId: "0190f000-0000-7000-8000-0000000007a1" };
const AT = "2026-11-01T09:00:00.000Z";

describe("exact decimal strings (TH-2): never a float, never rounded", () => {
  test("a value is sent exactly as typed, ends trimmed only", () => {
    expect(buildSetBody({ reorder: " 12.5000 ", critical: "" }, null)).toEqual({
      expectedUpdatedAt: null,
      reorderLevel: "12.5000",
      criticalLevel: null,
    });
    // Leading zeros and trailing fraction zeros survive: nothing is reformatted.
    expect(buildSetBody({ reorder: "007.10", critical: "0.0001" }, AT)).toEqual({
      expectedUpdatedAt: AT,
      reorderLevel: "007.10",
      criticalLevel: "0.0001",
    });
  });

  test("values a float would corrupt pass through untouched", () => {
    // 15 integer digits with 4 fraction digits are not representable as doubles.
    for (const value of ["999999999999999.9999", "0.1", "123456789012345.0001"]) {
      expect(levelProblem(value, true)).toBeUndefined();
      expect(buildSetBody({ reorder: value, critical: "" }, null).reorderLevel).toBe(value);
    }
    expect(String(Number("999999999999999.9999"))).not.toBe("999999999999999.9999");
  });

  test("Arabic-Indic digits and the Arabic decimal separator are written as ASCII, one for one", () => {
    expect(normalizeLevel("١٢٫٥")).toBe("12.5");
    expect(normalizeLevel("۰٫۰۰۰۱")).toBe("0.0001");
    expect(buildSetBody({ reorder: "٣", critical: "" }, null).reorderLevel).toBe("3");
  });

  test("the contract pattern: strictly positive, 1-15 integer and 0-4 fraction digits", () => {
    for (const ok of ["1", "0.0001", "10", "12.5", "999999999999999.9999"]) {
      expect(isLevel(ok), ok).toBe(true);
    }
    for (const bad of ["0", "0.0", "00.0000", "-1", "1.", ".5", "1e3", "1,5", "1.23456", " 1"]) {
      expect(isLevel(bad), bad).toBe(false);
    }
  });

  test("each typed problem has its own message", () => {
    expect(levelProblem("", true)).toBe("catalog.stockLevels.error.reorderRequired");
    expect(levelProblem("", false)).toBeUndefined();
    expect(levelProblem("abc", true)).toBe("catalog.stockLevels.error.format");
    expect(levelProblem("1e3", true)).toBe("catalog.stockLevels.error.format");
    expect(levelProblem("-2", true)).toBe("catalog.stockLevels.error.format");
    expect(levelProblem("0", true)).toBe("catalog.stockLevels.error.positive");
    expect(levelProblem("0.0000", false)).toBe("catalog.stockLevels.error.positive");
    expect(levelProblem("1.23456", true)).toBe("catalog.stockLevels.error.precision");
    expect(levelProblem("1234567890123456", true)).toBe("catalog.stockLevels.error.tooLarge");
  });

  test("compareLevels is digit-exact", () => {
    expect(compareLevels("0.0001", "0.0002")).toBe(-1);
    expect(compareLevels("5", "5.0000")).toBe(0);
    expect(compareLevels("007", "7")).toBe(0);
    expect(compareLevels("10", "9.9999")).toBe(1);
    expect(compareLevels("999999999999999.9998", "999999999999999.9999")).toBe(-1);
    expect(compareLevels("123456789012345", "23456789012345.9")).toBe(1);
  });

  test("levels read from the server are shown exactly as read", () => {
    expect(levelValuesOf({ reorderLevel: "12.5000", criticalLevel: null, updatedAt: AT })).toEqual({
      reorder: "12.5000",
      critical: "",
    });
    expect(levelValuesOf(null)).toEqual({ reorder: "", critical: "" });
  });
});

describe("critical <= reorder (TH-2) and the 422 mapping", () => {
  test("critical above reorder is refused on the critical field; equal is allowed", () => {
    expect(validateLevelForm({ reorder: "10", critical: "10.0001" })).toEqual({
      critical: "catalog.stockLevels.error.criticalAboveReorder",
    });
    expect(validateLevelForm({ reorder: "10", critical: "10.0000" })).toEqual({});
    expect(validateLevelForm({ reorder: "10", critical: "" })).toEqual({});
    // A 15-digit pair a float would call equal.
    expect(
      validateLevelForm({ reorder: "999999999999999.9998", critical: "999999999999999.9999" }),
    ).toEqual({ critical: "catalog.stockLevels.error.criticalAboveReorder" });
  });

  test("a field error comes before the cross-field rule", () => {
    expect(validateLevelForm({ reorder: "", critical: "5" })).toEqual({
      reorder: "catalog.stockLevels.error.reorderRequired",
    });
  });

  test("422 critical_above_reorder on a set maps to the critical field", () => {
    expect(
      mapLevelWriteError({
        op: "set",
        status: 422,
        code: "critical_above_reorder",
        requestId: "r",
      }),
    ).toEqual({ kind: "critical", requestId: "r" });
  });
});

describe("409 and 404 answers", () => {
  test("stale_write on either write asks for a reload", () => {
    expect(mapLevelWriteError({ op: "set", status: 409, code: "stale_write" })).toEqual({
      kind: "stale",
    });
    expect(mapLevelWriteError({ op: "retire", status: 409, code: "stale_write" })).toEqual({
      kind: "stale",
    });
  });

  test("product_retired on a set locks the editor", () => {
    expect(mapLevelWriteError({ op: "set", status: 409, code: "product_retired" })).toEqual({
      kind: "retired",
    });
  });

  test("idempotency_key_conflict and any other 409 are banners", () => {
    expect(
      mapLevelWriteError({ op: "set", status: 409, code: "idempotency_key_conflict" }),
    ).toMatchObject({ kind: "banner", messageKey: "catalog.stockLevels.error.keyConflict" });
    expect(mapLevelWriteError({ op: "set", status: 409, code: "other" })).toMatchObject({
      kind: "banner",
      messageKey: "catalog.stockLevels.error.conflict",
    });
  });

  test("404 on a retire means already gone; on a set it is the non-disclosing banner", () => {
    expect(mapLevelWriteError({ op: "retire", status: 404, requestId: "r" })).toEqual({
      kind: "gone",
      requestId: "r",
    });
    expect(mapLevelWriteError({ op: "set", status: 404 })).toMatchObject({
      kind: "banner",
      messageKey: "catalog.stockLevels.error.notFound",
    });
  });

  test("425 is in progress, with at least one second", () => {
    expect(mapLevelWriteError({ op: "set", status: 425, retryAfterSec: 3 })).toEqual({
      kind: "in-progress",
      retryAfterSec: 3,
    });
    expect(mapLevelWriteError({ op: "set", status: 425 })).toEqual({
      kind: "in-progress",
      retryAfterSec: 1,
    });
  });

  test("the remaining statuses", () => {
    const of = (status: number, code?: string) =>
      mapLevelWriteError({ op: "set", status, code }) as { messageKey?: string };
    expect(of(400).messageKey).toBe("catalog.stockLevels.error.validation");
    expect(of(400, "idempotency_key_malformed").messageKey).toBe("catalog.write.error.server");
    expect(of(401).messageKey).toBe("catalog.write.error.session");
    expect(of(403, "origin_rejected").messageKey).toBe("catalog.write.error.origin");
    expect(of(403).messageKey).toBe("catalog.stockLevels.error.forbidden");
    expect(of(429).messageKey).toBe("catalog.write.error.rateLimited");
    expect(of(500).messageKey).toBe("catalog.write.error.server");
  });
});

describe("the Idempotency-Key lifecycle (TH-4)", () => {
  const body = buildSetBody({ reorder: "10", critical: "2" }, null);

  test("a new intent mints a new key; a retry of the same intent keeps it", () => {
    let n = 0;
    const mint = () => `minted-${++n}`;
    const first = keyForIntent(undefined, intentFingerprint(TENANT, body), mint);
    const retry = keyForIntent(first, intentFingerprint(TENANT, body), mint);
    expect(retry).toBe(first);
    const changed = buildSetBody({ reorder: "10", critical: "3" }, null);
    const next = keyForIntent(retry, intentFingerprint(TENANT, changed), mint);
    expect(next.key).not.toBe(first.key);
    expect(n).toBe(2);
  });

  test("the target and the precondition are part of the intent", () => {
    expect(intentFingerprint(TENANT, body)).not.toBe(intentFingerprint(CAIRO, body));
    expect(intentFingerprint(TENANT, body)).not.toBe(
      intentFingerprint(TENANT, buildSetBody({ reorder: "10", critical: "2" }, AT)),
    );
  });

  test("only an answer that may not be final keeps the key", () => {
    for (const status of [500, 502, 503, 425, 429])
      expect(keepsKey(status), String(status)).toBe(true);
    for (const status of [200, 400, 401, 403, 404, 409, 422]) {
      expect(keepsKey(status), String(status)).toBe(false);
    }
  });

  test("a minted key fits the contract's Idempotency-Key pattern", () => {
    const minted = newIntentKey();
    expect(minted).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(newIntentKey()).not.toBe(minted);
  });
});

describe("reload merge and no-change detection", () => {
  test("a field the person changed is kept; an untouched field takes the fresh value", () => {
    expect(
      mergeLevelReload(
        { reorder: "10", critical: "2" },
        { reorder: "12", critical: "2" },
        { reorder: "20", critical: "5" },
      ),
    ).toEqual({ reorder: "12", critical: "5" });
  });

  test("equal values are no change, digit-exact", () => {
    const level = { reorderLevel: "5.0000", criticalLevel: null, updatedAt: AT };
    expect(isUnchanged(level, buildSetBody({ reorder: "5", critical: "" }, AT))).toBe(true);
    expect(isUnchanged(level, buildSetBody({ reorder: "5.0001", critical: "" }, AT))).toBe(false);
    expect(isUnchanged(level, buildSetBody({ reorder: "5", critical: "1" }, AT))).toBe(false);
    expect(isUnchanged(null, buildSetBody({ reorder: "5", critical: "" }, null))).toBe(false);
  });

  test("a body without lists is a product with no levels", () => {
    expect(normalizeLevels("p1", {})).toEqual({
      productId: "p1",
      tenantLevel: null,
      storeLevels: [],
    });
  });
});

describe("role mirror (TH-4) for the four roles", () => {
  test.each([
    ["owner", true, true, true],
    ["tenant_admin", true, true, true],
    ["store_manager", true, false, true],
    ["store_staff", false, false, false],
  ])("%s: read %s, tenant level %s, store level %s", (role, read, tenant, store) => {
    expect(canReadStockLevels(role)).toBe(read);
    expect(canWriteTenantLevel(role)).toBe(tenant);
    expect(canWriteStoreLevel(role)).toBe(store);
  });

  test("no role is no access", () => {
    expect(canReadStockLevels(null)).toBe(false);
    expect(canWriteStoreLevel(undefined)).toBe(false);
  });
});
