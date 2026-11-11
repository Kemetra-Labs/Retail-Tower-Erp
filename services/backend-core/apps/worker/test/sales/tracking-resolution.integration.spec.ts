/**
 * RT-451 S5 — a `tracking_unresolved` sale whose void, return, credit reversal
 * or refund came before its Tracking Resolution (RT-451 comment 16556 Q1).
 *
 * Runs the real `SaleProcessingProcessor` and `PostingRequestedConsumer` on the
 * non-superuser app pool (RLS + FORCE), with fixtures on the admin pool. The
 * pre-bind events are written as the API writes them (the row, the shared
 * effect writer, the `reversal` intent in the same transaction); the bind's
 * database part is recorded as `TrackingResolutionService.bind` records it
 * (resolution, line bindings, the sale set `tracked`), then
 * `commitResolvedSale` runs in that same transaction.
 *
 * For each case, against an always-resolved twin sale (same lines, captured
 * at the identity) that went through the same events:
 *   - before the bind: the unresolved sale has no effect, no `sale_post`, and
 *     its reversal is deferred, then dead-lettered (RT-173 / RT-207);
 *   - after the bind and a drain of the posting consumer: the stock net per
 *     (identity, status) equals the twin's; exactly one `sale_post` row;
 *     exactly one `reversal` row per void / return / refund;
 *   - a second commit (a retried bind transaction's work) and a re-drain add
 *     nothing;
 *   - an original reversal still retrying when the bind lands, plus its
 *     re-emission, still makes one posting row.
 *
 * Credit reversals create `sale_voids` / `sale_returns` rows through the same
 * writers and emit the same payload (`credit-sale-reversal.store.ts`), so the
 * credit case is the void case with its row written by that path.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  commitResolvedSale,
  emit,
  OUTBOX_EVENT_TYPES,
  runWithTenantContext,
  writeReturnEffects,
  writeVoidEffects,
} from "@data-pulse-2/db";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  PostingRequestedConsumer,
  ReversalAwaitingSalePostError,
} from "../../src/erpnext-posting/posting-requested.consumer";
import { SaleProcessingProcessor } from "../../src/sales/sale-processing.processor";

const TENANT = "01900000-0000-7000-8000-000004515501";
const STORE = "01900000-0000-7000-8000-000004515511";
const ACTOR = "01900000-0000-7000-8000-000004515521";
const PRODUCT = "01900000-0000-7000-8000-000004515531";
const IDENTITY = "01900000-0000-7000-8000-000004515541";
const SOURCE = "pos-451-s5";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

function nextId(): string {
  seq += 1;
  return `01900000-0000-7000-8000-${(0x451600000000 + seq).toString(16)}`;
}

const quiet = { warn: jest.fn(), error: jest.fn() };

const inTenant = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> =>
  runWithTenantContext(pg().app, { tenantId: TENANT, isPlatformAdmin: false }, fn);

/** A one-line sale of 2 units: unresolved (row 4, no tracking) or resolved at IDENTITY (row 1). */
async function seedSale(resolved: boolean): Promise<{ saleId: string; lineId: string }> {
  const saleId = nextId();
  const lineId = nextId();
  await pg().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, tracking_status)
     VALUES ($1, $2, $3, 'USD', 0, now(), current_date, $4, $5, $6, $7, $8)`,
    [saleId, TENANT, STORE, SOURCE, `ext-${saleId}`, "a".repeat(64), ACTOR, resolved ? "tracked" : "tracking_unresolved"],
  );
  await pg().admin.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                             line_amount, unit, tenant_product_ref, tracking_identity_id, tracking_code,
                             tracking_selection, tracking_class, tracking_unresolved_reason)
     VALUES ($1, $2, $3, $4, 'lot', 0, 'USD', 2, 0, 'ea', $5,
             CASE WHEN $6 THEN $7::uuid END, CASE WHEN $6 THEN 'LOT-S5' END, CASE WHEN $6 THEN 'scanned' END,
             CASE WHEN $6 THEN 'valid' ELSE 'unresolved' END, CASE WHEN $6 THEN NULL ELSE 'tracking_missing' END)`,
    [lineId, saleId, TENANT, STORE, PRODUCT, resolved, IDENTITY],
  );
  return { saleId, lineId };
}

