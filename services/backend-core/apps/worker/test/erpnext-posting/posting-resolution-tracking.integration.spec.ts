/**
 * RT-451 S6: the worker freezes each line's tracking with the posting intent's
 * resolution (migration 0095; posting-feed.yaml 1.10.0-draft
 * `erpnextBatchRef` / `trackingMode`; sales.yaml G7-9 rows 1 to 4).
 *
 * The real `PostingRequestedConsumer` runs as the app role (RLS) against
 * Postgres 16, on sales seeded as S3 capture and S5 Tracking Resolution leave
 * them. It proves, per line of resolution v1:
 *   - an untracked product's line freezes `none` and nothing else;
 *   - a line classified `valid` (row 1) or `flagged` (row 2) freezes `batch`,
 *     its identity and the ERPNext Batch read from the edge map;
 *   - a row-3 line with no edge-map row freezes the hold `edge_map_missing`;
 *   - a row-3 line expired at the business date freezes the hold `expired`
 *     (from the capture finding), keeping its Batch;
 *   - a batch line captured while tracked selling was off (identity sent as
 *     provenance, never classified) freezes `batch` with no identity;
 *   - a row-4 line bound by a Tracking Resolution freezes the bound identity;
 *   - an edge-map row written after the freeze changes nothing (frozen, never
 *     recomputed);
 *   - a reversal copies its sale's frozen tracking (lineage);
 *   - the effect and the posting name one identity: each tracked line's S4
 *     sale effect (`stock_movements.tracking_identity_id`) equals the
 *     identity frozen with its posting resolution.
 *
 * Docker policy: a hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { runWithTenantContext, writeSaleLineEffects } from "@data-pulse-2/db";
import { PostingRequestedConsumer } from "../../src/erpnext-posting/posting-requested.consumer";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

const id = (n: string): string => `01960000-0000-7000-8000-0000000${n}`;
const TENANT = id("a0001");
const STORE = id("a0011");
const ACTOR = id("a0021");
const P_NONE = id("a0031");
const P_BATCH = id("a0032");
const I_MAPPED = id("a0041");
const I_NOMAP = id("a0042");
const I_EXPIRED = id("a0043");
const I_BOUND = id("a0044");
const I_LATE = id("a0045");
const HASH = "a".repeat(64);

let env: PgTestEnv | null = null;
let skip = false;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

interface LineSeed {
  readonly product: string;
  readonly identity?: string;
  readonly cls?: "valid" | "flagged" | "unresolved" | null;
  readonly unresolvedReason?: string;
  readonly finding?: "expired" | "edge_map_missing";
}

/** A sale with `lines`; returns the sale id and the line ids in order. */
async function seedSale(lines: readonly LineSeed[], status: "tracked" | "tracking_unresolved" | null): Promise<{
  saleId: string;
  lineIds: string[];
}> {
  seq += 1;
  const a = pg().admin;
  const sale = await a.query<{ id: string }>(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, tracking_status)
     VALUES (gen_random_uuid(), $1, $2, 'USD', 5, '2026-11-11T10:00:00Z', '2026-11-11', 'pos-s6', $3, $4, $5, $6)
     RETURNING id`,
    [TENANT, STORE, `s6-sale-${seq}`, HASH, ACTOR, status],
  );
  const saleId = sale.rows[0]!.id;
  const lineIds: string[] = [];
  for (const [i, l] of lines.entries()) {
    const line = await a.query<{ id: string }>(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                               line_amount, tax_amount, unit, tenant_product_ref, line_seq,
                               tracking_identity_id, tracking_code, tracking_selection,
                               tracking_class, tracking_unresolved_reason)
       VALUES (gen_random_uuid(), $1, $2, $3, 'L', 5, 'USD', 1, 5, 0, 'ea', $4, $5,
               $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE 'LOT' END,
               CASE WHEN $6::uuid IS NULL THEN NULL ELSE 'scanned' END, $7, $8)
       RETURNING id`,
      [saleId, TENANT, STORE, l.product, i + 1, l.identity ?? null, l.cls ?? null, l.unresolvedReason ?? null],
    );
    const lineId = line.rows[0]!.id;
    lineIds.push(lineId);
    if (l.finding) {
      await a.query(
        `INSERT INTO sale_line_findings (tenant_id, store_id, sale_id, sale_line_id, tenant_product_ref,
                                         tracking_identity_id, kind, cause, business_date, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'erp_intent_held', $7, '2026-11-11', '2026-11-11T10:00:00Z')`,
        [TENANT, STORE, saleId, lineId, l.product, l.identity, l.finding],
      );
    }
  }
  return { saleId, lineIds };
}

