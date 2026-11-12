/**
 * RT-427 — sale / void / return Inventory Effect writers and the posting
 * intent link, against a real Postgres with every migration applied.
 *
 * The writers run on the non-superuser `app_test` pool inside
 * `runWithTenantContext`, exactly as the worker and the API call them, so RLS
 * and FORCE apply. Fixtures are seeded on the superuser pool.
 *
 * Proves:
 *   - flag OFF (no settings row, or a NULL activation): nothing is written;
 *   - flag ON: one effect per product line, `-q` at the primary location /
 *     sellable, the DC-1 key, the sale's provenance, `not_posted` awaiting its
 *     intent, one `inventory.movement.created` event; non-stock lines are
 *     ignored and inexact lines skipped with a reason (owner decision 2);
 *   - replay writes nothing (DC-1);
 *   - void: restores each sale effect exactly once at its position, even after
 *     the flag is turned off; a sale with no effect is restored per line only
 *     while ON;
 *   - return: `+q` in the tenant's landing status;
 *   - link: `pending` / `rejected` on the event's own effects only;
 *   - RLS: a writer in another tenant's context sees and writes nothing;
 *   - the activation read waits for an EXCLUSIVE settings lock holder.
 */
import type { Pool, PoolClient } from "pg";

import {
  linkEffectsToPostingIntent,
  readSaleEffectsActivation,
  writeReturnEffects,
  writeSaleLineEffects,
  writeVoidEffects,
} from "../../src/helpers/inventory-effects/sale-effects";
import { runWithTenantContext } from "../../src/middleware/tenant-context";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const TENANT = "0a000000-0000-7000-8000-000000427a01";
const TENANT_B = "0b000000-0000-7000-8000-000000427a01";
const STORE = "0a000000-0000-7000-8000-000000427a02";
const STORE_B = "0b000000-0000-7000-8000-000000427a02";
const ACTOR = "0a000000-0000-7000-8000-000000427a03";
const P_EACH = "0a000000-0000-7000-8000-000000427b01";
const P_KG = "0a000000-0000-7000-8000-000000427b02";
const P_TRACKED = "0a000000-0000-7000-8000-000000427b03";
const P_BOXED = "0a000000-0000-7000-8000-000000427b04";
const SOURCE = "pos-pulse";

let env: PgTestEnv | null = null;
let primary = "";
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

function uuid(): string {
  seq += 1;
  return `0c000000-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/** A tenant and the store its sales are captured at. */
interface Scope {
  readonly tenantId: string;
  readonly storeId: string;
}
const A: Scope = { tenantId: TENANT, storeId: STORE };
const B: Scope = { tenantId: TENANT_B, storeId: STORE_B };

interface SeededSale {
  readonly saleId: string;
  readonly lineIds: string[];
}

/** The Business Event whose effects a query reads. */
interface EventRef {
  readonly eventRefId: string;
}

/**
 * The S3 capture snapshot of a line (0089): the identity the till sent and
 * the G7-9 class. `class: null` with an identity is tracking stored while
 * tracked selling was off (provenance only, comment 16269).
 */
interface LineTracking {
  readonly identityId: string | null;
  readonly class: "valid" | "flagged" | "unresolved" | null;
  readonly unresolvedReason?: "tracking_missing" | "identity_unknown" | "identity_other_product";
}

interface Line {
  readonly product: string | null;
  readonly quantity: string;
  readonly unit?: string;
  readonly tracking?: LineTracking;
}

async function seedSale(
  { tenantId, storeId }: Scope,
  lines: readonly Line[],
  trackingStatus: "tracked" | "tracking_unresolved" | null = null,
): Promise<SeededSale> {
  const saleId = uuid();
  await pg().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, tracking_status)
     VALUES ($1, $2, $3, 'EGP', 0, now() - interval '1 minute', current_date, $4, $5, $6, $7, $8)`,
    [saleId, tenantId, storeId, SOURCE, `ext-${saleId}`, "0".repeat(64), ACTOR, trackingStatus],
  );
  const lineIds: string[] = [];
  for (const [i, l] of lines.entries()) {
    const lineId = uuid();
    lineIds.push(lineId);
    const t = l.tracking;
    const snapshot = t?.identityId ?? null;
    await pg().admin.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
                               quantity, line_amount, unit, tenant_product_ref, line_seq,
                               tracking_identity_id, tracking_code, tracking_selection,
                               tracking_class, tracking_unresolved_reason)
       VALUES ($1, $2, $3, $4, 'l', 0, 'EGP', $5::numeric, 0, $6, $7, $8,
               $9, CASE WHEN $9::uuid IS NOT NULL THEN 'LOT-S4' END,
               CASE WHEN $9::uuid IS NOT NULL THEN 'scanned' END, $10, $11)`,
      [
        lineId,
        saleId,
        tenantId,
        storeId,
        l.quantity,
        l.unit ?? "ea",
        l.product,
        i + 1,
        snapshot,
        t?.class ?? null,
        t?.unresolvedReason ?? null,
      ],
    );
  }
  return { saleId, lineIds };
}

async function seedVoid({ saleId }: Pick<SeededSale, "saleId">): Promise<string> {
  const voidId = uuid();
  await pg().admin.query(
    `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id,
                             payload_hash, created_by)
     VALUES ($1, $2, $3, $4, current_date, $5, $6, $7, $8)`,
    [voidId, saleId, TENANT, STORE, SOURCE, `void-${voidId}`, "0".repeat(64), ACTOR],
  );
  return voidId;
}

async function seedReturn(
  { saleId }: Pick<SeededSale, "saleId">,
  lines: ReadonlyArray<{ saleLineId: string; quantity: string }>,
): Promise<{ returnId: string; lineIds: string[] }> {
  const returnId = uuid();
  await pg().admin.query(
    `INSERT INTO sale_returns (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code,
                               return_total, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, current_date, 'EGP', 0, $5, $6, $7, $8)`,
    [returnId, saleId, TENANT, STORE, SOURCE, `ret-${returnId}`, "0".repeat(64), ACTOR],
  );
  const lineIds: string[] = [];
  for (const l of lines) {
    const id = uuid();
    lineIds.push(id);
    await pg().admin.query(
      `INSERT INTO sale_return_lines (id, return_id, sale_line_id, tenant_id, store_id, quantity, line_amount,
                                      returned_quantity_after)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, 0, $6::numeric)`,
      [id, returnId, l.saleLineId, TENANT, STORE, l.quantity],
    );
  }
  return { returnId, lineIds };
}

async function setActivation({ tenantId }: Pick<Scope, "tenantId">, on: boolean): Promise<void> {
  await pg().admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $2, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN $2::uuid END)
     ON CONFLICT (tenant_id) DO UPDATE
       SET sale_effects_activated_at = EXCLUDED.sale_effects_activated_at,
           sale_effects_activated_by = EXCLUDED.sale_effects_activated_by`,
    [tenantId, ACTOR, on],
  );
}

