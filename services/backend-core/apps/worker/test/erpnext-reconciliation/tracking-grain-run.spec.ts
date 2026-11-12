/**
 * RT-453 — the 017 stock run births identities from its tracking master read
 * (G7-3) and, once the store has its per-identity anchor, reconciles a
 * batch-tracked product at (tenant, bucket, item, tracking identity) with the
 * tracking-mismatch class (G7-12; RT-428 comment 11774). Testcontainers;
 * drives `ReconciliationRunProcessor` with the live `ReportBackedBinView`.
 *
 * Proves:
 *   - a run births the identities its report names (and a re-delivered run
 *     births none again);
 *   - before the identity anchor, the product keeps the RT-428 product grain;
 *   - after it, one result per identity replaces the product line: match,
 *     the stale-snapshot class, a divergence, and `erpnext_only` for a Batch
 *     with no position;
 *   - `tracking_mismatch` names a Batch without an identity, missing tracking
 *     evidence and untracked effects;
 *   - a run changes no effect and no identity quantity (explanatory only).
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1. Run with WORKER_INCLUDE_DB_TESTS=1.
 */
import { activateSaleEffects, anchorTrackedIdentities, runWithTenantContext } from "@data-pulse-2/db";

import {
  seedPendingAwareTenant,
  seedSalePosting,
  startMigratedEnvOrSkip,
  type PendingAwareTenant,
} from "../../../../packages/db/__tests__/_helpers/pending-aware-fixture";
import { stopPgEnv, type PgTestEnv } from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { ReconciliationRunProcessor } from "../../src/erpnext-reconciliation/reconciliation-run.processor";
import { ReportBackedBinView } from "../../src/erpnext-reconciliation/report-backed-bin-view";

const ACTOR = "01900000-0000-7000-8000-0000004530ad";

let env: PgTestEnv | null = null;
let skip = false;
let seq = 0;

function uuid(): string {
  seq += 1;
  return `01900000-0000-7000-8000-${(0x453000000000 + seq).toString(16)}`;
}

function guard(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

interface BatchEvidence {
  readonly name: string;
  readonly quantity: string;
  readonly expiryDate?: string | null;
}

const tracking = (batches: readonly BatchEvidence[]) => ({
  hasBatchNo: true,
  hasSerialNo: false,
  hasExpiryDate: true,
  batches: batches.map((b) => ({
    batchRef: { doctype: "Batch", name: b.name },
    quantity: b.quantity,
    expiryDate: b.expiryDate === undefined ? "2027-12-31" : b.expiryDate,
    disabled: false,
  })),
});

/** A stock run carrying a recorded Bin report of P (ITEM-1). `tracking: null` = an older Connector. */
async function seedRun(
  f: PendingAwareTenant,
  opts: { status: "running" | "completed"; quantity: string; readAt: string; batches: readonly BatchEvidence[] | null },
): Promise<string> {
  const runId = uuid();
  const report = {
    runRef: runId,
    erpnextWarehouseRef: f.warehouse,
    readAt: opts.readAt,
    recordedAt: opts.readAt,
    complete: true,
    entries: [
      {
        erpnextItemRef: "ITEM-1",
        tenant_product_ref: f.productId,
        quantity: opts.quantity,
        stockUom: "Nos",
        ...(opts.batches === null ? {} : { tracking: tracking(opts.batches) }),
      },
    ],
  };
  await guard().admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, actor_user_id, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', $4, $5, CASE WHEN $4 = 'completed' THEN now() END, $6::jsonb)`,
    [runId, f.tenantId, f.storeId, opts.status, ACTOR, JSON.stringify({ bin_view_report: report })],
  );
  return runId;
}

const asTenant = <T>(f: PendingAwareTenant, work: Parameters<typeof runWithTenantContext<T>>[2]): Promise<T> =>
  runWithTenantContext(guard().app, { tenantId: f.tenantId, isPlatformAdmin: false }, work);

interface ResultRow {
  mismatch_class: string;
  source_ref_id: string | null;
  detail: Record<string, unknown> | null;
}

async function reconcile(
  f: PendingAwareTenant,
  bin: { quantity: string; batches: readonly BatchEvidence[] | null; readAt?: string },
): Promise<{ rows: ResultRow[]; identities: unknown }> {
  const e = guard();
  const runId = await seedRun(f, { status: "running", readAt: bin.readAt ?? new Date().toISOString(), ...bin });
  const res = await new ReconciliationRunProcessor(e.app, new ReportBackedBinView(e.app)).process({
    runId,
    tenantId: f.tenantId,
  });
  expect(res.status).toBe("completed");
  const r = await e.admin.query<ResultRow>(
    `SELECT mismatch_class, source_ref_id::text AS source_ref_id, detail FROM erpnext_reconciliation_result
      WHERE run_id = $1 ORDER BY mismatch_class, detail->>'erpnext_batch_ref'`,
    [runId],
  );
  return { rows: r.rows, identities: res.identities };
}

