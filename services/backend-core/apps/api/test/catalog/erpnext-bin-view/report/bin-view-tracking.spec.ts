/**
 * RT-919 — ErpnextBinViewService.reportSnapshot records the stock-view 1.4
 * `BinEntry.tracking` evidence run-scoped (Testcontainers).
 *
 *   - a tracked report (batch Item with Batches + untracked Item) lands in
 *     `erpnext_reconciliation_run.summary.bin_view_report.entries[i].tracking`
 *     as reported; an entry without `tracking` is stored with no such key;
 *   - the same tracked window replays (`replayed: true`) after the jsonb round
 *     trip (stored keys reordered, Batches reordered on the wire);
 *   - the same window with DIFFERENT tracking → BinViewConflictError (O-3), and
 *     adding/removing `tracking` is a different report too;
 *   - another tenant posting a tracked report to this requestRef →
 *     BinViewNotFoundError, nothing written (tenant isolation unchanged).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  BinViewConflictError,
  BinViewNotFoundError,
  ErpnextBinViewService,
  type BinEntryInput,
  type SnapshotReportBody,
} from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  TENANT_B,
} from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";
import { requestRefFor } from "../__support__/request-ref";

let env: PgTestEnv | null = null;
let skip = false;

const RUN_TRACKED = "0a000000-0000-7000-8000-0000000e9191";
const RUN_ISOLATION = "0a000000-0000-7000-8000-0000000e9192";
const ERP_ITEM_REF = "ERP-ITEM-919A";
const READ_AT = "2026-11-06T08:00:00.000Z";

const BATCH_1 = {
  batchRef: { doctype: "Batch" as const, name: "BATCH-0001" },
  quantity: "6.000000",
  expiryDate: "2027-03-31",
  disabled: false,
};
const BATCH_2 = {
  batchRef: { doctype: "Batch" as const, name: "BATCH-0002" },
  quantity: "-1.000000",
  expiryDate: null,
  disabled: true,
};
const BATCH_TRACKING = { hasBatchNo: true, hasSerialNo: false, hasExpiryDate: true, batches: [BATCH_1, BATCH_2] };
const UNTRACKED = { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false };

function entry(name: string, quantity: string, tracking?: BinEntryInput["tracking"]): BinEntryInput {
  return {
    erpnextItemRef: { doctype: "Item", name },
    quantity,
    stockUom: "Nos",
    ...(tracking === undefined ? {} : { tracking }),
  };
}

function report(entries: BinEntryInput[]): SnapshotReportBody {
  return { entries, readAt: READ_AT };
}

/** The tracked report: a batch Item, an untracked Item, and an entry with no tracking. */
const TRACKED_REPORT = report([
  entry(ERP_ITEM_REF, "5.000000", BATCH_TRACKING),
  entry("ERP-ITEM-919-PLAIN", "2.000000", UNTRACKED),
  entry("ERP-ITEM-919-OLD", "1.000000"),
]);

