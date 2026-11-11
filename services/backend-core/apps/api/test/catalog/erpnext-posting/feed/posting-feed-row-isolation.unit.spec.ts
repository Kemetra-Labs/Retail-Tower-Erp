/**
 * RT-1325 (RT-1125 R-21) — one unbuildable posting row never fails the feed.
 *
 * Docker-free: a scripted pg client stands in for the pool, and
 * `buildWorkItem` is mocked per row. Proves, for `pullPostings`:
 *   - a row whose projection throws a known per-row error is left out of the
 *     page, the other items are returned in feed order, and the cursor is the
 *     page's last row (unchanged);
 *   - that row is never skipped silently: in the same transaction, under the
 *     tenant's posting-feed sequence lock taken BEFORE the row lock, it is
 *     re-headed with retry_count+1 (bounded by POSTING_RETRY_BUDGET), or
 *     dead-lettered as `retry_budget_exhausted` once the budget is spent;
 *   - the write is conditional on the row still being `pending` at the
 *     sequence the page read (a concurrent ack or pull wins, nothing else);
 *   - an unclassified error (a SQL error, which aborts the transaction, or an
 *     unknown bug) still fails the whole pull, as before;
 *   - a `null` build is still omitted but is now logged;
 *   - a page with no failure writes nothing (the pure-read path is unchanged).
 */
import type { Pool } from "pg";

jest.mock("../../../../src/catalog/erpnext-posting/posting-work-item.projection", () => {
  const actual = jest.requireActual(
    "../../../../src/catalog/erpnext-posting/posting-work-item.projection",
  );
  return { ...actual, buildWorkItem: jest.fn() };
});
jest.mock("../../../../src/inventory/effect-integration/effect-integration.transitions", () => ({
  applyPostingSignalToEffects: jest.fn().mockResolvedValue(undefined),
}));

import {
  ErpnextPostingService,
  POSTING_RETRY_BUDGET,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  PostingResolutionIncompleteError,
  ReturnTendersNotVisibleError,
  SaleTendersNotVisibleError,
  buildWorkItem,
  type PostingWorkItem,
} from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { PostingFeedReporter } from "../../../../src/catalog/erpnext-posting/posting-feed-reporter";
import { SaleResponsibilitiesNotVisibleError } from "../../../../src/catalog/sales/sale-responsibilities";
import { applyPostingSignalToEffects } from "../../../../src/inventory/effect-integration/effect-integration.transitions";
import * as metrics from "../../../../src/observability/metrics/api.metrics";

const TENANT = "13250000-0000-4000-8000-000000000001";
const ROW_A = "13250000-0000-4000-8000-00000000000a";
const ROW_B = "13250000-0000-4000-8000-00000000000b";
const ROW_C = "13250000-0000-4000-8000-00000000000c";

const build = buildWorkItem as jest.MockedFunction<typeof buildWorkItem>;

