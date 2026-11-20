/**
 * RT-1503 (spec 049 S2) — the catalogue import retention windows. Pure; no
 * database. The cutoff arithmetic is SQL only and is pinned at fixed instants
 * on real PostgreSQL in import-retention.integration.spec.ts.
 */
import {
  CLOSED_ROWS_RETENTION_DAYS,
  PUBLISHED_ROWS_RETENTION_MONTHS,
} from "../../src/catalog-import/import-retention.policy";

describe("RT-1503 import retention windows (OD-6, spec 049 §8.7 / §10)", () => {
  it("keeps rows of a cancelled or expired batch 30 days and of a published batch 13 months", () => {
    expect(CLOSED_ROWS_RETENTION_DAYS).toBe(30);
    expect(PUBLISHED_ROWS_RETENTION_MONTHS).toBe(13);
  });
});