/** A tenant whose product P is batch-tracked, activated from a snapshot of P = 10 (B-1 6, B-2 4). */
async function seedTenant(): Promise<PendingAwareTenant> {
  const f = await seedPendingAwareTenant(guard().admin, {
    tenantId: uuid(),
    storeId: uuid(),
    productId: uuid(),
    slug: `rt453w-${seq}`,
    actorId: ACTOR,
  });
  await guard().admin.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [f.productId]);
  await seedRun(f, {
    status: "completed",
    quantity: "10",
    readAt: new Date(Date.now() - 600_000).toISOString(),
    batches: [
      { name: "B-1", quantity: "6" },
      { name: "B-2", quantity: "4" },
    ],
  });
  const outcome = await asTenant(f, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
  if (outcome.kind !== "activated") throw new Error(`not activated: ${JSON.stringify(outcome)}`);
  return f;
}

/** Birth B-1 / B-2 through a run, then take the identity anchor from that run's snapshot. */
async function anchored(): Promise<PendingAwareTenant> {
  const f = await seedTenant();
  await reconcile(f, {
    quantity: "10",
    readAt: new Date(Date.now() - 300_000).toISOString(),
    batches: [
      { name: "B-1", quantity: "6" },
      { name: "B-2", quantity: "4" },
    ],
  });
  const outcome = await asTenant(f, (c) => anchorTrackedIdentities(c, { tenantId: f.tenantId, actorId: ACTOR }));
  if (outcome.kind !== "anchored") throw new Error(`not anchored: ${JSON.stringify(outcome)}`);
  return f;
}

async function identityOf(f: PendingAwareTenant, batch: string): Promise<string> {
  const r = await guard().admin.query<{ id: string }>(
    `SELECT tracking_identity_id::text AS id FROM erpnext_tracking_map WHERE tenant_id = $1 AND erpnext_ref = $2`,
    [f.tenantId, batch],
  );
  return r.rows[0]!.id;
}

/**
 * A sale effect at an identity that ERPNext booked at `confirmedAt` (`confirmed`,
 * linked to its posted `sale_post` row), or, with `state: "not_posted"`, a
 * manual adjustment with no ERP intent yet.
 */
async function seedEffect(
  f: PendingAwareTenant,
  identityId: string | null,
  quantity: string,
  opts: { readonly state: "confirmed" | "not_posted"; readonly confirmedAt?: Date },
): Promise<void> {
  const a = guard().admin;
  const effectId = uuid();
  const sale = opts.state === "confirmed";
  await a.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
                                  occurred_at, created_by, origin, event_type, event_ref_id, stock_location_id,
                                  inventory_status, tracking_identity_id)
     VALUES ($1, $2, $3, $4, $5::numeric, 'Nos', $6, now(), $7, 'retail', $8, $9, $10, 'sellable', $11)`,
    [effectId, f.tenantId, f.storeId, Number(quantity) < 0 ? "outbound" : "adjustment", quantity, f.productId, ACTOR,
      sale ? "sale" : "adjustment", uuid(), f.locationId, identityId],
  );
  const postingId = sale ? await seedSalePosting(a, f, { saleId: uuid(), actorId: ACTOR, status: "posted" }) : null;
  await a.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, posting_status_id, erp_document_ref, erp_confirmed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'confirmed' THEN '{"name":"SINV"}' END, $5)`,
    [effectId, f.tenantId, opts.state, postingId, sale ? (opts.confirmedAt ?? new Date()) : null],
  );
}

