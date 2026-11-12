/**
 * RT-453 — Tracking Identity birth from the Connector tracking master read,
 * the per-identity Inventory Anchor and the identity-grain positions, against
 * a real Postgres with every migration applied.
 *
 * Every call runs on the non-superuser `app_test` pool inside
 * `runWithTenantContext` (RLS + FORCE), as the worker and the CLI do;
 * fixtures are seeded on the superuser pool. Each case uses its own tenant.
 *
 * Proves (RT-453 acceptance criteria):
 *   - a tracking master read creates identities and their edge maps (code =
 *     the Batch name, expiry from the evidence, a birth record naming the run);
 *   - an unknown Item, an untracked product and an Item whose ERP flags
 *     disagree with the profile are not projected;
 *   - a re-read never duplicates;
 *   - an expiry change in later evidence goes through the governed correction
 *     (history row, Safety Revision step); clearing a required expiry is refused;
 *   - Retail Tower never invents: an expiry-required Batch without an expiry,
 *     a name that is not a lot code and another product's Batch are refused;
 *   - the anchor per identity matches the evidence; its refusals write nothing;
 *   - identity positions count only the effects the anchor does not cover;
 *   - cross-tenant isolation.
 */
import type { PoolClient } from "pg";

import { activateSaleEffects } from "../../src/helpers/inventory-effects/activation";
import {
  anchorTrackedIdentities,
  hasIdentityAnchor,
  readIdentityPositions,
  readUntrackedTrackedEffects,
} from "../../src/helpers/inventory-effects/identity-anchor";
import {
  applyTrackingMasterEvidence,
  birthBatchIdentity,
  lockIdentityBirth,
  lotCodeFromBatchName,
} from "../../src/helpers/inventory-effects/identity-birth";
import { runWithTenantContext } from "../../src/middleware/tenant-context";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const ACTOR = "0a000000-0000-7000-8000-000000453c00";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

function uuid(): string {
  seq += 1;
  return `0a000000-0000-7000-8000-${(0x453c00000000 + seq).toString(16)}`;
}

interface Batch {
  readonly name: string;
  readonly quantity: string;
  readonly expiryDate: string | null;
  readonly disabled?: boolean;
}

interface Entry {
  readonly item: string;
  readonly quantity: string;
  /** Omitted: an older Connector (tracking UNKNOWN). */
  readonly tracking?: { hasBatchNo: boolean; hasSerialNo: boolean; hasExpiryDate: boolean; batches?: Batch[] };
}

interface Fixture {
  readonly tenantId: string;
  readonly storeId: string;
  readonly warehouse: string;
  /** EXP: batch + expiry required (ITEM-EXP); LOT: batch, no expiry (ITEM-LOT); PLAIN: none (ITEM-PLAIN). */
  readonly products: Record<"EXP" | "LOT" | "PLAIN", string>;
}

async function seedTenant(): Promise<Fixture> {
  const a = pg().admin;
  const tenantId = uuid();
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenantId, `rt453-${seq}`]);
  const products = {} as Record<"EXP" | "LOT" | "PLAIN", string>;
  for (const [name, item, mode, expiry] of [
    ["EXP", "ITEM-EXP", "batch", true],
    ["LOT", "ITEM-LOT", "batch", false],
    ["PLAIN", "ITEM-PLAIN", "none", false],
  ] as const) {
    const id = uuid();
    products[name] = id;
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required)
       VALUES ($1, $2, $3, 'standard', $4, $4, $5, $6)`,
      [id, tenantId, name, ACTOR, mode, expiry],
    );
    await a.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())`,
      [tenantId, id, item, ACTOR],
    );
  }
  const storeId = uuid();
  const warehouse = `WH-${seq}`;
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'S')`, [storeId, tenantId, `S${seq}`]);
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', $3, $4, 1)`,
    [tenantId, storeId, warehouse, ACTOR],
  );
  return { tenantId, storeId, warehouse, products };
}

const TRACKED = (batches: Batch[], flags: Partial<{ hasBatchNo: boolean; hasSerialNo: boolean; hasExpiryDate: boolean }> = {}) => ({
  hasBatchNo: true,
  hasSerialNo: false,
  hasExpiryDate: true,
  ...flags,
  batches,
});