function asTenant<T>({ tenantId }: Pick<Scope, "tenantId">, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(pg().app, { tenantId, isPlatformAdmin: false }, work);
}

interface EffectRow {
  id: string;
  movement_type: string;
  quantity: string;
  stocking_unit: string;
  tenant_product_ref: string;
  external_id: string;
  source_system: string;
  event_type: string;
  event_ref_id: string;
  sale_line_id: string;
  terminal_event_ref: string | null;
  compensates_effect_id: string | null;
  stock_location_id: string;
  inventory_status: string;
  tracking_identity_id: string | null;
  state: string;
  state_reason: string | null;
  posting_status_id: string | null;
}

async function effectsOf({ eventRefId }: EventRef): Promise<EffectRow[]> {
  const r = await pg().admin.query<EffectRow>(
    `SELECT m.id, m.movement_type, m.quantity::text AS quantity, m.stocking_unit, m.tenant_product_ref,
            m.external_id, m.source_system, m.event_type, m.event_ref_id, m.sale_line_id, m.terminal_event_ref,
            m.compensates_effect_id, m.stock_location_id, m.inventory_status, m.tracking_identity_id,
            i.state, i.state_reason, i.posting_status_id
       FROM stock_movements m JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.event_ref_id = $1 ORDER BY m.external_id`,
    [eventRefId],
  );
  return r.rows;
}