beforeAll(async () => {
  env = await startMigratedEnvOrSkip("tracking-grain-run.spec");
  skip = env === null;
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("identity birth in the 017 run (G7-3)", () => {
  it("births the Batches the report names, once, and keeps the product grain before the identity anchor", async () => {
    if (skip) return;
    const f = await seedTenant();
    const batches = [
      { name: "B-1", quantity: "6" },
      { name: "B-2", quantity: "4" },
    ];
    const first = await reconcile(f, { quantity: "10", batches });
    expect(first.identities).toEqual({ born: 2, existing: 0, expiryCorrected: 0, refused: [] });
    // No identity anchor yet: one RT-428 product-grain line.
    expect(first.rows.map((r) => [r.mismatch_class, r.source_ref_id, r.detail?.["grain"] ?? null])).toEqual([
      ["match", f.productId, null],
    ]);
    const second = await reconcile(f, { quantity: "10", batches });
    expect(second.identities).toEqual({ born: 0, existing: 2, expiryCorrected: 0, refused: [] });
    const n = await guard().admin.query(`SELECT 1 FROM tracking_identities WHERE tenant_id = $1`, [f.tenantId]);
    expect(n.rowCount).toBe(2);
  });
});

describe("tracking-grain reconciliation (G7-12)", () => {
  it("compares per identity instead of per product once the store has its identity anchor", async () => {
    if (skip) return;
    const f = await anchored();
    const { rows } = await reconcile(f, {
      quantity: "10",
      batches: [
        { name: "B-1", quantity: "6" },
        { name: "B-2", quantity: "4" },
      ],
    });
    expect(rows.map((r) => [r.mismatch_class, r.detail?.["erpnext_batch_ref"], r.detail?.["grain"]])).toEqual([
      ["match", "B-1", "tracking_identity"],
      ["match", "B-2", "tracking_identity"],
    ]);
    expect(rows.every((r) => r.source_ref_id === f.productId)).toBe(true);
    expect(rows[0]!.detail?.["tracking_identity_id"]).toBe(await identityOf(f, "B-1"));
  });

  it("classes a stale snapshot, a divergence, and an omitted Batch as zero", async () => {
    if (skip) return;
    const f = await anchored();
    const b1 = await identityOf(f, "B-1");
    // ERPNext booked -1 on B-1 now; the Bin below was read a minute earlier.
    await seedEffect(f, b1, "-1", { state: "confirmed", confirmedAt: new Date() });
    const { rows } = await reconcile(f, {
      quantity: "8",
      readAt: new Date(Date.now() - 60_000).toISOString(),
      // B-1 still 6 (read before the booking); B-2 omitted (zero in ERPNext, RT-918) but 4 here.
      batches: [{ name: "B-1", quantity: "6" }],
    });
    const byBatch = Object.fromEntries(rows.map((r) => [r.detail?.["erpnext_batch_ref"], r]));
    expect(byBatch["B-1"]!.mismatch_class).toBe("erp_snapshot_stale");
    expect(byBatch["B-2"]!.mismatch_class).toBe("quantity_divergence");
    expect(byBatch["B-2"]!.detail?.["erpnext_bin"]).toBe("0");
  });

  it("lists a known identity with ERP stock but no position as erpnext_only", async () => {
    if (skip) return;
    const f = await anchored();
    const { rows, identities } = await reconcile(f, {
      quantity: "13",
      batches: [
        { name: "B-1", quantity: "6" },
        { name: "B-2", quantity: "4" },
        { name: "B-3", quantity: "3" },
      ],
    });
    // B-3 is born by this run, after the anchor: no anchor line, no effect.
    expect(identities).toEqual({ born: 1, existing: 2, expiryCorrected: 0, refused: [] });
    const b3 = rows.find((r) => r.detail?.["erpnext_batch_ref"] === "B-3")!;
    expect(b3.mismatch_class).toBe("erpnext_only");
    expect(b3.detail?.["tracking_identity_id"]).toBe(await identityOf(f, "B-3"));
  });

  it("names what keeps a product from tracking grain: a Batch without identity and untracked effects", async () => {
    if (skip) return;
    const f = await anchored();
    await seedEffect(f, null, "2", { state: "not_posted" });
    const { rows } = await reconcile(f, {
      quantity: "11",
      batches: [
        { name: "B-1", quantity: "6" },
        { name: "B-2", quantity: "4" },
        { name: " NOT-A-CODE", quantity: "1" },
      ],
    });
    const mismatch = rows.filter((r) => r.mismatch_class === "tracking_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.source_ref_id).toBe(f.productId);
    expect(mismatch[0]!.detail).toEqual(
      expect.objectContaining({
        grain: "tracking",
        reasons: ["batch_without_identity", "untracked_effects"],
        erpnext_batch_refs: [" NOT-A-CODE"],
        untracked_quantity: "2.0000",
        untracked_effects: 1,
      }),
    );
  });

  it("flags stock the Item holds outside its Batches (review finding 9)", async () => {
    if (skip) return;
    const f = await anchored();
    const { rows } = await reconcile(f, {
      quantity: "12",
      batches: [
        { name: "B-1", quantity: "6" },
        { name: "B-2", quantity: "4" },
      ],
    });
    const mismatch = rows.filter((r) => r.mismatch_class === "tracking_mismatch");
    expect(mismatch.map((r) => r.detail)).toEqual([
      expect.objectContaining({
        reasons: ["batches_differ_from_item"],
        erpnext_item_quantity: "12",
        erpnext_batches_total: "10",
      }),
    ]);
    // The identities themselves still match.
    expect(rows.filter((r) => r.mismatch_class === "match")).toHaveLength(2);
  });

  it("does not compare identities without tracking evidence (an older Connector), and says so", async () => {
    if (skip) return;
    const f = await anchored();
    const { rows } = await reconcile(f, { quantity: "10", batches: null });
    expect(rows.map((r) => [r.mismatch_class, r.detail?.["reasons"]])).toEqual([
      ["tracking_mismatch", ["tracking_evidence_missing"]],
    ]);
  });

  it("is explanatory: the run writes no effect and changes no identity", async () => {
    if (skip) return;
    const f = await anchored();
    const before = await guard().admin.query(
      `SELECT (SELECT count(*) FROM stock_movements WHERE tenant_id = $1)::int AS m,
              (SELECT count(*) FROM tracking_identities WHERE tenant_id = $1)::int AS i`,
      [f.tenantId],
    );
    await reconcile(f, { quantity: "1", batches: [{ name: "B-1", quantity: "1" }] });
    const after = await guard().admin.query(
      `SELECT (SELECT count(*) FROM stock_movements WHERE tenant_id = $1)::int AS m,
              (SELECT count(*) FROM tracking_identities WHERE tenant_id = $1)::int AS i`,
      [f.tenantId],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