/** A complete (or partial) Bin report recorded on a stock run of the store; returns the run id. */
async function seedRun(
  f: Fixture,
  entries: readonly Entry[],
  opts: { readAt?: string; complete?: boolean; status?: string } = {},
): Promise<string> {
  const runId = uuid();
  const readAt = opts.readAt ?? new Date().toISOString();
  const stored = entries.map((e) => ({
    erpnextItemRef: e.item,
    tenant_product_ref: null,
    quantity: e.quantity,
    stockUom: "Nos",
    ...(e.tracking === undefined
      ? {}
      : {
          tracking: {
            hasBatchNo: e.tracking.hasBatchNo,
            hasSerialNo: e.tracking.hasSerialNo,
            hasExpiryDate: e.tracking.hasExpiryDate,
            ...(e.tracking.batches === undefined
              ? {}
              : {
                  batches: e.tracking.batches.map((b) => ({
                    batchRef: { doctype: "Batch", name: b.name },
                    quantity: b.quantity,
                    expiryDate: b.expiryDate,
                    disabled: b.disabled ?? false,
                  })),
                }),
          },
        }),
  }));
  const report = {
    requestRef: uuid(),
    runRef: runId,
    erpnextWarehouseRef: f.warehouse,
    attemptRef: null,
    readAt,
    recordedAt: readAt,
    complete: opts.complete ?? true,
    windowsRecorded: 1,
    acceptedEntryCount: stored.length,
    windows: [],
    entries: stored,
    supersededAttemptRefs: [],
  };
  const status = opts.status ?? "completed";
  await pg().admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES ($1, $2, $3, 'stock', 'on_demand', $5, CASE WHEN $5 = 'running' THEN NULL ELSE now() END, $4::jsonb)`,
    [runId, f.tenantId, f.storeId, JSON.stringify({ bin_view_report: report }), status],
  );
  return runId;
}

function asTenant<T>(f: Pick<Fixture, "tenantId">, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(pg().app, { tenantId: f.tenantId, isPlatformAdmin: false }, work);
}

const master = (f: Fixture, runId: string) =>
  asTenant(f, (c) => applyTrackingMasterEvidence(c, { tenantId: f.tenantId, runId }));

async function identities(f: Fixture): Promise<Array<{ product: string; code: string; expiry: string | null; ref: string | null }>> {
  const r = await pg().admin.query<{ product: string; code: string; expiry: string | null; ref: string | null }>(
    `SELECT i.tenant_product_ref::text AS product, i.code, i.expiry_date::text AS expiry, m.erpnext_ref AS ref
       FROM tracking_identities i LEFT JOIN erpnext_tracking_map m ON m.tracking_identity_id = i.id
      WHERE i.tenant_id = $1 ORDER BY i.code`,
    [f.tenantId],
  );
  return r.rows;
}

async function identityId(f: Fixture, code: string): Promise<string> {
  const r = await pg().admin.query<{ id: string }>(`SELECT id FROM tracking_identities WHERE tenant_id = $1 AND code = $2`, [
    f.tenantId,
    code,
  ]);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[tracking-identity-birth.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("lotCodeFromBatchName (B3: the code is the Batch name as reported)", () => {
  it.each<[string, string | null]>([
    ["LOT-2026-01", "LOT-2026-01"],
    ["lot 7/a", "lot 7/a"],
    [" LOT", null],
    ["LOT ", null],
    ["", null],
    ["x".repeat(128), "x".repeat(128)],
    ["x".repeat(129), null],
  ])("%j → %j", (name, code) => {
    expect(lotCodeFromBatchName(name)).toBe(code);
  });
});

describe("identity birth from the tracking master read (G7-3)", () => {
  it("creates identities and edge maps from the evidence, with a birth record naming the run", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const run = await seedRun(f, [
      { item: "ITEM-EXP", quantity: "9", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate: "2027-03-31" }, { name: "B-2", quantity: "3", expiryDate: "2027-06-30" }]) },
      { item: "ITEM-LOT", quantity: "2", tracking: TRACKED([{ name: "L-1", quantity: "2", expiryDate: null }], { hasExpiryDate: false }) },
      { item: "ITEM-PLAIN", quantity: "5", tracking: { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false } },
    ]);
    const summary = await master(f, run);
    expect(summary).toEqual({ born: 3, existing: 0, expiryCorrected: 0, refused: [] });
    expect(await identities(f)).toEqual([
      { product: f.products.EXP, code: "B-1", expiry: "2027-03-31", ref: "B-1" },
      { product: f.products.EXP, code: "B-2", expiry: "2027-06-30", ref: "B-2" },
      { product: f.products.LOT, code: "L-1", expiry: null, ref: "L-1" },
    ]);
    const births = await pg().admin.query<{ source: string; run: string; batch: string; item: string }>(
      `SELECT source, reconciliation_run_id::text AS run, erpnext_batch_ref AS batch, erpnext_item_ref AS item
         FROM tracking_identity_births WHERE tenant_id = $1 ORDER BY batch`,
      [f.tenantId],
    );
    expect(births.rows).toEqual([
      { source: "tracking_master", run, batch: "B-1", item: "ITEM-EXP" },
      { source: "tracking_master", run, batch: "B-2", item: "ITEM-EXP" },
      { source: "tracking_master", run, batch: "L-1", item: "ITEM-LOT" },
    ]);
    const origin = await pg().admin.query(`SELECT DISTINCT origin FROM tracking_identities WHERE tenant_id = $1`, [f.tenantId]);
    expect(origin.rows).toEqual([{ origin: "erp_external" }]);
  });

  it("a re-read never duplicates (same run again, and a later run with the same Batches)", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const entries: Entry[] = [
      { item: "ITEM-EXP", quantity: "6", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate: "2027-03-31" }]) },
    ];
    const run = await seedRun(f, entries);
    expect((await master(f, run)).born).toBe(1);
    expect(await master(f, run)).toEqual({ born: 0, existing: 1, expiryCorrected: 0, refused: [] });
    expect(await master(f, await seedRun(f, entries))).toEqual({ born: 0, existing: 1, expiryCorrected: 0, refused: [] });
    expect(await identities(f)).toHaveLength(1);
    const births = await pg().admin.query(`SELECT 1 FROM tracking_identity_births WHERE tenant_id = $1`, [f.tenantId]);
    expect(births.rowCount).toBe(1);
  });

  it("does not project an unknown Item, an untracked product, disagreeing flags, or an incomplete report", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const run = await seedRun(f, [
      { item: "ITEM-UNKNOWN", quantity: "1", tracking: TRACKED([{ name: "U-1", quantity: "1", expiryDate: "2027-01-01" }]) },
      // The profile says none: ERP batches are a flag mismatch finding, never a birth.
      { item: "ITEM-PLAIN", quantity: "1", tracking: TRACKED([{ name: "P-1", quantity: "1", expiryDate: "2027-01-01" }]) },
      // The profile says batch, ERP says not batch-tracked.
      { item: "ITEM-EXP", quantity: "1", tracking: TRACKED([{ name: "E-1", quantity: "1", expiryDate: "2027-01-01" }], { hasBatchNo: false }) },
      // No tracking evidence at all (an older Connector).
      { item: "ITEM-LOT", quantity: "1" },
    ]);
    expect(await master(f, run)).toEqual({ born: 0, existing: 0, expiryCorrected: 0, refused: [] });
    const partial = await seedRun(
      f,
      [{ item: "ITEM-LOT", quantity: "1", tracking: TRACKED([{ name: "L-9", quantity: "1", expiryDate: null }]) }],
      { complete: false },
    );
    expect((await master(f, partial)).born).toBe(0);
    expect(await identities(f)).toEqual([]);
  });

  it("never invents: refuses a required expiry missing, a name that is not a code, and another product's Batch", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await master(f, await seedRun(f, [
      { item: "ITEM-LOT", quantity: "1", tracking: TRACKED([{ name: "SHARED", quantity: "1", expiryDate: null }]) },
    ]));
    const summary = await master(f, await seedRun(f, [
      {
        item: "ITEM-EXP",
        quantity: "3",
        tracking: TRACKED([
          { name: "NO-EXPIRY", quantity: "1", expiryDate: null },
          { name: " PADDED", quantity: "1", expiryDate: "2027-01-01" },
          { name: "SHARED", quantity: "1", expiryDate: "2027-01-01" },
        ]),
      },
    ]));
    expect(summary.born).toBe(0);
    expect([...summary.refused].sort((x, y) => x.erpnextBatchRef.localeCompare(y.erpnextBatchRef))).toEqual([
      { erpnextBatchRef: " PADDED", reason: "code_unrepresentable" },
      { erpnextBatchRef: "NO-EXPIRY", reason: "expiry_required" },
      { erpnextBatchRef: "SHARED", reason: "batch_of_other_product" },
    ]);
    expect((await identities(f)).map((i) => i.code)).toEqual(["SHARED"]);
  });

  it("refuses a code an existing identity of the product holds under another Batch (never re-associated)", async () => {
    if (skip()) return;
    const f = await seedTenant();
    // A legacy identity with no edge map, as a seed would leave it.
    await pg().admin.query(
      `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code, expiry_date, origin)
       VALUES ($1, $2, 'batch', 'ORPHAN', '2027-01-01', 'erp_external')`,
      [f.tenantId, f.products.EXP],
    );
    const outcome = await asTenant(f, async (c) => {
      await lockIdentityBirth(c, f.tenantId);
      return birthBatchIdentity(c, {
        tenantId: f.tenantId,
        productId: f.products.EXP,
        erpnextItemRef: "ITEM-EXP",
        batchName: "ORPHAN",
        expiryDate: "2027-01-01",
      });
    });
    expect(outcome).toEqual({ kind: "refused", reason: "code_taken" });
    const maps = await pg().admin.query(`SELECT 1 FROM erpnext_tracking_map WHERE tenant_id = $1`, [f.tenantId]);
    expect(maps.rowCount).toBe(0);
  });
});

describe("expiry from ERP evidence (the governed RT-449 correction)", () => {
  it("records a correction, steps the Safety Revision once, and updates the identity", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const first = await seedRun(
      f,
      [{ item: "ITEM-EXP", quantity: "6", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate: "2027-03-31" }]) }],
      { readAt: new Date(Date.now() - 120_000).toISOString() },
    );
    await master(f, first);
    const second = await seedRun(
      f,
      [{ item: "ITEM-EXP", quantity: "6", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate: "2027-04-30" }]) }],
      { readAt: new Date(Date.now() - 60_000).toISOString() },
    );
    expect(await master(f, second)).toEqual({ born: 0, existing: 1, expiryCorrected: 1, refused: [] });
    // The same run again: unchanged, no second correction.
    expect((await master(f, second)).expiryCorrected).toBe(0);
    expect((await identities(f))[0]!.expiry).toBe("2027-04-30");
    const corrections = await pg().admin.query<{ old: string; new: string; reason: string; by: string; note: string | null }>(
      `SELECT old_expiry_date::text AS old, new_expiry_date::text AS new, reason_code AS reason, created_by::text AS by, note
         FROM tracking_identity_expiry_corrections WHERE tenant_id = $1`,
      [f.tenantId],
    );
    expect(corrections.rows).toEqual([{ old: "2027-03-31", new: "2027-04-30", reason: "erp_evidence", by: second, note: null }]);
    const revision = await pg().admin.query<{ revision: string; kind: string }>(
      `SELECT r.revision::text AS revision, c.kind FROM tenant_inventory_safety_revisions r
         JOIN inventory_safety_changes c ON c.tenant_id = r.tenant_id AND c.revision = r.revision
        WHERE r.tenant_id = $1`,
      [f.tenantId],
    );
    expect(revision.rows).toEqual([{ revision: "1", kind: "expiry_corrected" }]);
  });

  it("never clears a required expiry", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await master(f, await seedRun(f, [
      { item: "ITEM-EXP", quantity: "6", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate: "2027-03-31" }]) },
    ], { readAt: new Date(Date.now() - 120_000).toISOString() }));
    const summary = await master(f, await seedRun(f, [
      { item: "ITEM-EXP", quantity: "6", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate: null }]) },
    ], { readAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(summary.refused).toEqual([{ erpnextBatchRef: "B-1", reason: "expiry_required_cleared" }]);
    expect((await identities(f))[0]!.expiry).toBe("2027-03-31");
  });
});

describe("expiry evidence order (review: an older read never rolls the expiry back)", () => {
  const evidence = (expiryDate: string): Entry[] => [
    { item: "ITEM-EXP", quantity: "6", tracking: TRACKED([{ name: "B-1", quantity: "6", expiryDate }]) },
  ];

  it("ignores a run read before the evidence already applied, and a retried run's recorded correction", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const t = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await master(f, await seedRun(f, evidence("2027-03-31"), { readAt: t(30) }));
    // Two later reads, processed out of order: T(10) first, then the older T(20).
    const newer = await seedRun(f, evidence("2027-05-31"), { readAt: t(10) });
    const older = await seedRun(f, evidence("2027-04-30"), { readAt: t(20) });
    expect((await master(f, newer)).expiryCorrected).toBe(1);
    expect((await master(f, older)).expiryCorrected).toBe(0);
    expect((await identities(f))[0]!.expiry).toBe("2027-05-31");
    // A still newer read moves it; then the T(10) run is retried: its correction is
    // recorded, so the retry neither repeats it nor fails on its fingerprint.
    await master(f, await seedRun(f, evidence("2027-06-30"), { readAt: t(5) }));
    expect(await master(f, newer)).toEqual({ born: 0, existing: 1, expiryCorrected: 0, refused: [] });
    expect((await identities(f))[0]!.expiry).toBe("2027-06-30");
  });

  it("never overrides a person's correction made after the evidence was read", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const stale = new Date(Date.now() - 60_000).toISOString();
    await master(f, await seedRun(f, evidence("2027-03-31"), { readAt: new Date(Date.now() - 120_000).toISOString() }));
    const id = await identityId(f, "B-1");
    // A person's governed correction now (as IdentityExpiryService writes it).
    await asTenant(f, async (c) => {
      await c.query(
        `INSERT INTO tracking_identity_expiry_corrections
           (tenant_id, tracking_identity_id, tenant_product_ref, old_expiry_date, new_expiry_date, reason_code,
            command_fingerprint, created_by)
         VALUES ($1, $2, $3, '2027-03-31', '2027-02-28', 'supplier_notice', repeat('b', 64), $4)`,
        [f.tenantId, id, f.products.EXP, ACTOR],
      );
      await c.query(`UPDATE tracking_identities SET expiry_date = '2027-02-28' WHERE id = $1`, [id]);
    });
    expect((await master(f, await seedRun(f, evidence("2027-03-31"), { readAt: stale }))).expiryCorrected).toBe(0);
    expect((await identities(f))[0]!.expiry).toBe("2027-02-28");
  });
});

describe("cross-tenant isolation", () => {
  it("births per tenant (the same Batch name is two identities) and one tenant never sees the other's", async () => {
    if (skip()) return;
    const a = await seedTenant();
    const b = await seedTenant();
    const evidence: Entry[] = [
      { item: "ITEM-EXP", quantity: "1", tracking: TRACKED([{ name: "SAME", quantity: "1", expiryDate: "2027-01-01" }]) },
    ];
    await master(a, await seedRun(a, evidence));
    // Tenant A cannot apply tenant B's run: under A's context B's run reads as nothing.
    const bRun = await seedRun(b, evidence);
    expect(await asTenant(a, (c) => applyTrackingMasterEvidence(c, { tenantId: a.tenantId, runId: bRun }))).toEqual({
      born: 0,
      existing: 0,
      expiryCorrected: 0,
      refused: [],
    });
    await master(b, bRun);
    expect((await identities(a)).map((i) => i.product)).toEqual([a.products.EXP]);
    expect((await identities(b)).map((i) => i.product)).toEqual([b.products.EXP]);
    const seen = await asTenant(a, (c) => c.query(`SELECT count(*)::int AS n FROM tracking_identity_births`));
    expect(seen.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The per-identity anchor (G7-12, DC-8)
// ---------------------------------------------------------------------------

const anchor = (f: Fixture) => asTenant(f, (c) => anchorTrackedIdentities(c, { tenantId: f.tenantId, actorId: ACTOR }));

/** Activate sale effects for the tenant from a first (untracked-only) snapshot. */
async function activate(f: Fixture): Promise<void> {
  await seedRun(f, [{ item: "ITEM-PLAIN", quantity: "5", tracking: { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false } }], {
    readAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const outcome = await asTenant(f, (c) => activateSaleEffects(c, { tenantId: f.tenantId, actorId: ACTOR }));
  expect(outcome.kind).toBe("activated");
}

const EVIDENCE: Entry[] = [
  {
    item: "ITEM-EXP",
    quantity: "9",
    tracking: TRACKED([
      { name: "B-1", quantity: "6.500000", expiryDate: "2027-03-31" },
      { name: "B-2", quantity: "-1", expiryDate: "2027-06-30" },
    ]),
  },
  { item: "ITEM-PLAIN", quantity: "5", tracking: { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false } },
];

describe("anchorTrackedIdentities", () => {
  it("refuses while sale effects are off, and writes nothing", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await seedRun(f, EVIDENCE);
    expect(await anchor(f)).toEqual({ kind: "refused", refusal: { code: "sale_effects_inactive", storeIds: [] } });
  });

  it("refuses a tracked entry without evidence, and a reported Batch with no identity", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await activate(f);
    await seedRun(f, [{ item: "ITEM-EXP", quantity: "9" }]);
    expect(await anchor(f)).toEqual({
      kind: "refused",
      refusal: { code: "tracking_evidence_missing", storeIds: [f.storeId], detail: [{ erpnextItemRef: "ITEM-EXP" }] },
    });
    await seedRun(f, EVIDENCE);
    expect(await anchor(f)).toEqual({
      kind: "refused",
      refusal: {
        code: "identities_unborn",
        storeIds: [f.storeId],
        detail: [
          { erpnextItemRef: "ITEM-EXP", erpnextBatchRef: "B-1" },
          { erpnextItemRef: "ITEM-EXP", erpnextBatchRef: "B-2" },
        ],
      },
    });
    const n = await pg().admin.query(`SELECT 1 FROM inventory_identity_anchors WHERE tenant_id = $1`, [f.tenantId]);
    expect(n.rowCount).toBe(0);
  });

  it("anchors each identity at its batch-wise Bin quantity, and a second anchor is generation 2", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await activate(f);
    const run = await seedRun(f, EVIDENCE);
    await master(f, run);
    const outcome = await anchor(f);
    expect(outcome.kind).toBe("anchored");
    if (outcome.kind !== "anchored") return;
    expect(outcome.stores).toEqual([
      expect.objectContaining({ storeId: f.storeId, generation: 1, sourceRunId: run, lines: 2, absorbedIdentityEffects: 0 }),
    ]);
    const lines = await pg().admin.query<{ code: string; quantity: string; uom: string; batch: string }>(
      `SELECT i.code, l.quantity::text AS quantity, l.erp_stock_uom AS uom, l.erpnext_batch_ref AS batch
         FROM inventory_identity_anchor_lines l JOIN tracking_identities i ON i.id = l.tracking_identity_id
        WHERE l.tenant_id = $1 ORDER BY i.code`,
      [f.tenantId],
    );
    expect(lines.rows).toEqual([
      { code: "B-1", quantity: "6.500000", uom: "Nos", batch: "B-1" },
      { code: "B-2", quantity: "-1.000000", uom: "Nos", batch: "B-2" },
    ]);
    expect(await asTenant(f, (c) => hasIdentityAnchor(c, f.storeId))).toBe(true);
    const again = await anchor(f);
    expect(again.kind === "anchored" && again.stores[0]!.generation).toBe(2);
    // Nothing is a movement (779).
    const moves = await pg().admin.query(`SELECT 1 FROM stock_movements WHERE tenant_id = $1`, [f.tenantId]);
    expect(moves.rowCount).toBe(0);
  });
});

describe("anchorTrackedIdentities while tracked selling is on", () => {
  it("refuses (a re-anchor could race an in-flight identity sale effect)", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await activate(f);
    await master(f, await seedRun(f, EVIDENCE));
    await pg().admin.query(`UPDATE tenant_inventory_settings SET tracked_selling_enabled = true, tracked_selling_changed_at = now(), tracked_selling_changed_by = sale_effects_activated_by WHERE tenant_id = $1`, [
      f.tenantId,
    ]);
    expect(await anchor(f)).toEqual({ kind: "refused", refusal: { code: "tracked_selling_on", storeIds: [] } });
  });
});

describe("identity positions since the anchor", () => {
  async function effect(
    f: Fixture,
    o: { identity: string | null; product: string; quantity: string; origin: "retail" | "erp_external"; occurredAt: string; eventType: string },
  ): Promise<string> {
    const id = uuid();
    await pg().admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by,
          stock_location_id, inventory_status, origin, event_type, event_ref_id, source_system, external_id,
          tracking_identity_id)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::numeric < 0 THEN 'outbound' ELSE 'inbound' END, $5::numeric, 'Nos',
               $6::timestamptz, $7, (SELECT id FROM stock_locations WHERE store_id = $3 AND kind = 'primary'), 'sellable',
               $8, $9, $1, 'test', $11, $10)`,
      [id, f.tenantId, f.storeId, o.product, o.quantity, o.occurredAt, ACTOR, o.origin, o.eventType, o.identity, `k-${id}`],
    );
    if (o.origin === "erp_external") {
      // As the RT-1288 import writes it: ERP book already (`external`).
      await pg().admin.query(
        `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_document_ref, erp_confirmed_at)
         VALUES ($1, $2, 'external', '{"doctype":"Purchase Receipt","name":"PR"}', $3::timestamptz)`,
        [id, f.tenantId, o.occurredAt],
      );
    }
    return id;
  }

  it("adds only the effects the anchor does not cover, and lists untracked effects of a tracked product", async () => {
    if (skip()) return;
    const f = await seedTenant();
    await activate(f);
    const readAt = new Date(Date.now() - 5_000).toISOString();
    const run = await seedRun(f, EVIDENCE, { readAt });
    await master(f, run);
    const b1 = await identityId(f, "B-1");
    // An ERP receipt created BEFORE the snapshot read, imported after: the Bin holds it already.
    await effect(f, { identity: b1, product: f.products.EXP, quantity: "4", origin: "erp_external", occurredAt: new Date(Date.parse(readAt) - 1_000).toISOString(), eventType: "erp_procurement_receipt" });
    // Sales recorded BEFORE the anchor (untracked while the switch is off, and one at
    // the identity): the anchor's batch-wise Bin already holds them (review finding 1).
    await effect(f, { identity: null, product: f.products.EXP, quantity: "-3", origin: "retail", occurredAt: new Date().toISOString(), eventType: "sale" });
    await effect(f, { identity: b1, product: f.products.EXP, quantity: "-1", origin: "retail", occurredAt: new Date().toISOString(), eventType: "sale" });
    expect((await anchor(f)).kind).toBe("anchored");
    // After the anchor: an ERP receipt created after the read, and a retail adjustment.
    await effect(f, { identity: b1, product: f.products.EXP, quantity: "2", origin: "erp_external", occurredAt: new Date().toISOString(), eventType: "erp_procurement_receipt" });
    await effect(f, { identity: b1, product: f.products.EXP, quantity: "-0.5", origin: "retail", occurredAt: new Date().toISOString(), eventType: "adjustment" });
    // An effect of the tracked product without an identity.
    await effect(f, { identity: null, product: f.products.EXP, quantity: "1", origin: "retail", occurredAt: new Date().toISOString(), eventType: "adjustment" });
    const positions = await asTenant(f, (c) => readIdentityPositions(c, f.storeId));
    const p1 = positions.find((p) => p.trackingIdentityId === b1)!;
    expect(p1).toEqual(
      expect.objectContaining({
        anchorQuantity: "6.500000",
        operationalPosition: "8.000000",
        erpnextBatchRef: "B-1",
        operationalUnit: "Nos",
        erpStockUom: "Nos",
      }),
    );
    // The retail adjustment has no ERP intent yet: a pending Retail term.
    expect(p1.pendingRetail).toBe("-0.5000");
    expect(p1.expectedErpBook).toBe("8.500000");
    const p2 = positions.find((p) => p.erpnextBatchRef === "B-2")!;
    expect(p2.operationalPosition).toBe("-1.000000");
    expect(await asTenant(f, (c) => readUntrackedTrackedEffects(c, f.storeId))).toEqual([
      { tenantProductRef: f.products.EXP, quantity: "1.0000", effects: 1 },
    ]);
  });

  it("reads nothing for a store without an identity anchor, and nothing of another tenant", async () => {
    if (skip()) return;
    const f = await seedTenant();
    const other = await seedTenant();
    expect(await asTenant(f, (c) => readIdentityPositions(c, f.storeId))).toEqual([]);
    expect(await asTenant(f, (c) => hasIdentityAnchor(c, f.storeId))).toBe(false);
    await activate(other);
    await master(other, await seedRun(other, EVIDENCE));
    expect((await anchor(other)).kind).toBe("anchored");
    expect(await asTenant(f, (c) => readIdentityPositions(c, null))).toEqual([]);
    expect((await asTenant(other, (c) => readIdentityPositions(c, null))).length).toBe(2);
  });
});