async function processSale(saleId: string): Promise<void> {
  await new SaleProcessingProcessor(pg().app, quiet).process({ saleId, tenantId: TENANT, storeId: STORE });
}

/** The API's reversal intent (sales.service / sale-returns.service / credit-sale-reversal.store). */
async function emitReversal(c: PoolClient, saleId: string, sourceRefId: string): Promise<void> {
  await emit(c, {
    eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
    tenantId: TENANT,
    storeId: STORE,
    payload: { sale_id: saleId, store_id: STORE, kind: "reversal", source_ref_id: sourceRefId },
    correlationId: null,
  });
}

/** A void as `recordVoid` (or a credit reversal of kind void) writes it. */
async function voidSale(saleId: string): Promise<string> {
  const voidId = nextId();
  await inTenant(async (c) => {
    await c.query(
      `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id,
                               payload_hash, created_by)
       VALUES ($1, $2, $3, $4, current_date, $5, $6, $7, $8)`,
      [voidId, saleId, TENANT, STORE, SOURCE, `void-${voidId}`, "0".repeat(64), ACTOR],
    );
    await writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId });
    await emitReversal(c, saleId, voidId);
  });
  return voidId;
}

/** A one-unit return as `SaleReturnsService` writes it. */
async function returnOne(saleId: string, lineId: string): Promise<string> {
  const returnId = nextId();
  await inTenant(async (c) => {
    await c.query(
      `INSERT INTO sale_returns (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code,
                                 return_total, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, 1, current_date, 'USD', 0, $5, $6, $7, $8)`,
      [returnId, saleId, TENANT, STORE, SOURCE, `ret-${returnId}`, "0".repeat(64), ACTOR],
    );
    await c.query(
      `INSERT INTO sale_return_lines (id, return_id, sale_line_id, tenant_id, store_id, quantity, line_amount,
                                      returned_quantity_after)
       VALUES ($1, $2, $3, $4, $5, 1, 0, 1)`,
      [nextId(), returnId, lineId, TENANT, STORE],
    );
    await writeReturnEffects(c, {
      tenantId: TENANT,
      storeId: STORE,
      saleId,
      returnId,
      resolveLandingStatus: async () => "sellable",
    });
    await emitReversal(c, saleId, returnId);
  });
  return returnId;
}

/** A refund: no effect (847, 851), only its reversal intent. */
async function refund(saleId: string): Promise<string> {
  const refundId = nextId();
  await inTenant((c) => emitReversal(c, saleId, refundId));
  return refundId;
}

/** What `TrackingResolutionService.bind` records, then `commitResolvedSale`, in one transaction. */
async function bind(saleId: string, lineId: string): Promise<Awaited<ReturnType<typeof commitResolvedSale>>> {
  return inTenant(async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO tracking_resolutions (tenant_id, store_id, sale_id, captured_at, reason_code, note,
                                         command_fingerprint, resolved_by)
       SELECT tenant_id, store_id, id, received_at, 'label_misprint', 'lot read from the box', $2, $3
         FROM sales WHERE id = $1 RETURNING id`,
      [saleId, saleId.replace(/-/g, "").padEnd(64, "0"), ACTOR],
    );
    await c.query(
      `INSERT INTO tracking_resolution_lines (sale_line_id, tenant_id, resolution_id, tenant_product_ref,
                                              tracking_identity_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [lineId, TENANT, r.rows[0]!.id, PRODUCT, IDENTITY],
    );
    await c.query(`UPDATE sales SET tracking_status = 'tracked' WHERE id = $1`, [saleId]);
    return commitResolvedSale(c, {
      tenantId: TENANT,
      storeId: STORE,
      saleId,
      resolveLandingStatus: async () => "sellable",
    });
  });
}

interface OutboxRow {
  event_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  occurred_at: Date;
}

/**
 * Drain the sale's pending posting intents through the real consumer, as the
 * drainer would: in occurrence order, retrying a deferred reversal on the next
 * pass. A delivered event is marked `delivered`; `deadLetter` marks a
 * deferred one `dead_lettered` instead (its final attempt).
 */