async function movementEvents({ eventRefId }: EventRef): Promise<number> {
  const r = await pg().admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox_events
      WHERE event_type = 'inventory.movement.created' AND payload->>'eventRefId' = $1`,
    [eventRefId],
  );
  return r.rows[0]!.n;
}

async function seedPosting({ saleId, kind, sourceRefId }: { saleId: string; kind: string; sourceRefId: string }): Promise<string> {
  const r = await pg().admin.query<{ id: string }>(
    `INSERT INTO erpnext_posting_status (tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
                                         external_id, payload_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING id`,
    [TENANT, STORE, saleId, kind, sourceRefId, SOURCE, `ext-${saleId}`, "0".repeat(64)],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sale-inventory-effects.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt427-fx-a', 'A'), ($2, 'rt427-fx-b', 'B')`, [
    TENANT,
    TENANT_B,
  ]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A', 'A'), ($3, $4, 'B', 'B')`, [
    STORE,
    TENANT,
    STORE_B,
    TENANT_B,
  ]);
  primary = (
    await a.query<{ id: string }>(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE])
  ).rows[0]!.id;
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode) VALUES
       ($1, $5, 'each', 'standard', $6, $6, 'none'), ($2, $5, 'kg', 'standard', $6, $6, 'none'),
       ($3, $5, 'tracked', 'standard', $6, $6, 'batch'), ($4, $5, 'boxed', 'standard', $6, $6, 'none')`,
    [P_EACH, P_KG, P_TRACKED, P_BOXED, TENANT, ACTOR],
  );
  // P_BOXED already has a manual movement in 'box' at the store.
  await a.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
                                  occurred_at, created_by, stock_location_id, inventory_status)
     VALUES (gen_random_uuid(), $1, $2, 'inbound', 5, 'box', $3, now(), $4, $5, 'sellable')`,
    [TENANT, STORE, P_BOXED, ACTOR, primary],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("flag OFF", () => {
  it("writes nothing for a sale, a void or a return when the tenant has no settings row", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [{ product: P_EACH, quantity: "2" }]);
    const voidId = await seedVoid({ saleId });
    const { returnId } = await seedReturn({ saleId }, [{ saleLineId: lineIds[0]!, quantity: "1" }]);
    const outcomes = await asTenant(A, async (c) => [
      await writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }),
      await writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }),
      await writeReturnEffects(c, { tenantId: TENANT, storeId: STORE, saleId, returnId, resolveLandingStatus: async () => "sellable" }),
    ]);
    expect(outcomes.map((o) => [o.written.length, o.skipped.length])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect([...(await effectsOf({ eventRefId: saleId })), ...(await effectsOf({ eventRefId: voidId })), ...(await effectsOf({ eventRefId: returnId }))]).toEqual([]);
    expect(await asTenant(A, (c) => readSaleEffectsActivation(c, TENANT))).toBe(false);
  });
});