async function storedEntries(runId: string): Promise<Array<Record<string, unknown>>> {
  const row = await env!.admin.query<{ summary: { bin_view_report?: { entries: Array<Record<string, unknown>> } } | null }>(
    `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return row.rows[0]?.summary?.bin_view_report?.entries ?? [];
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    for (const id of [RUN_TRACKED, RUN_ISOLATION]) {
      await a.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT_A, STORE_A_X, ACTOR_A],
      );
    }
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
          suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, PRODUCT_A_ACTIVE, ERP_ITEM_REF, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[bin-view-tracking.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

describe("RT-919 — reportSnapshot records the v1.4 tracking evidence", () => {
  it("records each entry's tracking as reported; an entry without tracking gets no key", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const requestRef = await requestRefFor(env!.admin, RUN_TRACKED);
    const recorded = await service.reportSnapshot({
      tenantId: TENANT_A,
      requestRef,
      body: TRACKED_REPORT,
      idempotencyKey: "rt919-tracked-1",
    });
    expect(recorded.replayed).toBe(false);
    expect(recorded.view.acceptedEntryCount).toBe(3);
    // The recorded response is unchanged by v1.4: no tracking field on it.
    expect(Object.keys(recorded.view).sort()).toEqual(
      ["acceptedEntryCount", "erpnextWarehouseRef", "readAt", "recordedAt", "requestRef", "runRef"],
    );

    const [batch, plain, old] = await storedEntries(RUN_TRACKED);
    expect(batch).toEqual({
      erpnextItemRef: ERP_ITEM_REF,
      tenant_product_ref: PRODUCT_A_ACTIVE,
      quantity: "5.000000",
      stockUom: "Nos",
      tracking: BATCH_TRACKING,
    });
    expect(plain!["tracking"]).toEqual(UNTRACKED);
    expect(plain!["tenant_product_ref"]).toBeNull();
    expect(old).toEqual({
      erpnextItemRef: "ERP-ITEM-919-OLD",
      tenant_product_ref: null,
      quantity: "1.000000",
      stockUom: "Nos",
    });
  });

  it("the same tracked report replays after the jsonb round trip, Batches in any order", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const requestRef = await requestRefFor(env!.admin, RUN_TRACKED);
    // Same content, different wire key and Batch order.
    const reordered = report([
      entry("ERP-ITEM-919-OLD", "1.000000"),
      entry(ERP_ITEM_REF, "5.000000", {
        batches: [
          { disabled: true, expiryDate: null, quantity: "-1.000000", batchRef: { name: "BATCH-0002", doctype: "Batch" } },
          BATCH_1,
        ],
        hasExpiryDate: true,
        hasSerialNo: false,
        hasBatchNo: true,
      }),
      entry("ERP-ITEM-919-PLAIN", "2.000000", UNTRACKED),
    ]);
    const replay = await service.reportSnapshot({
      tenantId: TENANT_A,
      requestRef,
      body: reordered,
      idempotencyKey: "rt919-tracked-2",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.view.acceptedEntryCount).toBe(3);
  });

  const DIFFERENT: Array<{ label: string; body: SnapshotReportBody }> = [
    {
      label: "a different Batch quantity",
      body: report([
        entry(ERP_ITEM_REF, "5.000000", { ...BATCH_TRACKING, batches: [{ ...BATCH_1, quantity: "7.000000" }, BATCH_2] }),
        entry("ERP-ITEM-919-PLAIN", "2.000000", UNTRACKED),
        entry("ERP-ITEM-919-OLD", "1.000000"),
      ]),
    },
    {
      label: "a different Item flag",
      body: report([
        entry(ERP_ITEM_REF, "5.000000", { ...BATCH_TRACKING, hasExpiryDate: false }),
        entry("ERP-ITEM-919-PLAIN", "2.000000", UNTRACKED),
        entry("ERP-ITEM-919-OLD", "1.000000"),
      ]),
    },
    {
      label: "tracking dropped from an entry",
      body: report([
        entry(ERP_ITEM_REF, "5.000000"),
        entry("ERP-ITEM-919-PLAIN", "2.000000", UNTRACKED),
        entry("ERP-ITEM-919-OLD", "1.000000"),
      ]),
    },
    {
      label: "tracking added to an entry",
      body: report([
        entry(ERP_ITEM_REF, "5.000000", BATCH_TRACKING),
        entry("ERP-ITEM-919-PLAIN", "2.000000", UNTRACKED),
        entry("ERP-ITEM-919-OLD", "1.000000", UNTRACKED),
      ]),
    },
  ];

  it.each(DIFFERENT)("the same window with $label → BinViewConflictError, stored report kept", async ({ body }) => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const requestRef = await requestRefFor(env!.admin, RUN_TRACKED);
    const before = await storedEntries(RUN_TRACKED);
    await expect(
      service.reportSnapshot({ tenantId: TENANT_A, requestRef, body, idempotencyKey: "rt919-tracked-3" }),
    ).rejects.toBeInstanceOf(BinViewConflictError);
    expect(await storedEntries(RUN_TRACKED)).toEqual(before);
  });

  it("another tenant's tracked report to this requestRef → BinViewNotFoundError, nothing written", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const requestRef = await requestRefFor(env!.admin, RUN_ISOLATION);
    await expect(
      service.reportSnapshot({
        tenantId: TENANT_B,
        requestRef,
        body: TRACKED_REPORT,
        idempotencyKey: "rt919-tracked-4",
      }),
    ).rejects.toBeInstanceOf(BinViewNotFoundError);
    expect(await storedEntries(RUN_ISOLATION)).toEqual([]);
  });
});