/** Bind `identity` to the sale's only row-4 line, as the S5 bind records it. */
async function bind(saleId: string, lineId: string, identity: string): Promise<void> {
  const a = pg().admin;
  const r = await a.query<{ id: string }>(
    `INSERT INTO tracking_resolutions (tenant_id, store_id, sale_id, captured_at, reason_code, note,
                                       command_fingerprint, resolved_by)
     VALUES ($1, $2, $3, '2026-11-11T10:00:00Z', 'lot_identified', 'S6 spec', $4, $5) RETURNING id`,
    [TENANT, STORE, saleId, saleId.replace(/-/g, "").padEnd(64, "0"), ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_resolution_lines (sale_line_id, tenant_id, resolution_id, tenant_product_ref, tracking_identity_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [lineId, TENANT, r.rows[0]!.id, P_BATCH, identity],
  );
  await a.query(`UPDATE sales SET tracking_status = 'tracked' WHERE id = $1`, [saleId]);
}

function event(kind: "sale_post" | "reversal", saleId: string, sourceRefId: string): OutboxEventEnvelope<{
  sale_id: string;
  store_id: string;
  kind: "sale_post" | "reversal";
  source_ref_id: string;
}> {
  seq += 1;
  return {
    event_id: id(`e${String(seq).padStart(4, "0")}`),
    event_type: "erpnext.posting.requested",
    tenant_id: TENANT,
    store_id: null,
    payload: { sale_id: saleId, store_id: STORE, kind, source_ref_id: sourceRefId },
    correlation_id: null,
    attempts: 1,
    occurred_at: new Date("2026-11-11T10:00:00.000Z"),
  };
}

interface FrozenLine {
  readonly sale_line_id: string;
  readonly tracking_mode: string | null;
  readonly tracking_identity_id: string | null;
  readonly erpnext_batch_ref: string | null;
  readonly erp_hold_cause: string | null;
}

/** The current resolution's lines of the intent for `sourceRefId`, keyed by sale line. */
async function frozen(sourceRefId: string): Promise<Map<string, Omit<FrozenLine, "sale_line_id">>> {
  const r = await pg().admin.query<FrozenLine>(
    `SELECT r.sale_line_id, r.tracking_mode, r.tracking_identity_id, r.erpnext_batch_ref, r.erp_hold_cause
       FROM erpnext_posting_status s
       JOIN erpnext_posting_resolution r
         ON r.intent_id = s.id AND r.resolution_version = s.current_resolution_version
      WHERE s.tenant_id = $1 AND s.source_ref_id = $2 AND s.status = 'pending'`,
    [TENANT, sourceRefId],
  );
  return new Map(r.rows.map(({ sale_line_id, ...rest }) => [sale_line_id, rest]));
}

async function postSale(saleId: string): Promise<void> {
  await new PostingRequestedConsumer(pg().app).handle(event("sale_post", saleId, saleId));
}

const untracked = { tracking_mode: "none", tracking_identity_id: null, erpnext_batch_ref: null, erp_hold_cause: null };

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-resolution-tracking.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 's6-freeze', 'S6', 'USD')`, [
    TENANT,
  ]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S6', 'S6')`, [STORE, TENANT]);
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 's6@fixture.invalid')`, [ACTOR]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $3, 'Untracked', 'standard', $4, $4, 'none'), ($2, $3, 'Batch', 'standard', $4, $4, 'batch')`,
    [P_NONE, P_BATCH, TENANT, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
                                   suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-NONE', 'confirmed', 'manual', $4, now()),
            (gen_random_uuid(), $1, $3, 'ITEM-BATCH', 'confirmed', 'manual', $4, now())`,
    [TENANT, P_NONE, P_BATCH, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'WH-S6', $3, 1)`,
    [TENANT, STORE, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date) VALUES
       ($1, $6, $7, 'batch', 'S6-MAPPED', '2026-12-31'),
       ($2, $6, $7, 'batch', 'S6-NOMAP', '2026-12-31'),
       ($3, $6, $7, 'batch', 'S6-EXPIRED', '2026-11-10'),
       ($4, $6, $7, 'batch', 'S6-BOUND', '2026-12-31'),
       ($5, $6, $7, 'batch', 'S6-LATE', '2026-12-31')`,
    [I_MAPPED, I_NOMAP, I_EXPIRED, I_BOUND, I_LATE, TENANT, P_BATCH],
  );
  await a.query(
    `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref) VALUES
       ($1, $2, 'batch', 'BATCH-MAPPED'), ($1, $3, 'batch', 'BATCH-EXPIRED'), ($1, $4, 'batch', 'BATCH-BOUND')`,
    [TENANT, I_MAPPED, I_EXPIRED, I_BOUND],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("RT-451 S6: the worker freezes each line's tracking with resolution v1", () => {
  it("rows 1 and 2 freeze batch, the identity and its edge-map Batch; an untracked line freezes none", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale(
      [
        { product: P_NONE },
        { product: P_BATCH, identity: I_MAPPED, cls: "valid" },
        { product: P_BATCH, identity: I_MAPPED, cls: "flagged" },
      ],
      "tracked",
    );
    await postSale(saleId);
    const f = await frozen(saleId);
    const tracked = { tracking_mode: "batch", tracking_identity_id: I_MAPPED, erpnext_batch_ref: "BATCH-MAPPED", erp_hold_cause: null };
    expect(f.get(lineIds[0]!)).toEqual(untracked);
    expect(f.get(lineIds[1]!)).toEqual(tracked);
    expect(f.get(lineIds[2]!)).toEqual(tracked);
  });

  it("row 3 with no edge-map row freezes the hold edge_map_missing; a later edge-map row changes nothing", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale(
      [{ product: P_BATCH, identity: I_LATE, cls: "flagged", finding: "edge_map_missing" }, { product: P_NONE }],
      "tracked",
    );
    await postSale(saleId);
    const held = { tracking_mode: "batch", tracking_identity_id: I_LATE, erpnext_batch_ref: null, erp_hold_cause: "edge_map_missing" };
    expect((await frozen(saleId)).get(lineIds[0]!)).toEqual(held);

    // The edge map is repaired after the intent exists: v1 is frozen, never recomputed.
    await pg().admin.query(
      `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref) VALUES ($1, $2, 'batch', 'BATCH-LATE')`,
      [TENANT, I_LATE],
    );
    await postSale(saleId); // a re-delivery is a no-op
    expect((await frozen(saleId)).get(lineIds[0]!)).toEqual(held);
  });

  it("an identity with no edge-map row is held even when capture recorded no finding (read at the freeze)", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale([{ product: P_BATCH, identity: I_NOMAP, cls: "valid" }], "tracked");
    await postSale(saleId);
    expect((await frozen(saleId)).get(lineIds[0]!)).toEqual({
      tracking_mode: "batch",
      tracking_identity_id: I_NOMAP,
      erpnext_batch_ref: null,
      erp_hold_cause: "edge_map_missing",
    });
  });

  it("row 3 expired freezes the hold expired from the capture finding, keeping its Batch", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale(
      [{ product: P_BATCH, identity: I_EXPIRED, cls: "flagged", finding: "expired" }],
      "tracked",
    );
    await postSale(saleId);
    expect((await frozen(saleId)).get(lineIds[0]!)).toEqual({
      tracking_mode: "batch",
      tracking_identity_id: I_EXPIRED,
      erpnext_batch_ref: "BATCH-EXPIRED",
      erp_hold_cause: "expired",
    });
  });

  it("expired wins over edge_map_missing when both findings were recorded", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale(
      [{ product: P_BATCH, identity: I_NOMAP, cls: "flagged", finding: "expired" }],
      "tracked",
    );
    await pg().admin.query(
      `INSERT INTO sale_line_findings (tenant_id, store_id, sale_id, sale_line_id, tenant_product_ref,
                                       tracking_identity_id, kind, cause, business_date, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'erp_intent_held', 'edge_map_missing', '2026-11-11', '2026-11-11T10:00:00Z')`,
      [TENANT, STORE, saleId, lineIds[0], P_BATCH, I_NOMAP],
    );
    await postSale(saleId);
    expect((await frozen(saleId)).get(lineIds[0]!)?.erp_hold_cause).toBe("expired");
  });

  it("a batch line captured while tracked selling was off freezes batch with no identity (provenance is not a sale identity)", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale([{ product: P_BATCH, identity: I_MAPPED, cls: null }], null);
    await postSale(saleId);
    expect((await frozen(saleId)).get(lineIds[0]!)).toEqual({
      tracking_mode: "batch",
      tracking_identity_id: null,
      erpnext_batch_ref: null,
      erp_hold_cause: null,
    });
  });

  it("a row-4 line bound by a Tracking Resolution freezes the bound identity and its Batch", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale(
      [{ product: P_BATCH, cls: "unresolved", unresolvedReason: "tracking_missing" }, { product: P_NONE }],
      "tracking_unresolved",
    );
    await bind(saleId, lineIds[0]!, I_BOUND);
    await postSale(saleId);
    const f = await frozen(saleId);
    expect(f.get(lineIds[0]!)).toEqual({
      tracking_mode: "batch",
      tracking_identity_id: I_BOUND,
      erpnext_batch_ref: "BATCH-BOUND",
      erp_hold_cause: null,
    });
    expect(f.get(lineIds[1]!)).toEqual(untracked);
  });

  it("a reversal copies its sale's frozen tracking (lineage), held lines included", async () => {
    if (skip) return;
    const { saleId, lineIds } = await seedSale(
      [
        { product: P_BATCH, identity: I_MAPPED, cls: "valid" },
        { product: P_BATCH, identity: I_EXPIRED, cls: "flagged", finding: "expired" },
      ],
      "tracked",
    );
    await postSale(saleId);
    const voidId = id("b0001");
    await pg().admin.query(
      `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, '2026-11-11', 'pos-s6', 'void-s6', $5, $6)`,
      [voidId, saleId, TENANT, STORE, HASH, ACTOR],
    );
    await new PostingRequestedConsumer(pg().app).handle(event("reversal", saleId, voidId));
    const sale = await frozen(saleId);
    const reversal = await frozen(voidId);
    expect(reversal.size).toBe(2);
    for (const lineId of lineIds) expect(reversal.get(lineId)).toEqual(sale.get(lineId));
    expect(reversal.get(lineIds[1]!)?.erp_hold_cause).toBe("expired");
  });

  it("each tracked line's sale effect and its frozen posting name the same identity", async () => {
    if (skip) return;
    await pg().admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
       VALUES ($1, $2, now(), $2)
       ON CONFLICT (tenant_id) DO UPDATE SET sale_effects_activated_at = now(), sale_effects_activated_by = $2`,
      [TENANT, ACTOR],
    );
    const { saleId, lineIds } = await seedSale(
      [
        { product: P_BATCH, identity: I_MAPPED, cls: "valid" },
        { product: P_BATCH, identity: I_EXPIRED, cls: "flagged", finding: "expired" },
        { product: P_NONE },
      ],
      "tracked",
    );
    await runWithTenantContext(pg().app, { tenantId: TENANT, isPlatformAdmin: false }, (client) =>
      writeSaleLineEffects(client, { tenantId: TENANT, storeId: STORE, saleId }),
    );
    await postSale(saleId);
    const effects = await pg().admin.query<{ sale_line_id: string; tracking_identity_id: string | null }>(
      `SELECT sale_line_id, tracking_identity_id FROM stock_movements
        WHERE tenant_id = $1 AND event_type = 'sale' AND event_ref_id = $2`,
      [TENANT, saleId],
    );
    expect(effects.rows).toHaveLength(3);
    const f = await frozen(saleId);
    for (const e of effects.rows) {
      expect(f.get(e.sale_line_id)?.tracking_identity_id ?? null).toBe(e.tracking_identity_id);
    }
    expect(new Map(effects.rows.map((e) => [e.sale_line_id, e.tracking_identity_id])).get(lineIds[0]!)).toBe(I_MAPPED);
  });
});