async function drain(saleId: string, opts: { deadLetter?: boolean } = {}): Promise<void> {
  const consumer = new PostingRequestedConsumer(pg().app, quiet);
  for (let pass = 0; pass < 5; pass += 1) {
    const pending = await pg().admin.query<OutboxRow>(
      `SELECT event_id, payload, attempts, occurred_at FROM outbox_events
        WHERE event_type = 'erpnext.posting.requested' AND payload->>'sale_id' = $1
          AND delivery_state IN ('pending', 'failed')
        ORDER BY occurred_at, event_id`,
      [saleId],
    );
    if (pending.rows.length === 0) return;
    for (const row of pending.rows) {
      const envelope: OutboxEventEnvelope = {
        event_id: row.event_id,
        event_type: "erpnext.posting.requested",
        tenant_id: TENANT,
        store_id: STORE,
        payload: row.payload,
        correlation_id: null,
        attempts: row.attempts + 1,
        occurred_at: row.occurred_at,
      };
      try {
        await consumer.handle(envelope as Parameters<PostingRequestedConsumer["handle"]>[0]);
        await pg().admin.query(`UPDATE outbox_events SET delivery_state = 'delivered', attempts = attempts + 1 WHERE event_id = $1`, [
          row.event_id,
        ]);
      } catch (err) {
        if (!(err instanceof ReversalAwaitingSalePostError)) throw err;
        await pg().admin.query(
          `UPDATE outbox_events SET delivery_state = $2, attempts = attempts + 1 WHERE event_id = $1`,
          [row.event_id, opts.deadLetter === true ? "dead_lettered" : "failed"],
        );
      }
    }
    if (opts.deadLetter === true) return;
  }
}