describe("flag ON", () => {
  beforeAll(async () => {
    if (env) await setActivation(A, true);
  });

  it("writes one outbound effect per product line and skips the inexact ones", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [
      { product: P_EACH, quantity: "2.000000" },
      { product: P_KG, quantity: "1.500000", unit: "kg" },
      { product: null, quantity: "1" },
      { product: P_EACH, quantity: "0" },
      { product: P_TRACKED, quantity: "1" },
      { product: P_KG, quantity: "0.123456", unit: "kg" },
      { product: P_BOXED, quantity: "1", unit: "ea" },
    ]);
    const outcome = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    expect(outcome.written).toHaveLength(2);
    expect(outcome.skipped).toEqual([
      { lineId: lineIds[4], reason: "tracked_product" },
      { lineId: lineIds[5], reason: "quantity_precision" },
      { lineId: lineIds[6], reason: "unit_mismatch" },
    ]);
    const effects = await effectsOf({ eventRefId: saleId });
    expect(effects.map((e) => [e.external_id, e.movement_type, e.quantity, e.stocking_unit, e.tenant_product_ref])).toEqual(
      [
        [`sale_line:${lineIds[0]}`, "outbound", "-2.0000", "ea", P_EACH],
        [`sale_line:${lineIds[1]}`, "outbound", "-1.5000", "kg", P_KG],
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    for (const e of effects) {
      expect(e).toMatchObject({
        source_system: SOURCE,
        event_type: "sale",
        event_ref_id: saleId,
        terminal_event_ref: null,
        compensates_effect_id: null,
        stock_location_id: primary,
        inventory_status: "sellable",
        state: "not_posted",
        state_reason: "awaiting_posting_intent",
        posting_status_id: null,
      });
    }
    expect(await movementEvents({ eventRefId: saleId })).toBe(1);
  });

  it("is a no-op on replay (DC-1)", async () => {
    if (skip()) return;
    const { saleId } = await seedSale(A, [{ product: P_EACH, quantity: "1" }]);
    const first = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const again = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    expect([first.written.length, again.written.length]).toEqual([1, 0]);
    expect(await effectsOf({ eventRefId: saleId })).toHaveLength(1);
    expect(await movementEvents({ eventRefId: saleId })).toBe(1);
  });

  it("establishes the unit within one sale: a second unit for a new product is skipped, not a 23P01", async () => {
    if (skip()) return;
    const fresh = "0a000000-0000-7000-8000-000000427b05";
    await pg().admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, 'f', 'standard', $3, $3)`,
      [fresh, TENANT, ACTOR],
    );
    const { saleId, lineIds } = await seedSale(A, [
      { product: fresh, quantity: "1", unit: "ea" },
      { product: fresh, quantity: "1", unit: "pack" },
    ]);
    const outcome = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    expect(outcome.written).toHaveLength(1);
    expect(outcome.skipped).toEqual([{ lineId: lineIds[1], reason: "unit_mismatch" }]);
  });

  it("void restores each sale effect once at its position, and still does after the flag is turned off", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [
      { product: P_EACH, quantity: "3" },
      { product: null, quantity: "1" },
    ]);
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const [saleEffect] = await effectsOf({ eventRefId: saleId });
    await setActivation(A, false);
    try {
      const voidId = await seedVoid({ saleId });
      const outcome = await asTenant(A, (c) =>
        writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }),
      );
      const replay = await asTenant(A, (c) => writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }));
      expect([outcome.written.length, replay.written.length]).toEqual([1, 0]);
      const [restore] = await effectsOf({ eventRefId: voidId });
      expect(restore).toMatchObject({
        external_id: `void:${voidId}:${lineIds[0]}`,
        movement_type: "inbound",
        quantity: "3.0000",
        stocking_unit: "ea",
        compensates_effect_id: saleEffect!.id,
        stock_location_id: saleEffect!.stock_location_id,
        inventory_status: saleEffect!.inventory_status,
        event_type: "sale_void",
        terminal_event_ref: voidId,
        state: "not_posted",
      });
    } finally {
      await setActivation(A, true);
    }
  });

  it("void of a sale with no effect restores per line while ON, and writes nothing while OFF", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [{ product: P_EACH, quantity: "2" }]);
    const voidId = await seedVoid({ saleId });
    await setActivation(A, false);
    const off = await asTenant(A, (c) => writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }));
    await setActivation(A, true);
    const on = await asTenant(A, (c) => writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }));
    expect([off.written.length, on.written.length]).toEqual([0, 1]);
    expect(await effectsOf({ eventRefId: voidId })).toEqual([
      expect.objectContaining({
        external_id: `void:${voidId}:${lineIds[0]}`,
        quantity: "2.0000",
        compensates_effect_id: null,
        stock_location_id: primary,
        inventory_status: "sellable",
      }),
    ]);
  });

  it("return lands +q in the tenant's landing status", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [{ product: P_EACH, quantity: "4" }]);
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const { returnId, lineIds: returnLines } = await seedReturn({ saleId }, [{ saleLineId: lineIds[0]!, quantity: "1.5" }]);
    const outcome = await asTenant(A, (c) =>
      writeReturnEffects(c, { tenantId: TENANT, storeId: STORE, saleId, returnId, resolveLandingStatus: async () => "return_inspection" }),
    );
    expect(outcome.written).toHaveLength(1);
    expect(await effectsOf({ eventRefId: returnId })).toEqual([
      expect.objectContaining({
        external_id: `return_line:${returnLines[0]}`,
        movement_type: "inbound",
        quantity: "1.5000",
        stock_location_id: primary,
        inventory_status: "return_inspection",
        event_type: "sale_return",
        compensates_effect_id: null,
        terminal_event_ref: returnId,
      }),
    ]);
  });

  it("links only the event's own not_posted effects: pending, or rejected with the category", async () => {
    if (skip()) return;
    const { saleId } = await seedSale(A, [{ product: P_EACH, quantity: "1" }]);
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const voidId = await seedVoid({ saleId });
    await asTenant(A, (c) => writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }));
    const salePost = await seedPosting({ saleId, kind: "sale_post", sourceRefId: saleId });
    const reversal = await seedPosting({ saleId, kind: "reversal", sourceRefId: voidId });
    const linked = await asTenant(A, async (c) => [
      await linkEffectsToPostingIntent(c, {
        tenantId: TENANT,
        kind: "sale_post",
        sourceRefId: saleId,
        postingStatusId: salePost,
        verdict: { status: "pending" },
      }),
      await linkEffectsToPostingIntent(c, {
        tenantId: TENANT,
        kind: "reversal",
        sourceRefId: voidId,
        postingStatusId: reversal,
        verdict: { status: "permanently_rejected", rejectionCategory: "unmapped_item" },
      }),
      // A re-delivery finds nothing awaiting.
      await linkEffectsToPostingIntent(c, {
        tenantId: TENANT,
        kind: "sale_post",
        sourceRefId: saleId,
        postingStatusId: salePost,
        verdict: { status: "pending" },
      }),
    ]);
    expect(linked).toEqual([1, 1, 0]);
    expect((await effectsOf({ eventRefId: saleId })).map((e) => [e.state, e.posting_status_id, e.state_reason])).toEqual([
      ["pending", salePost, null],
    ]);
    expect((await effectsOf({ eventRefId: voidId })).map((e) => [e.state, e.posting_status_id, e.state_reason])).toEqual([
      ["rejected", reversal, "unmapped_item"],
    ]);
  });
});

describe("tracked effects (RT-451 S4; RT-50 G7-9, G7-10, Q9)", () => {
  const P_SERIAL = "0a000000-0000-7000-8000-000000451b01";
  const I_LOT = "0a000000-0000-7000-8000-000000451c01";
  const I_RECALLED = "0a000000-0000-7000-8000-000000451c02";
  const I_QHOLD = "0a000000-0000-7000-8000-000000451c03";
  const I_SERIAL = "0a000000-0000-7000-8000-000000451c04";
  const RECALL = "0a000000-0000-7000-8000-000000451d01";

  const valid = (identityId: string): LineTracking => ({ identityId, class: "valid" });
  const returnTo = (status: string) => async (): Promise<string> => status;

  /** Whether some backend ends up waiting on a lock `holder` holds (polls up to 10 s). */
  async function waitUntilBlockedBy(holder: PoolClient): Promise<boolean> {
    const pid = (await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    for (let i = 0; i < 200; i += 1) {
      const r = await pg().admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      if (r.rows[0]!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  beforeAll(async () => {
    if (!env) return;
    await setActivation(A, true);
    const a = pg().admin;
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
       VALUES ($1, $2, 'serial', 'standard', $3, $3, 'serial')`,
      [P_SERIAL, TENANT, ACTOR],
    );
    await a.query(
      `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date) VALUES
         ($1, $5, $6, 'batch', 'LOT-1', current_date + 30), ($2, $5, $6, 'batch', 'LOT-R', current_date + 30),
         ($3, $5, $6, 'batch', 'LOT-Q', current_date + 30), ($4, $5, $7, 'serial', 'SN-1', NULL)`,
      [I_LOT, I_RECALLED, I_QHOLD, I_SERIAL, TENANT, P_TRACKED, P_SERIAL],
    );
    await a.query(
      `INSERT INTO inventory_recalls (id, tenant_id, tenant_product_ref, reason_code, reference, effective_at,
                                      command_fingerprint, created_by)
       VALUES ($1, $2, $3, 'authority_notice', 'N-451', now(), $4, $5)`,
      [RECALL, TENANT, P_TRACKED, "a".repeat(64), ACTOR],
    );
    // I_RECALLED: a recall hold that has since been RELEASED ("ever recalled",
    // owner answer of 2026-11-11, RT-451 comment 16538). I_QHOLD: an ACTIVE
    // quality hold, never recalled.
    await a.query(
      `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code,
                                   recall_id, command_fingerprint, placed_by, released_by, released_at)
       VALUES ($1, $3, $4, $5, 'recall_hold', 'recall', $6, NULL, $7, $7, now()),
              ($2, $3, $8, $5, 'quality_hold', 'suspected_defect', NULL, $9, $7, NULL, NULL)`,
      [uuid(), uuid(), TENANT, I_RECALLED, P_TRACKED, RECALL, ACTOR, I_QHOLD, "b".repeat(64)],
    );
  });

  it("a sale moves each classified batch line -q at (primary, sellable, identity) — rows 1 to 3", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(
      A,
      [
        { product: P_TRACKED, quantity: "2", tracking: valid(I_LOT) },
        // Row 2 or 3 (a finding was recorded at capture): the goods left, so the
        // effect is at the identity all the same.
        { product: P_TRACKED, quantity: "1", tracking: { identityId: I_LOT, class: "flagged" } },
        { product: P_EACH, quantity: "1" },
      ],
      "tracked",
    );
    const outcome = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    expect(outcome.written).toHaveLength(3);
    expect(outcome.skipped).toEqual([]);
    const byLine = new Map((await effectsOf({ eventRefId: saleId })).map((e) => [e.sale_line_id, e]));
    expect(byLine.get(lineIds[0]!)).toMatchObject({
      quantity: "-2.0000",
      tenant_product_ref: P_TRACKED,
      tracking_identity_id: I_LOT,
      stock_location_id: primary,
      inventory_status: "sellable",
      external_id: `sale_line:${lineIds[0]}`,
      state: "not_posted",
    });
    expect(byLine.get(lineIds[1]!)).toMatchObject({ quantity: "-1.0000", tracking_identity_id: I_LOT });
    expect(byLine.get(lineIds[2]!)).toMatchObject({ quantity: "-1.0000", tracking_identity_id: null });
  });

  it("skips a classified line whose identity is another product's, with no FK error stalling the sale", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(
      A,
      [
        { product: P_TRACKED, quantity: "1", tracking: valid(I_SERIAL) },
        { product: P_EACH, quantity: "1" },
      ],
      "tracked",
    );
    const outcome = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    expect(outcome.written).toHaveLength(1);
    expect(outcome.skipped).toEqual([{ lineId: lineIds[0], reason: "tracked_product" }]);
    expect((await effectsOf({ eventRefId: saleId })).map((e) => e.sale_line_id)).toEqual([lineIds[1]]);
  });

  it("locks a sale's identities in id order first, so it never deadlocks with a safety command", async () => {
    if (skip()) return;
    // Lines in DESCENDING identity order: without the id-ordered pre-lock, the
    // INSERT's FK checks would take KEY SHARE on I_RECALLED, then wait for I_LOT.
    expect(I_LOT < I_RECALLED).toBe(true);
    const { saleId } = await seedSale(
      A,
      [
        { product: P_TRACKED, quantity: "1", tracking: valid(I_RECALLED) },
        { product: P_TRACKED, quantity: "1", tracking: valid(I_LOT) },
      ],
      "tracked",
    );
    const command = await pg().admin.connect();
    try {
      // What a safety command does (`lockIdentities`): FOR UPDATE in id order.
      await command.query("BEGIN");
      await command.query(`SELECT id FROM tracking_identities WHERE id = $1 FOR UPDATE`, [I_LOT]);
      const writing = asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
      expect(await waitUntilBlockedBy(command)).toBe(true);
      // The writer holds no identity yet, so the command's next lock is granted
      // at once instead of ending in a deadlock (40P01).
      await command.query(`SET LOCAL lock_timeout = '3s'`);
      await command.query(`SELECT id FROM tracking_identities WHERE id = $1 FOR UPDATE`, [I_RECALLED]);
      await command.query("COMMIT");
      expect((await writing).written).toHaveLength(2);
    } finally {
      await command.query("ROLLBACK").catch(() => undefined);
      command.release();
    }
  });

  it("keeps skipping an unclassified tracked line (switched off) and a serial line (Q11)", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [
      // Tracking stored while tracked selling was off: provenance only.
      { product: P_TRACKED, quantity: "1", tracking: { identityId: I_LOT, class: null } },
      { product: P_SERIAL, quantity: "1", tracking: valid(I_SERIAL) },
    ]);
    const outcome = await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    expect(outcome.written).toEqual([]);
    expect(outcome.skipped).toEqual([
      { lineId: lineIds[0], reason: "tracked_product" },
      { lineId: lineIds[1], reason: "tracked_product" },
    ]);
  });

  it("a tracking_unresolved sale writes no effect on any line, and its void and return write none either", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(
      A,
      [
        { product: P_EACH, quantity: "2" },
        { product: P_TRACKED, quantity: "1", tracking: { identityId: null, class: "unresolved", unresolvedReason: "tracking_missing" } },
      ],
      "tracking_unresolved",
    );
    const voidId = await seedVoid({ saleId });
    const { returnId } = await seedReturn({ saleId }, [{ saleLineId: lineIds[0]!, quantity: "1" }]);
    const outcomes = await asTenant(A, async (c) => [
      await writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }),
      await writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }),
      await writeReturnEffects(c, { tenantId: TENANT, storeId: STORE, saleId, returnId, resolveLandingStatus: returnTo("sellable") }),
    ]);
    expect(outcomes.map((o) => [o.written.length, o.skipped.length])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    for (const eventRefId of [saleId, voidId, returnId]) {
      expect(await effectsOf({ eventRefId })).toEqual([]);
      expect(await movementEvents({ eventRefId })).toBe(0);
    }
  });

  it("a void compensates each tracked effect at its exact identity position", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(A, [{ product: P_TRACKED, quantity: "3", tracking: valid(I_LOT) }], "tracked");
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const [saleEffect] = await effectsOf({ eventRefId: saleId });
    const voidId = await seedVoid({ saleId });
    const outcome = await asTenant(A, (c) => writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }));
    expect(outcome.written).toHaveLength(1);
    expect(await effectsOf({ eventRefId: voidId })).toEqual([
      expect.objectContaining({
        external_id: `void:${voidId}:${lineIds[0]}`,
        movement_type: "inbound",
        quantity: "3.0000",
        compensates_effect_id: saleEffect!.id,
        stock_location_id: saleEffect!.stock_location_id,
        inventory_status: saleEffect!.inventory_status,
        tracking_identity_id: I_LOT,
      }),
    ]);
  });

  it("a void of a tracked sale with no effect yet restores each line at its identity", async () => {
    if (skip()) return;
    const { saleId } = await seedSale(A, [{ product: P_TRACKED, quantity: "2", tracking: valid(I_LOT) }], "tracked");
    const voidId = await seedVoid({ saleId });
    await asTenant(A, (c) => writeVoidEffects(c, { tenantId: TENANT, storeId: STORE, saleId, voidId }));
    expect(await effectsOf({ eventRefId: voidId })).toEqual([
      expect.objectContaining({
        quantity: "2.0000",
        compensates_effect_id: null,
        stock_location_id: primary,
        inventory_status: "sellable",
        tracking_identity_id: I_LOT,
      }),
    ]);
  });

  it("a tracked return lands in return_inspection at the original identity, whatever the landing policy (Q9)", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(
      A,
      [
        { product: P_TRACKED, quantity: "2", tracking: valid(I_LOT) },
        { product: P_EACH, quantity: "2" },
      ],
      "tracked",
    );
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const { returnId, lineIds: returnLines } = await seedReturn({ saleId }, [
      { saleLineId: lineIds[0]!, quantity: "1" },
      { saleLineId: lineIds[1]!, quantity: "1" },
    ]);
    const outcome = await asTenant(A, (c) =>
      writeReturnEffects(c, { tenantId: TENANT, storeId: STORE, saleId, returnId, resolveLandingStatus: returnTo("sellable") }),
    );
    expect(outcome.written).toHaveLength(2);
    const byKey = new Map((await effectsOf({ eventRefId: returnId })).map((e) => [e.external_id, e]));
    expect(byKey.get(`return_line:${returnLines[0]}`)).toMatchObject({
      quantity: "1.0000",
      stock_location_id: primary,
      inventory_status: "return_inspection",
      tracking_identity_id: I_LOT,
      compensates_effect_id: null,
    });
    // An untracked line still follows the tenant's landing policy (RT-435).
    expect(byKey.get(`return_line:${returnLines[1]}`)).toMatchObject({
      inventory_status: "sellable",
      tracking_identity_id: null,
    });
  });

  it("a return of an identity ever recalled lands in recall_hold; an active quality hold does not change the landing", async () => {
    if (skip()) return;
    const { saleId, lineIds } = await seedSale(
      A,
      [
        { product: P_TRACKED, quantity: "1", tracking: valid(I_RECALLED) },
        { product: P_TRACKED, quantity: "1", tracking: { identityId: I_QHOLD, class: "flagged" } },
      ],
      "tracked",
    );
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const { returnId, lineIds: returnLines } = await seedReturn({ saleId }, [
      { saleLineId: lineIds[0]!, quantity: "1" },
      { saleLineId: lineIds[1]!, quantity: "1" },
    ]);
    await asTenant(A, (c) =>
      writeReturnEffects(c, { tenantId: TENANT, storeId: STORE, saleId, returnId, resolveLandingStatus: returnTo("sellable") }),
    );
    const byKey = new Map((await effectsOf({ eventRefId: returnId })).map((e) => [e.external_id, e]));
    expect(byKey.get(`return_line:${returnLines[0]}`)).toMatchObject({
      inventory_status: "recall_hold",
      tracking_identity_id: I_RECALLED,
    });
    expect(byKey.get(`return_line:${returnLines[1]}`)).toMatchObject({
      inventory_status: "return_inspection",
      tracking_identity_id: I_QHOLD,
    });
  });

  it("a return racing a recall of its identity reads the recall that committed while it waited", async () => {
    if (skip()) return;
    const I_RACE = "0a000000-0000-7000-8000-000000451c05";
    const RACE_RECALL = "0a000000-0000-7000-8000-000000451d02";
    await pg().admin.query(
      `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code) VALUES ($1, $2, $3, 'batch', 'LOT-RACE')`,
      [I_RACE, TENANT, P_TRACKED],
    );
    const { saleId, lineIds } = await seedSale(A, [{ product: P_TRACKED, quantity: "1", tracking: valid(I_RACE) }], "tracked");
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const { returnId, lineIds: returnLines } = await seedReturn({ saleId }, [{ saleLineId: lineIds[0]!, quantity: "1" }]);
    const recall = await pg().admin.connect();
    try {
      // What createInventoryRecall does: lock the identity FOR UPDATE, then
      // place the recall hold; the hold is not committed yet.
      await recall.query("BEGIN");
      await recall.query(`SELECT id FROM tracking_identities WHERE id = $1 FOR UPDATE`, [I_RACE]);
      await recall.query(
        `INSERT INTO inventory_recalls (id, tenant_id, tenant_product_ref, reason_code, reference, effective_at,
                                        command_fingerprint, created_by)
         VALUES ($1, $2, $3, 'authority_notice', 'N-RACE', now(), $4, $5)`,
        [RACE_RECALL, TENANT, P_TRACKED, "c".repeat(64), ACTOR],
      );
      await recall.query(
        `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code,
                                     recall_id, placed_by)
         VALUES ($1, $2, $3, $4, 'recall_hold', 'recall', $5, $6)`,
        [uuid(), TENANT, I_RACE, P_TRACKED, RACE_RECALL, ACTOR],
      );
      const returning = asTenant(A, (c) =>
        writeReturnEffects(c, { tenantId: TENANT, storeId: STORE, saleId, returnId, resolveLandingStatus: returnTo("sellable") }),
      );
      // Wait until the return blocks on the recall's lock, then commit the recall.
      const blocked = await waitUntilBlockedBy(recall);
      await recall.query("COMMIT");
      await returning;
      expect(blocked).toBe(true);
    } finally {
      await recall.query("ROLLBACK").catch(() => undefined);
      recall.release();
    }
    // Had the return read the recall state before waiting, it would have seen
    // no recall and landed in return_inspection.
    expect(await effectsOf({ eventRefId: returnId })).toEqual([
      expect.objectContaining({
        external_id: `return_line:${returnLines[0]}`,
        inventory_status: "recall_hold",
        tracking_identity_id: I_RACE,
      }),
    ]);
  });

  it("another tenant's context writes no tracked effect for this tenant's sale or return", async () => {
    if (skip()) return;
    await setActivation(B, true);
    const { saleId, lineIds } = await seedSale(A, [{ product: P_TRACKED, quantity: "1", tracking: valid(I_LOT) }], "tracked");
    const { returnId } = await seedReturn({ saleId }, [{ saleLineId: lineIds[0]!, quantity: "1" }]);
    const outcomes = await asTenant(B, async (c) => [
      await writeSaleLineEffects(c, { tenantId: TENANT_B, storeId: STORE, saleId }),
      await writeReturnEffects(c, { tenantId: TENANT_B, storeId: STORE, saleId, returnId, resolveLandingStatus: returnTo("sellable") }),
    ]);
    expect(outcomes.map((o) => o.written.length)).toEqual([0, 0]);
    expect(await effectsOf({ eventRefId: saleId })).toEqual([]);
    expect(await effectsOf({ eventRefId: returnId })).toEqual([]);
  });
});