interface FeedRow {
  id: string;
  sequence: string;
}

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** A scripted pg client: answers by SQL shape, records every statement. */
class ScriptedClient {
  readonly calls: Call[] = [];
  feedRows: FeedRow[] = [];
  /** retry_count the row lock returns; null = the row moved (0 rows). */
  lockedRetryCount: number | null = 0;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (/FROM erpnext_posting_status\s+WHERE status = 'pending'/.test(sql)) {
      const rows = this.feedRows.map((r) => ({
        id: r.id,
        kind: "sale_post",
        sale_id: r.id,
        source_ref_id: r.id,
        source_system: "pos",
        external_id: `ext-${r.id}`,
        payload_hash: "a".repeat(64),
        sequence: r.sequence,
        current_resolution_version: 1,
      }));
      return { rows, rowCount: rows.length };
    }
    if (/FOR UPDATE/.test(sql)) {
      const rows = this.lockedRetryCount === null ? [] : [{ retry_count: this.lockedRetryCount }];
      return { rows, rowCount: rows.length };
    }
    if (/^\s*UPDATE erpnext_posting_status/.test(sql)) {
      return { rows: [{ updated_at: new Date("2026-11-11T00:00:00Z") }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}

  statements(pattern: RegExp): Call[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }
}

function item(id: string, sequence: string): PostingWorkItem {
  return { workItemRef: id, itemCursor: sequence } as unknown as PostingWorkItem;
}

describe("pullPostings row isolation (RT-1325, RT-1125 R-21)", () => {
  let client: ScriptedClient;
  let service: ErpnextPostingService;
  const logger = { warn: jest.fn() };
  let reconciliation: jest.SpyInstance;

  beforeEach(() => {
    client = new ScriptedClient();
    client.feedRows = [
      { id: ROW_A, sequence: "11" },
      { id: ROW_B, sequence: "12" },
      { id: ROW_C, sequence: "13" },
    ];
    const pool = { connect: async () => client } as unknown as Pool;
    service = new ErpnextPostingService(pool, new PostingFeedReporter(logger));
    logger.warn.mockReset();
    build.mockReset().mockImplementation(async (_c, row) => item(row.id, row.sequence));
    (applyPostingSignalToEffects as jest.Mock).mockClear();
    reconciliation = jest.spyOn(metrics, "recordErpnextPostingReconciliation");
    reconciliation.mockClear();
  });

  function failRow(id: string, err: unknown): void {
    build.mockImplementation(async (_c, row) => {
      if (row.id === id) throw err;
      return item(row.id, row.sequence);
    });
  }

  const pull = () => service.pullPostings({ tenantId: TENANT, since: null, limit: 3 });

  it.each([
    ["SaleTendersNotVisibleError", new SaleTendersNotVisibleError(ROW_B, 1, 0)],
    ["SaleResponsibilitiesNotVisibleError", new SaleResponsibilitiesNotVisibleError(ROW_B, 1, 0)],
    ["ReturnTendersNotVisibleError", new ReturnTendersNotVisibleError(ROW_B)],
    ["PostingResolutionIncompleteError", new PostingResolutionIncompleteError(ROW_B, 1)],
  ])("a row whose build throws %s is left out; the rest of the page is returned with the same cursor", async (name, err) => {
    failRow(ROW_B, err);
    const page = await pull();
    expect(page.items.map((i) => i.workItemRef)).toEqual([ROW_A, ROW_C]);
    expect(page.cursor).toBe("13");
    expect(page.nextPageToken).toBe("13");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ work_item_ref: ROW_B, error: name, retry_count: 1 }),
      expect.stringContaining("re-offered"),
    );
  });

  it("re-heads the failed row in the pull's transaction: sequence lock, then the row lock, then retry_count+1", async () => {
    failRow(ROW_B, new SaleTendersNotVisibleError(ROW_B, 1, 0));
    client.lockedRetryCount = 2;
    await pull();
    const sqls = client.calls.map((c) => c.sql);
    const lockAt = sqls.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const rowLockAt = sqls.findIndex((s) => /FOR UPDATE/.test(s));
    const updateAt = sqls.findIndex((s) => /^\s*UPDATE erpnext_posting_status/.test(s));
    const commitAt = sqls.indexOf("COMMIT");
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(rowLockAt);
    expect(rowLockAt).toBeLessThan(updateAt);
    expect(updateAt).toBeLessThan(commitAt);
    const rowLock = client.calls[rowLockAt]!;
    expect(rowLock.sql).toMatch(/status = 'pending'/);
    expect(rowLock.params).toEqual([ROW_B, "12"]);
    const update = client.calls[updateAt]!;
    expect(update.sql).toMatch(/retry_count=retry_count\+1/);
    expect(update.sql).toMatch(/sequence=DEFAULT/);
    expect(update.params).toEqual([ROW_B]);
    expect(applyPostingSignalToEffects).toHaveBeenCalledWith(
      expect.anything(),
      { postingStatusId: ROW_B, signal: "failed_transient" },
    );
    expect(reconciliation).not.toHaveBeenCalled();
  });