/** The sale's stock net per (identity, status), as text, over every event type. */
async function stockNet(saleId: string): Promise<Array<{ identity: string | null; status: string; net: string }>> {
  const r = await pg().admin.query<{ identity: string | null; status: string; net: string }>(
    `SELECT tracking_identity_id::text AS identity, inventory_status AS status, sum(quantity)::numeric(19,6)::text AS net
       FROM stock_movements WHERE sale_id = $1
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [saleId],
  );
  return r.rows;
}

/** Posting rows of the sale: kind → the source_ref_ids, one entry per row. */
async function postingRows(saleId: string): Promise<{ sale_post: string[]; reversal: string[] }> {
  const r = await pg().admin.query<{ kind: "sale_post" | "reversal"; source_ref_id: string }>(
    `SELECT kind, source_ref_id::text AS source_ref_id FROM erpnext_posting_status WHERE sale_id = $1
      ORDER BY kind, source_ref_id`,
    [saleId],
  );
  const out = { sale_post: [] as string[], reversal: [] as string[] };
  for (const row of r.rows) out[row.kind].push(row.source_ref_id);
  return out;
}

async function deliveryStates(saleId: string, sourceRefId: string): Promise<string[]> {
  const r = await pg().admin.query<{ delivery_state: string }>(
    `SELECT delivery_state FROM outbox_events
      WHERE payload->>'sale_id' = $1 AND payload->>'source_ref_id' = $2 ORDER BY occurred_at, event_id`,
    [saleId, sourceRefId],
  );
  return r.rows.map((x) => x.delivery_state);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[tracking-resolution.integration.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt451-s5-w', 'S5')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S5', 'S5')`, [STORE, TENANT]);
  await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt451s5w@fixture.invalid', NULL)`, [ACTOR]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $2, 'tracked', 'standard', $3, $3, 'batch')`,
    [PRODUCT, TENANT, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $2, $3, 'batch', 'LOT-S5', '2099-12-31')`,
    [IDENTITY, TENANT, PRODUCT],
  );
  await a.query(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source,
                                   confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-451-S5', 'confirmed', 'manual', $3, now())`,
    [TENANT, PRODUCT, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'WH-451', $3, 1)`,
    [TENANT, STORE, ACTOR],
  );
  await a.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $2, now(), $2)`,
    [TENANT, ACTOR],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

type Case = "void" | "return" | "credit reversal (void)" | "refund";

/** Apply the case's pre-bind event to a sale; returns the reversal's source_ref_id. */
async function applyEvent(c: Case, sale: { saleId: string; lineId: string }): Promise<string> {
  if (c === "return") return returnOne(sale.saleId, sale.lineId);
  if (c === "refund") return refund(sale.saleId);
  return voidSale(sale.saleId);
}

describe.each<Case>(["void", "return", "credit reversal (void)", "refund"])("%s before the bind", (c) => {
  it("ends with the always-resolved twin's stock, one sale_post and one reversal, posted after the bind", async () => {
    if (skip()) return;
    // The twin: resolved at capture, processed, then the same event.
    const twin = await seedSale(true);
    await processSale(twin.saleId);
    const twinRef = await applyEvent(c, twin);
    await drain(twin.saleId);

    // The unresolved sale: processed with no effect and no sale_post (S4).
    const sale = await seedSale(false);
    await processSale(sale.saleId);
    const ref = await applyEvent(c, sale);
    expect(await stockNet(sale.saleId)).toEqual([]);
    // Its reversal waits for a sale_post that never comes, then dead-letters.
    await drain(sale.saleId, { deadLetter: true });
    expect(await deliveryStates(sale.saleId, ref)).toEqual(["dead_lettered"]);
    expect(await postingRows(sale.saleId)).toEqual({ sale_post: [], reversal: [] });

    const outcome = await bind(sale.saleId, sale.lineId);
    expect(outcome.salePostEmitted).toBe(true);
    expect(outcome.reEmittedReversals).toEqual([ref]);
    await drain(sale.saleId);

    expect(await stockNet(sale.saleId)).toEqual(await stockNet(twin.saleId));
    expect(await postingRows(sale.saleId)).toEqual({ sale_post: [sale.saleId], reversal: [ref] });
    expect(await postingRows(twin.saleId)).toEqual({ sale_post: [twin.saleId], reversal: [twinRef] });
    // The dead-lettered original stays the record of its failed attempts.
    expect(await deliveryStates(sale.saleId, ref)).toEqual(["dead_lettered", "delivered"]);

    // A retried commit (or a re-drain) writes no effect and no posting row more.
    const again = await inTenant((cl) =>
      commitResolvedSale(cl, { tenantId: TENANT, storeId: STORE, saleId: sale.saleId, resolveLandingStatus: async () => "sellable" }),
    );
    expect(again.effects.flatMap((e) => e.written)).toEqual([]);
    expect(again.reEmittedReversals).toEqual([]);
    await drain(sale.saleId);
    expect(await stockNet(sale.saleId)).toEqual(await stockNet(twin.saleId));
    expect(await postingRows(sale.saleId)).toEqual({ sale_post: [sale.saleId], reversal: [ref] });
  });
});

describe("a reversal still retrying when the bind lands", () => {
  it("is re-emitted once and both deliveries make one posting row", async () => {
    if (skip()) return;
    const sale = await seedSale(false);
    await processSale(sale.saleId);
    const voidId = await voidSale(sale.saleId);
    await drain(sale.saleId, { deadLetter: false });
    expect(await deliveryStates(sale.saleId, voidId)).toEqual(["failed"]);

    const outcome = await bind(sale.saleId, sale.lineId);
    expect(outcome.reEmittedReversals).toEqual([voidId]);
    await drain(sale.saleId);
    expect(await deliveryStates(sale.saleId, voidId)).toEqual(["delivered", "delivered"]);
    expect(await postingRows(sale.saleId)).toEqual({ sale_post: [sale.saleId], reversal: [voidId] });
    // The void compensated the bound sale effect exactly: net zero at the identity.
    expect(await stockNet(sale.saleId)).toEqual([{ identity: IDENTITY, status: "sellable", net: "0.000000" }]);
  });
});

describe("a sale the worker has not processed yet", () => {
  it("gets its void restore at the bind, and its effect and sale_post from the worker afterwards", async () => {
    if (skip()) return;
    const sale = await seedSale(false);
    const voidId = await voidSale(sale.saleId);
    const outcome = await bind(sale.saleId, sale.lineId);
    expect(outcome.salePostEmitted).toBe(false);
    expect(await stockNet(sale.saleId)).toEqual([{ identity: IDENTITY, status: "sellable", net: "2.000000" }]);
    await processSale(sale.saleId);
    await drain(sale.saleId);
    expect(await stockNet(sale.saleId)).toEqual([{ identity: IDENTITY, status: "sellable", net: "0.000000" }]);
    expect(await postingRows(sale.saleId)).toEqual({ sale_post: [sale.saleId], reversal: [voidId] });
  });
});