describe("tenant isolation (RLS)", () => {
  it("a writer in another tenant's context sees no sale and writes nothing", async () => {
    if (skip()) return;
    await setActivation(B, true);
    const { saleId } = await seedSale(A, [{ product: P_EACH, quantity: "1" }]);
    const outcome = await asTenant(B, (c) =>
      writeSaleLineEffects(c, { tenantId: TENANT_B, storeId: STORE, saleId }),
    );
    expect(outcome.written).toEqual([]);
    expect(await effectsOf({ eventRefId: saleId })).toEqual([]);
  });

  it("tenant B cannot see or link tenant A's effects", async () => {
    if (skip()) return;
    await setActivation(A, true);
    const { saleId } = await seedSale(A, [{ product: P_EACH, quantity: "1" }]);
    await asTenant(A, (c) => writeSaleLineEffects(c, { tenantId: TENANT, storeId: STORE, saleId }));
    const posting = await seedPosting({ saleId, kind: "sale_post", sourceRefId: saleId });
    const seen = await asTenant(B, async (c) => {
      const rows = await c.query(`SELECT 1 FROM stock_movements WHERE event_ref_id = $1`, [saleId]);
      const linked = await linkEffectsToPostingIntent(c, {
        tenantId: TENANT_B,
        kind: "sale_post",
        sourceRefId: saleId,
        postingStatusId: posting,
        verdict: { status: "pending" },
      });
      return [rows.rowCount, linked];
    });
    expect(seen).toEqual([0, 0]);
    expect((await effectsOf({ eventRefId: saleId })).map((e) => e.state)).toEqual(["not_posted"]);
  });
});