  it("dead-letters the row as retry_budget_exhausted once the retry budget is spent", async () => {
    failRow(ROW_B, new SaleTendersNotVisibleError(ROW_B, 1, 0));
    client.lockedRetryCount = POSTING_RETRY_BUDGET;
    const page = await pull();
    expect(page.items.map((i) => i.workItemRef)).toEqual([ROW_A, ROW_C]);
    const [update] = client.statements(/^\s*UPDATE erpnext_posting_status/);
    expect(update!.sql).toMatch(/status='permanently_rejected'/);
    expect(update!.params).toEqual([ROW_B, "retry_budget_exhausted", null, null]);
    expect(reconciliation).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ work_item_ref: ROW_B, error: "SaleTendersNotVisibleError" }),
      expect.stringContaining("dead-lettered"),
    );
  });

  it("writes nothing when the row moved meanwhile (a concurrent ack or pull already handled it)", async () => {
    failRow(ROW_B, new SaleTendersNotVisibleError(ROW_B, 1, 0));
    client.lockedRetryCount = null;
    const page = await pull();
    expect(page.items.map((i) => i.workItemRef)).toEqual([ROW_A, ROW_C]);
    expect(client.statements(/^\s*UPDATE erpnext_posting_status/)).toHaveLength(0);
    expect(client.calls.map((c) => c.sql)).toContain("COMMIT");
  });

  it("isolates every failing row on the page, each under the one sequence lock", async () => {
    build.mockImplementation(async (_c, row) => {
      if (row.id === ROW_C) return item(row.id, row.sequence);
      throw new SaleTendersNotVisibleError(row.id, 1, 0);
    });
    const page = await pull();
    expect(page.items.map((i) => i.workItemRef)).toEqual([ROW_C]);
    expect(page.cursor).toBe("13");
    expect(client.statements(/pg_advisory_xact_lock/)).toHaveLength(1);
    expect(client.statements(/^\s*UPDATE erpnext_posting_status/).map((c) => c.params[0])).toEqual([ROW_A, ROW_B]);
  });

  it("an unclassified error (a SQL error aborts the transaction) still fails the whole pull, with no write", async () => {
    const sqlError = Object.assign(new Error("permission denied for table sale_tenders"), { code: "42501" });
    failRow(ROW_B, sqlError);
    await expect(pull()).rejects.toBe(sqlError);
    expect(client.calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(client.statements(/pg_advisory_xact_lock|^\s*UPDATE/)).toHaveLength(0);
  });

  it("an unknown error from the projection still fails the whole pull", async () => {
    const bug = new TypeError("cannot read properties of undefined");
    failRow(ROW_B, bug);
    await expect(pull()).rejects.toBe(bug);
  });

  it("a failed status write fails the pull rather than skip the row", async () => {
    failRow(ROW_B, new SaleTendersNotVisibleError(ROW_B, 1, 0));
    const boom = new Error("connection reset");
    const original = client.query.bind(client);
    client.query = async (sql: string, params: readonly unknown[] = []) => {
      if (/^\s*UPDATE erpnext_posting_status/.test(sql)) {
        client.calls.push({ sql, params });
        throw boom;
      }
      return original(sql, params);
    };
    await expect(pull()).rejects.toBe(boom);
    expect(client.calls.map((c) => c.sql)).toContain("ROLLBACK");
  });

  it("a null build is still omitted, and now logged", async () => {
    build.mockImplementation(async (_c, row) => (row.id === ROW_B ? null : item(row.id, row.sequence)));
    const page = await pull();
    expect(page.items.map((i) => i.workItemRef)).toEqual([ROW_A, ROW_C]);
    expect(page.cursor).toBe("13");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ work_item_ref: ROW_B, kind: "sale_post" }),
      expect.stringContaining("omitted"),
    );
    expect(client.statements(/pg_advisory_xact_lock|^\s*UPDATE/)).toHaveLength(0);
  });

  it("a page with no failure takes no lock and writes nothing (the pure read is unchanged)", async () => {
    const page = await pull();
    expect(page.items.map((i) => i.workItemRef)).toEqual([ROW_A, ROW_B, ROW_C]);
    expect(client.statements(/pg_advisory_xact_lock|FOR UPDATE|^\s*UPDATE/)).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
