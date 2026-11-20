/**
 * RT-1503 (spec 049 S2) — the catalogue import retention policy: windows,
 * cutoff math and the per-batch predicates. Pure; no database.
 */
import {
  CLOSED_ROWS_RETENTION_DAYS,
  EXPIRABLE_STATES,
  PUBLISHED_ROWS_RETENTION_MONTHS,
  computeImportRetentionCutoffs,
  isExpiryDue,
  isRowsPurgeDue,
  subtractUtcDays,
  subtractUtcMonths,
  type BatchRetentionFacts,
} from "../../src/catalog-import/import-retention.policy";

const at = (iso: string): Date => new Date(iso);

describe("RT-1503 import retention windows (OD-6, spec 049 §8.7 / §10)", () => {
  it("keeps rows of a cancelled or expired batch 30 days and of a published batch 13 months", () => {
    expect(CLOSED_ROWS_RETENTION_DAYS).toBe(30);
    expect(PUBLISHED_ROWS_RETENTION_MONTHS).toBe(13);
  });

  it("only an open draft or validated batch can expire", () => {
    expect([...EXPIRABLE_STATES]).toEqual(["draft", "validated"]);
  });
});

describe("RT-1503 cutoff math (UTC, the same arithmetic as the SQL)", () => {
  it("subtracts whole UTC days", () => {
    expect(subtractUtcDays(at("2026-11-20T10:15:00.000Z"), 30).toISOString()).toBe("2026-10-21T10:15:00.000Z");
  });

  it("subtracts days across a year boundary and a leap day", () => {
    expect(subtractUtcDays(at("2028-03-01T00:00:00.000Z"), 30).toISOString()).toBe("2028-01-31T00:00:00.000Z");
  });

  it("subtracts months keeping the time of day", () => {
    expect(subtractUtcMonths(at("2026-11-20T10:15:00.000Z"), 13).toISOString()).toBe("2025-10-20T10:15:00.000Z");
  });

  it("clamps to the last day of a shorter month, as PostgreSQL does (2026-03-31 - 13 months = 2025-02-28)", () => {
    expect(subtractUtcMonths(at("2026-03-31T23:59:59.999Z"), 13).toISOString()).toBe("2025-02-28T23:59:59.999Z");
  });

  it("clamps to 29 February in a leap year", () => {
    expect(subtractUtcMonths(at("2029-03-31T12:00:00.000Z"), 13).toISOString()).toBe("2028-02-29T12:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const now = at("2026-11-20T10:15:00.000Z");
    subtractUtcDays(now, 30);
    subtractUtcMonths(now, 13);
    expect(now.toISOString()).toBe("2026-11-20T10:15:00.000Z");
  });

  it("rejects a negative or fractional window", () => {
    expect(() => subtractUtcDays(at("2026-11-20T00:00:00.000Z"), -1)).toThrow(RangeError);
    expect(() => subtractUtcMonths(at("2026-11-20T00:00:00.000Z"), 1.5)).toThrow(RangeError);
  });

  it("computes both cutoffs from one instant", () => {
    expect(computeImportRetentionCutoffs(at("2026-11-20T10:15:00.000Z"))).toEqual({
      closedCutoff: at("2026-10-21T10:15:00.000Z"),
      publishedCutoff: at("2025-10-20T10:15:00.000Z"),
    });
  });
});

describe("RT-1503 expiry predicate (spec 049 §8.1)", () => {
  const now = at("2026-11-20T10:00:00.000Z");

  it.each(["draft", "validated"] as const)("a %s batch expires once expires_at <= now (inclusive)", (state) => {
    expect(isExpiryDue({ state, expiresAt: at("2026-11-20T10:00:00.000Z") }, now)).toBe(true);
    expect(isExpiryDue({ state, expiresAt: at("2026-11-20T09:59:59.999Z") }, now)).toBe(true);
    expect(isExpiryDue({ state, expiresAt: at("2026-11-20T10:00:00.001Z") }, now)).toBe(false);
  });

  it.each(["pending_approval", "approved", "published", "cancelled", "expired"] as const)(
    "a %s batch never expires",
    (state) => {
      expect(isExpiryDue({ state, expiresAt: at("2020-01-01T00:00:00.000Z") }, now)).toBe(false);
    },
  );

  it("a batch without expires_at never expires", () => {
    expect(isExpiryDue({ state: "draft", expiresAt: null }, now)).toBe(false);
  });
});

describe("RT-1503 row purge predicate (OD-6)", () => {
  const now = at("2026-11-20T10:00:00.000Z");
  const cutoffs = computeImportRetentionCutoffs(now);
  const closed = (state: "cancelled" | "expired", closedAt: string): BatchRetentionFacts => ({
    state,
    closedAt: at(closedAt),
    publishedAt: null,
    rowsPurgedAt: null,
  });
  const published = (publishedAt: string): BatchRetentionFacts => ({
    state: "published",
    closedAt: at(publishedAt),
    publishedAt: at(publishedAt),
    rowsPurgedAt: null,
  });

  it.each(["cancelled", "expired"] as const)("a %s batch's rows go at exactly 30 days after closed_at", (state) => {
    expect(isRowsPurgeDue(closed(state, "2026-10-21T10:00:00.000Z"), cutoffs)).toBe(true);
    expect(isRowsPurgeDue(closed(state, "2026-10-21T10:00:00.001Z"), cutoffs)).toBe(false);
  });

  it("a published batch's rows go at exactly 13 months after published_at", () => {
    expect(isRowsPurgeDue(published("2025-10-20T10:00:00.000Z"), cutoffs)).toBe(true);
    expect(isRowsPurgeDue(published("2025-10-20T10:00:00.001Z"), cutoffs)).toBe(false);
  });

  it("a published batch is not held to the 30-day window", () => {
    expect(isRowsPurgeDue(published("2026-09-01T00:00:00.000Z"), cutoffs)).toBe(false);
  });

  it.each(["draft", "validated", "pending_approval", "approved"] as const)("an open %s batch's rows are kept", (state) => {
    expect(
      isRowsPurgeDue({ state, closedAt: null, publishedAt: null, rowsPurgedAt: null }, cutoffs),
    ).toBe(false);
  });

  it("a batch whose rows were already purged is not purged again", () => {
    expect(
      isRowsPurgeDue({ ...closed("expired", "2026-01-01T00:00:00.000Z"), rowsPurgedAt: at("2026-02-01T00:00:00.000Z") }, cutoffs),
    ).toBe(false);
  });
});