describe("activation lock", () => {
  it("a writer that waited on the settings key is received after the holder (RT-453 SINCE_IDENTITY_ANCHOR)", async () => {
    if (skip()) return;
    await setActivation(A, true);
    const { saleId } = await seedSale(A, [{ product: P_EACH, quantity: "1.000000" }]);
    const holder = await pg().admin.connect();
    const writer = await (pg().app as Pool).connect();
    try {
      // The writer's transaction starts BEFORE the holder (an identity anchor) takes the key EXCLUSIVE.
      await writer.query("BEGIN");
      await writer.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT]);
      const started = (await writer.query<{ t: string }>(`SELECT now()::text AS t`)).rows[0]!.t;
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`, [
        TENANT,
      ]);
      const pending = writeSaleLineEffects(writer, { tenantId: TENANT, storeId: STORE, saleId });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const released = (await holder.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]!.t;
      await holder.query("COMMIT");
      expect((await pending).written).toHaveLength(1);
      await writer.query("COMMIT");
      const r = await pg().admin.query<{ after_release: boolean; after_start: boolean }>(
        `SELECT received_at > $2::timestamptz AS after_release, received_at > $3::timestamptz AS after_start
           FROM stock_movements WHERE event_ref_id = $1`,
        [saleId, released, started],
      );
      expect(r.rows).toEqual([{ after_release: true, after_start: true }]);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await holder.query("ROLLBACK").catch(() => undefined);
      writer.release();
      holder.release();
    }
  });

  it("the activation read waits for an EXCLUSIVE settings lock holder", async () => {
    if (skip()) return;
    const holder = await pg().admin.connect();
    const reader = await (pg().app as Pool).connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`, [
        TENANT,
      ]);
      await reader.query("BEGIN");
      await reader.query(`SET LOCAL lock_timeout = '300ms'`);
      await reader.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT]);
      const code = await readSaleEffectsActivation(reader, TENANT).then(
        () => null,
        (err: { code?: string }) => err.code ?? "unknown",
      );
      expect(code).toBe("55P03");
    } finally {
      await reader.query("ROLLBACK").catch(() => undefined);
      await holder.query("ROLLBACK").catch(() => undefined);
      reader.release();
      holder.release();
    }
  });
});
