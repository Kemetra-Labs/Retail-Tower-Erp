/**
 * RT-1288 — ERP-origin stock import ingestion, end to end over HTTP
 * (`erpnext-connector/stock-import.yaml` 1.0.1-draft; migration 0096).
 *
 * Drives the real controller behind the real `ConnectorAuthGuard` and
 * `ConnectorEnvironmentGuard` against Postgres (Testcontainers), with two
 * activated tenants that each have a mapped bucket warehouse and an anchor.
 *
 * Acceptance criteria covered (RT-1288):
 *   - import exactly once across replays and the run-start overlap;
 *   - a Retail-provenance voucher is not imported;
 *   - a Retail-family voucher without provenance → `unattributed_erp_movement`;
 *   - a correction without its reference → finding; with it → `erp_correction`;
 *   - an ERP-native return → a negative effect;
 *   - a cancellation → a compensating effect keyed `…:cancel`;
 *   - hold landing: an identity with an active hold lands in the hold status;
 *   - the anchor watermark excludes covered rows, at the microsecond boundary,
 *     and an import racing an activation reads the activation's anchor;
 *   - cross-tenant isolation;
 *   - pending-aware reconciliation (RT-428) expects the imported receipt;
 *   - plus the feed (page 0 / page k+1, refusal, conflicts, findings).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { generateRawToken } from "@data-pulse-2/auth";
import { readPendingAwarePositions, runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { PG_POOL } from "../../../src/auth/auth.module";
import { AuthGuard } from "../../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../../src/auth/auth-token.repository";
import { ConnectorAuthGuard } from "../../../src/auth/connector-auth.guard";
import { SessionRepository } from "../../../src/auth/session.repository";
import { ErpnextStockImportController } from "../../../src/catalog/erpnext-stock-import/erpnext-stock-import.controller";
import { ErpnextStockImportService } from "../../../src/catalog/erpnext-stock-import/erpnext-stock-import.service";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_A_ACTIVE,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../__support__/isolation-harness";
import { RUN_A, RUN_B, seedReconciliationFixture } from "../erpnext-reconciliation/__support__/seed-reconciliation";

const FEED = "/api/connector/v1/erpnext/stock-import-requests";
const WH_A = "ERP-WH-017A"; // seeded by seedReconciliationFixture for STORE_A_X
const WH_B = "ERP-WH-1288B";
const ITEM_A = "ERP-ITEM-1288A";
const ITEM_BATCH = "ERP-ITEM-1288-LOT";
const ITEM_B = "ERP-ITEM-1288B";
const PRODUCT_BATCH = "0a000000-0000-7000-8000-000000128801";
const IDENTITY_LOT1 = "0a000000-0000-7000-8000-000000128811";
const IDENTITY_OTHER = "0a000000-0000-7000-8000-000000128812";
const PRODUCT_OTHER = "0a000000-0000-7000-8000-000000128802";
const CONNECTOR_A = "01900000-0000-7000-8000-000000128a01";
const CONNECTOR_B = "01900000-0000-7000-8000-000000128b01";
const ACTOR_USER = "01900000-0000-7000-8000-000000128c01";
/** The anchors' snapshot time (microsecond precision on purpose). */
const ANCHOR_READ_AT = "2026-11-10T00:00:00.123456Z";

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skip = false;
let tokenA = "";
let tokenB = "";

const savedDeploymentEnv = process.env["DEPLOYMENT_ENVIRONMENT"];
beforeAll(() => {
  process.env["DEPLOYMENT_ENVIRONMENT"] = "pilot";
});
afterAll(() => {
  if (savedDeploymentEnv === undefined) delete process.env["DEPLOYMENT_ENVIRONMENT"];
  else process.env["DEPLOYMENT_ENVIRONMENT"] = savedDeploymentEnv;
});

async function issueToken(tokens: AuthTokenRepository, tenantId: string, registrationId: string): Promise<string> {
  const raw = generateRawToken();
  await tokens.issue(raw, {
    id: newId(),
    tenantId,
    userId: ACTOR_USER,
    deviceId: null,
    scope: "connector",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    connectorRegistrationId: registrationId,
  } as Parameters<AuthTokenRepository["issue"]>[1]);
  return raw;
}

async function seedAnchor(tenantId: string, storeId: string, runId: string, warehouse: string, actor: string): Promise<void> {
  const a = env!.admin;
  await a.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $2, now(), $2)
     ON CONFLICT (tenant_id) DO UPDATE SET sale_effects_activated_at = now(), sale_effects_activated_by = $2`,
    [tenantId, actor],
  );
  await a.query(
    `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
        snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES ($1, $2, $3, (SELECT id FROM stock_locations WHERE store_id = $3 AND kind = 'primary'), 'sellable', 1, $4,
             $5::timestamptz, $5::timestamptz, $6, now(), '{}'::jsonb, $7)`,
    [newId(), tenantId, storeId, runId, ANCHOR_READ_AT, warehouse, actor],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'stock-import@svc.invalid', NULL) ON CONFLICT DO NOTHING`, [
      ACTOR_USER,
    ]);
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', $3, $4, 1)`,
      [TENANT_B, STORE_B_X, WH_B, ACTOR_B],
    );
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required, is_active, retired_at)
       VALUES ($1, $3, 'Lot product', 'standard', $4, $4, 'batch', false, true, NULL),
              ($2, $3, 'Other lot product', 'standard', $4, $4, 'batch', false, true, NULL)`,
      [PRODUCT_BATCH, PRODUCT_OTHER, TENANT_A, ACTOR_A],
    );
    for (const [tenant, product, item, actor] of [
      [TENANT_A, PRODUCT_A_ACTIVE, ITEM_A, ACTOR_A],
      [TENANT_A, PRODUCT_BATCH, ITEM_BATCH, ACTOR_A],
      [TENANT_B, PRODUCT_B_ACTIVE, ITEM_B, ACTOR_B],
    ] as const) {
      await a.query(
        `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())`,
        [tenant, product, item, actor],
      );
    }
    await a.query(
      `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code)
       VALUES ($1, $3, $4, 'batch', 'LOT-1'), ($2, $3, $5, 'batch', 'LOT-OTHER')`,
      [IDENTITY_LOT1, IDENTITY_OTHER, TENANT_A, PRODUCT_BATCH, PRODUCT_OTHER],
    );
    await a.query(
      `INSERT INTO erpnext_tracking_map (id, tenant_id, tracking_identity_id, kind, erpnext_ref)
       VALUES (gen_random_uuid(), $1, $2, 'batch', 'LOT-1'), (gen_random_uuid(), $1, $3, 'batch', 'LOT-OTHER')`,
      [TENANT_A, IDENTITY_LOT1, IDENTITY_OTHER],
    );
    await a.query(
      `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, command_fingerprint, placed_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'quality_hold', 'quality_check', repeat('a', 64), $4)`,
      [TENANT_A, IDENTITY_LOT1, PRODUCT_BATCH, ACTOR_A],
    );
    await seedAnchor(TENANT_A, STORE_A_X, RUN_A, WH_A, ACTOR_A);
    await seedAnchor(TENANT_B, STORE_B_X, RUN_B, WH_B, ACTOR_B);
    // The anchor's Bin line for product A: 10 ea.
    await a.query(
      `INSERT INTO inventory_anchor_lines (id, anchor_id, tenant_id, tenant_product_ref, quantity, erp_stock_uom, erpnext_item_ref)
       SELECT gen_random_uuid(), id, tenant_id, $2, 10, 'ea', $3 FROM inventory_anchors WHERE store_id = $1`,
      [STORE_A_X, PRODUCT_A_ACTIVE, ITEM_A],
    );
    for (const [id, tenant, actor] of [
      [CONNECTOR_A, TENANT_A, ACTOR_USER],
      [CONNECTOR_B, TENANT_B, ACTOR_USER],
    ] as const) {
      await a.query(
        `INSERT INTO connector_registration (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
         VALUES ($1, $2, 'Stock import', $3, 'pilot', $4)`,
        [id, tenant, `erp-${id.slice(-4)}.example`, actor],
      );
    }
    const tokens = new AuthTokenRepository(env.admin);
    tokenA = await issueToken(tokens, TENANT_A, CONNECTOR_A);
    tokenB = await issueToken(tokens, TENANT_B, CONNECTOR_B);

    const moduleRef = await Test.createTestingModule({
      controllers: [ErpnextStockImportController],
      providers: [
        { provide: PG_POOL, useFactory: (): Pool => env!.app },
        ErpnextStockImportService,
        { provide: SessionRepository, useValue: new SessionRepository(env.admin) },
        { provide: AuthTokenRepository, useValue: new AuthTokenRepository(env.admin) },
        AuthGuard,
        ConnectorAuthGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[stock-import.http.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const http = () => request(app!.getHttpServer());
let seq = 0;
/** A fresh creation after the anchor, strictly increasing across the file. */
function nextCreation(): string {
  seq += 1;
  return new Date(Date.UTC(2026, 10, 11, 8, 0, seq)).toISOString().replace("Z", "+00:00");
}

interface RowOpts {
  ref?: string;
  index?: number;
  voucherType?: string;
  voucherNo?: string;
  detail?: string | null;
  purpose?: string | null;
  isReturn?: boolean;
  returnAgainst?: string | null;
  creation?: string;
  cancelled?: boolean;
  qty?: string;
  uom?: string;
  item?: string;
  batch?: string | null;
  provenance?: boolean;
  correctionRef?: string | null;
}

function row(o: RowOpts = {}): Record<string, unknown> {
  return {
    ledgerEntryRef: o.ref ?? `SLE-${newId()}`,
    entryIndex: o.index ?? 0,
    voucherType: o.voucherType ?? "Purchase Receipt",
    voucherNo: o.voucherNo ?? `MAT-PRE-${newId().slice(-8)}`,
    voucherDetailNo: o.detail === undefined ? "row-1" : o.detail,
    purpose: o.purpose ?? null,
    isReturn: o.isReturn ?? false,
    returnAgainst: o.returnAgainst ?? null,
    postingDate: "2026-11-11",
    postingTime: "10:00:00",
    creation: o.creation ?? nextCreation(),
    isCancelled: o.cancelled ?? false,
    actualQty: o.qty ?? "5",
    stockUom: o.uom ?? "ea",
    erpnextItemRef: { doctype: "Item", name: o.item ?? ITEM_A },
    erpnextBatchRef: o.batch ? { doctype: "Batch", name: o.batch } : null,
    hasRetailProvenance: o.provenance ?? false,
    correctionRef: o.correctionRef ?? null,
  };
}

function report(rows: Record<string, unknown>[], exhausted = true): Record<string, unknown> {
  const last = rows[rows.length - 1];
  return {
    rows,
    readThrough: last
      ? { creation: last["creation"], ledgerEntryRef: last["ledgerEntryRef"], entryIndex: last["entryIndex"] }
      : null,
    exhausted: rows.length === 0 ? true : exhausted,
    readAt: "2026-11-11T12:00:00.000Z",
    refusal: null,
  };
}

/** Let the next pull open a new run (the run interval has passed for every closed run). */
async function rewindRuns(): Promise<void> {
  await env!.admin.query(
    `UPDATE erp_stock_import_runs SET started_at = started_at - interval '1 day', ended_at = ended_at - interval '1 day'
      WHERE status <> 'running'`,
  );
}

interface Item {
  requestRef: string;
  runRef: string;
  pageSeq: number;
  storeId: string;
  erpnextWarehouseRef: string;
  after: { creation: string; ledgerEntryRef: string | null; entryIndex: number | null } | null;
  overlapSeconds: number;
  settleSeconds: number;
  maxRows: number;
}

async function pull(token: string): Promise<Item[]> {
  const res = await http().get(FEED).set("Authorization", `Bearer ${token}`).expect(200);
  return res.body.items as Item[];
}

/** The open request for `warehouse`, opening a new run when none is open. */
async function openRequest(token: string, warehouse: string): Promise<Item> {
  await rewindRuns();
  const item = (await pull(token)).find((i) => i.erpnextWarehouseRef === warehouse);
  if (!item) throw new Error(`no open request for ${warehouse}`);
  return item;
}

function post(token: string, requestRef: string, body: object, key = `stockimport-${requestRef}`) {
  return http()
    .post(`${FEED}/${requestRef}/report`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send(body);
}

/** Report `rows` on a fresh request for tenant A's warehouse; returns the request. */
async function importA(rows: Record<string, unknown>[]): Promise<Item> {
  const item = await openRequest(tokenA, WH_A);
  await post(tokenA, item.requestRef, report(rows)).expect(201);
  return item;
}

async function rowRecord(ledgerEntryRef: string, index = 0) {
  const r = await env!.admin.query(
    `SELECT outcome, effect_key, effect_id, tracking_identity_id FROM erp_stock_import_rows
      WHERE ledger_entry_ref = $1 AND entry_index = $2`,
    [ledgerEntryRef, index],
  );
  return r.rows[0] as
    | { outcome: string; effect_key: string | null; effect_id: string | null; tracking_identity_id: string | null }
    | undefined;
}

async function findingsOf(ledgerEntryRef: string): Promise<string[]> {
  const r = await env!.admin.query(
    `SELECT f.kind FROM erp_stock_import_findings f JOIN erp_stock_import_rows r ON r.id = f.row_id
      WHERE r.ledger_entry_ref = $1`,
    [ledgerEntryRef],
  );
  return r.rows.map((x: { kind: string }) => x.kind);
}

async function effect(effectId: string) {
  const r = await env!.admin.query(
    `SELECT m.origin, m.event_type, m.movement_type, m.quantity::text AS quantity, m.source_system, m.external_id,
            m.inventory_status, m.tracking_identity_id, m.tenant_id, m.store_id,
            (m.stock_location_id = (SELECT id FROM stock_locations WHERE store_id = m.store_id AND kind = 'primary')) AS primary_location,
            i.state, i.erp_confirmed_at, i.posting_status_id
       FROM stock_movements m JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.id = $1`,
    [effectId],
  );
  return r.rows[0];
}

async function effectsByKeyPrefix(prefix: string): Promise<number> {
  const r = await env!.admin.query(
    `SELECT count(*)::int AS n FROM stock_movements WHERE source_system = 'erpnext' AND external_id LIKE $1`,
    [`${prefix}%`],
  );
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

describe("stockImportPullRequests — the feed", () => {
  it("refuses a non-connector caller (401)", async () => {
    if (skip) return;
    await http().get(FEED).expect(401);
  });

  it("opens a run per mapped warehouse of the caller's tenant only, page 0 with a null `after`", async () => {
    if (skip) return;
    const itemsA = await pull(tokenA);
    const itemsB = await pull(tokenB);
    const a = itemsA.find((i) => i.erpnextWarehouseRef === WH_A)!;
    expect(a).toEqual(
      expect.objectContaining({ pageSeq: 0, storeId: STORE_A_X, after: null, overlapSeconds: 0, settleSeconds: 300, maxRows: 100 }),
    );
    expect(itemsA.every((i) => i.erpnextWarehouseRef !== WH_B)).toBe(true);
    expect(itemsB.map((i) => i.erpnextWarehouseRef)).toEqual([WH_B]);
    // Re-pulling does not open a second run while one is running.
    const again = await pull(tokenA);
    expect(again.filter((i) => i.erpnextWarehouseRef === WH_A).map((i) => i.requestRef)).toEqual([a.requestRef]);
  });

  it("offers page k+1 after page k's report, with `after` = its readThrough as received", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    const r1 = row();
    await post(tokenA, item.requestRef, report([r1], false)).expect(201);
    const next = (await pull(tokenA)).find((i) => i.runRef === item.runRef)!;
    expect(next.pageSeq).toBe(item.pageSeq + 1);
    expect(next.after).toEqual({ creation: r1["creation"], ledgerEntryRef: r1["ledgerEntryRef"], entryIndex: 0 });
    expect(next.overlapSeconds).toBe(0);
    await post(tokenA, next.requestRef, report([])).expect(201);
  });

  it("starts the next run's page 0 at the last readThrough minus the overlap (≥ 3600 + settle)", async () => {
    if (skip) return;
    const last = await env!.admin.query(
      `SELECT read_through_creation FROM erp_stock_import_pages p JOIN erp_stock_import_runs r ON r.id = p.run_id
        WHERE r.erpnext_warehouse_ref = $1 AND p.read_through_creation IS NOT NULL ORDER BY p.recorded_at DESC LIMIT 1`,
      [WH_A],
    );
    const item = await openRequest(tokenA, WH_A);
    expect(item.overlapSeconds).toBe(3900);
    expect(item.after!.ledgerEntryRef).toBeNull();
    expect(item.after!.entryIndex).toBeNull();
    const expected = new Date((last.rows[0].read_through_creation as Date).getTime() - 3900 * 1000);
    expect(new Date(item.after!.creation).getTime()).toBe(expected.getTime());
    await post(tokenA, item.requestRef, report([])).expect(201);
  });
});

// ---------------------------------------------------------------------------
// Import and classification (DC-4)
// ---------------------------------------------------------------------------

describe("stockImportReportRows — DC-4 import", () => {
  it("imports a Purchase Receipt once: erp_external, external, erp_confirmed_at = creation, primary/sellable", async () => {
    if (skip) return;
    const r = row({ voucherNo: "MAT-PRE-0001", detail: "pri-1", qty: "5.25" });
    await importA([r]);
    const rec = (await rowRecord(r["ledgerEntryRef"] as string))!;
    expect(rec.outcome).toBe("imported");
    expect(rec.effect_key).toBe(`Purchase%20Receipt:MAT-PRE-0001:pri-1:${WH_A}`);
    const e = await effect(rec.effect_id!);
    expect(e).toEqual(
      expect.objectContaining({
        origin: "erp_external",
        event_type: "erp_procurement_receipt",
        movement_type: "inbound",
        quantity: "5.2500",
        source_system: "erpnext",
        inventory_status: "sellable",
        primary_location: true,
        state: "external",
        posting_status_id: null,
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
      }),
    );
    expect((e.erp_confirmed_at as Date).getTime()).toBe(new Date(r["creation"] as string).getTime());
  });

  it("imports exactly once across a replay, a re-report and the overlap re-read", async () => {
    if (skip) return;
    const r = row({ voucherNo: "MAT-PRE-ONCE", detail: "once-1" });
    const item = await openRequest(tokenA, WH_A);
    const body = report([r]);
    await post(tokenA, item.requestRef, body).expect(201);
    // Same key, same body: replayed.
    const replay = await post(tokenA, item.requestRef, body).expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(expect.objectContaining({ requestRef: item.requestRef, recordedRowCount: 1, exhausted: true }));
    // A later run re-reads the same row (overlap): recorded once, no second effect.
    await importA([r]);
    expect(await effectsByKeyPrefix("Purchase%20Receipt:MAT-PRE-ONCE:")).toBe(1);
    const n = await env!.admin.query(`SELECT count(*)::int AS n FROM erp_stock_import_rows WHERE ledger_entry_ref = $1`, [
      r["ledgerEntryRef"],
    ]);
    expect(n.rows[0].n).toBe(1);
  });

  it("answers 409 import_report_conflict for another key and idempotency_key_conflict for another body", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    const body = report([row()]);
    await post(tokenA, item.requestRef, body).expect(201);
    const other = await post(tokenA, item.requestRef, body, `another-key-${newId()}`).expect(409);
    expect(other.body.error.code).toBe("import_report_conflict");
    const changed = await post(tokenA, item.requestRef, report([row()])).expect(409);
    expect(changed.body.error.code).toBe("idempotency_key_conflict");
  });

  it("never imports a Retail-provenance voucher", async () => {
    if (skip) return;
    const r = row({ voucherType: "Sales Invoice", voucherNo: "SINV-RT-1", qty: "-1", provenance: true });
    await importA([r]);
    expect((await rowRecord(r["ledgerEntryRef"] as string))!.outcome).toBe("retail_provenance");
    expect(await findingsOf(r["ledgerEntryRef"] as string)).toEqual([]);
    expect(await effectsByKeyPrefix("Sales%20Invoice:SINV-RT-1:")).toBe(0);
  });

  it("raises an unattributed ERP movement for a Retail-family voucher without provenance", async () => {
    if (skip) return;
    const r = row({ voucherType: "Sales Invoice", voucherNo: "SINV-ERP-1", qty: "-2" });
    await importA([r]);
    expect((await rowRecord(r["ledgerEntryRef"] as string))!.outcome).toBe("finding");
    expect(await findingsOf(r["ledgerEntryRef"] as string)).toEqual(["unattributed_erp_movement"]);
    expect(await effectsByKeyPrefix("Sales%20Invoice:SINV-ERP-1:")).toBe(0);
  });

  it("raises a finding for a correction without its reference and imports one with it", async () => {
    if (skip) return;
    const without = row({ voucherType: "Stock Reconciliation", voucherNo: "RECO-1", purpose: "Stock Reconciliation", qty: "-1" });
    const withRef = row({
      voucherType: "Stock Reconciliation",
      voucherNo: "RECO-2",
      purpose: "Stock Reconciliation",
      qty: "-1",
      correctionRef: "BG-0001",
    });
    await importA([without, withRef]);
    expect(await findingsOf(without["ledgerEntryRef"] as string)).toEqual(["unattributed_erp_movement"]);
    const rec = (await rowRecord(withRef["ledgerEntryRef"] as string))!;
    expect(rec.outcome).toBe("imported");
    expect((await effect(rec.effect_id!)).event_type).toBe("erp_correction");
  });

  it("maps Manufacture, Repack and opening Stock Reconciliation to their ERP event types", async () => {
    if (skip) return;
    const rows = [
      row({ voucherType: "Stock Entry", voucherNo: "STE-MFG-1", purpose: "Manufacture" }),
      row({ voucherType: "Stock Entry", voucherNo: "STE-RPK-1", purpose: "Repack" }),
      row({ voucherType: "Stock Reconciliation", voucherNo: "RECO-OPEN-1", purpose: "Opening Stock" }),
      row({ voucherType: "Stock Entry", voucherNo: "STE-MI-1", purpose: "Material Issue", qty: "-1" }),
    ];
    await importA(rows);
    const types = [];
    for (const r of rows.slice(0, 3)) {
      const rec = (await rowRecord(r["ledgerEntryRef"] as string))!;
      types.push((await effect(rec.effect_id!)).event_type);
    }
    expect(types).toEqual(["erp_manufacturing", "erp_manufacturing", "erp_opening_stock"]);
    expect(await findingsOf(rows[3]!["ledgerEntryRef"] as string)).toEqual(["unattributed_erp_movement"]);
  });

  it("imports an ERP-native Purchase Return as a negative (outbound) procurement effect", async () => {
    if (skip) return;
    const r = row({ voucherNo: "MAT-PRE-RET-1", isReturn: true, returnAgainst: "MAT-PRE-0001", qty: "-2" });
    await importA([r]);
    const e = await effect((await rowRecord(r["ledgerEntryRef"] as string))!.effect_id!);
    expect(e).toEqual(expect.objectContaining({ event_type: "erp_procurement_receipt", movement_type: "outbound", quantity: "-2.0000" }));
  });

  it("compensates a cancellation with a `…:cancel` effect (DC-6)", async () => {
    if (skip) return;
    const original = row({ voucherNo: "MAT-PRE-CXL", detail: "cxl-1", qty: "4", cancelled: true });
    const reverse = row({ voucherNo: "MAT-PRE-CXL", detail: "cxl-1", qty: "-4", cancelled: true });
    await importA([original, reverse]);
    const o = (await rowRecord(original["ledgerEntryRef"] as string))!;
    const v = (await rowRecord(reverse["ledgerEntryRef"] as string))!;
    expect(o.effect_key).toBe(`Purchase%20Receipt:MAT-PRE-CXL:cxl-1:${WH_A}`);
    expect(v.effect_key).toBe(`Purchase%20Receipt:MAT-PRE-CXL:cxl-1:${WH_A}:cancel`);
    expect((await effect(o.effect_id!)).quantity).toBe("4.0000");
    expect((await effect(v.effect_id!)).quantity).toBe("-4.0000");
  });

  it("reports a second row under an existing key as duplicate_effect_key, never swallowed", async () => {
    if (skip) return;
    const first = row({ voucherNo: "MAT-PRE-DUP", detail: "dup-1" });
    const second = row({ voucherNo: "MAT-PRE-DUP", detail: "dup-1", ref: `SLE-${newId()}` });
    await importA([first, second]);
    expect((await rowRecord(first["ledgerEntryRef"] as string))!.outcome).toBe("imported");
    expect(await findingsOf(second["ledgerEntryRef"] as string)).toEqual(["duplicate_effect_key"]);
  });

  it("raises unknown_item, uom_mismatch, unkeyable_row and quantity_precision findings", async () => {
    if (skip) return;
    const unknown = row({ item: "NOT-MAPPED" });
    const uom = row({ uom: "box" });
    const unkeyable = row({ detail: null });
    const precise = row({ qty: "1.123456" });
    await importA([unknown, uom, unkeyable, precise]);
    expect(await findingsOf(unknown["ledgerEntryRef"] as string)).toEqual(["unknown_item"]);
    expect(await findingsOf(uom["ledgerEntryRef"] as string)).toEqual(["uom_mismatch"]);
    expect(await findingsOf(unkeyable["ledgerEntryRef"] as string)).toEqual(["unkeyable_row"]);
    expect(await findingsOf(precise["ledgerEntryRef"] as string)).toEqual(["quantity_precision"]);
  });
});

// ---------------------------------------------------------------------------
// Tracking: hold landing and the RT-453 hand-off
// ---------------------------------------------------------------------------

describe("stockImportReportRows — tracking", () => {
  it("lands at the identity's hold status when it has an active hold (G7-4)", async () => {
    if (skip) return;
    const r = row({ item: ITEM_BATCH, batch: "LOT-1", qty: "3" });
    await importA([r]);
    const rec = (await rowRecord(r["ledgerEntryRef"] as string))!;
    expect(rec.tracking_identity_id).toBe(IDENTITY_LOT1);
    const e = await effect(rec.effect_id!);
    expect(e).toEqual(expect.objectContaining({ inventory_status: "quality_hold", tracking_identity_id: IDENTITY_LOT1 }));
  });

  it("hands an unknown Batch to identity birth (no effect) and refuses another product's Batch", async () => {
    if (skip) return;
    const unknownLot = row({ item: ITEM_BATCH, batch: "LOT-NEW" });
    const foreignLot = row({ item: ITEM_BATCH, batch: "LOT-OTHER" });
    const noLot = row({ item: ITEM_BATCH });
    await importA([unknownLot, foreignLot, noLot]);
    const u = (await rowRecord(unknownLot["ledgerEntryRef"] as string))!;
    expect(u.outcome).toBe("awaiting_identity");
    expect(u.effect_id).toBeNull();
    expect(await findingsOf(foreignLot["ledgerEntryRef"] as string)).toEqual(["tracking_mismatch"]);
    expect(await findingsOf(noLot["ledgerEntryRef"] as string)).toEqual(["tracking_mismatch"]);
  });
});

// ---------------------------------------------------------------------------
// Anchor watermark (DC-8)
// ---------------------------------------------------------------------------

describe("stockImportReportRows — anchor watermark", () => {
  it("records a row at the anchor snapshot as covered and imports one a microsecond later", async () => {
    if (skip) return;
    const at = row({ voucherNo: "MAT-PRE-AT", creation: "2026-11-10T02:00:00.123456+02:00" });
    const after = row({ voucherNo: "MAT-PRE-AFTER", creation: "2026-11-10T00:00:00.123457Z" });
    await importA([at, after]);
    expect((await rowRecord(at["ledgerEntryRef"] as string))!.outcome).toBe("covered");
    expect((await rowRecord(after["ledgerEntryRef"] as string))!.outcome).toBe("imported");
  });

  it("reads the anchor an activation commits while the report waits (one consistent read)", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    const r = row({ voucherNo: "MAT-PRE-RACE", creation: "2026-11-10T12:00:00Z" });
    const holder = await env!.admin.connect();
    try {
      await holder.query("BEGIN");
      // What activation does: the settings key EXCLUSIVE, then a new anchor generation.
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings' || ':' || $1::text, 0))`, [
        TENANT_A,
      ]);
      const pending = post(tokenA, item.requestRef, report([r])).then((res) => res.status);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const waiting = await env!.admin.query(
        `SELECT count(*)::int AS n FROM erp_stock_import_rows WHERE ledger_entry_ref = $1`,
        [r["ledgerEntryRef"]],
      );
      expect(waiting.rows[0].n).toBe(0);
      await holder.query(
        `INSERT INTO inventory_anchors
           (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
            snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
         VALUES ($1, $2, $3, (SELECT id FROM stock_locations WHERE store_id = $3 AND kind = 'primary'), 'sellable', 2, $4,
                 '2026-11-10T13:00:00Z', '2026-11-10T13:00:00Z', $5, now(), '{}'::jsonb, $6)`,
        [newId(), TENANT_A, STORE_A_X, RUN_A, WH_A, ACTOR_A],
      );
      await holder.query("COMMIT");
      expect(await pending).toBe(201);
    } finally {
      holder.release();
    }
    // Generation 2's snapshot (13:00) contains the 12:00 row: covered, not imported twice.
    expect((await rowRecord(r["ledgerEntryRef"] as string))!.outcome).toBe("covered");
  });
});

// ---------------------------------------------------------------------------
// Refusal, cross-tenant, reconciliation
// ---------------------------------------------------------------------------

describe("stockImportReportRows — refusal, isolation and reconciliation", () => {
  it("records a refusal as an unmapped_warehouse finding and does not advance the run", async () => {
    if (skip) return;
    const item = await openRequest(tokenB, WH_B);
    const refusal = { rows: [], readThrough: null, exhausted: false, readAt: "2026-11-11T12:00:00Z", refusal: { reason: "unknown_warehouse" } };
    await post(tokenB, item.requestRef, refusal).expect(201);
    const f = await env!.admin.query(
      `SELECT kind, row_id FROM erp_stock_import_findings WHERE page_id = $1`,
      [item.requestRef],
    );
    expect(f.rows).toEqual([{ kind: "unmapped_warehouse", row_id: null }]);
    const run = await env!.admin.query(`SELECT status FROM erp_stock_import_runs WHERE id = $1`, [item.runRef]);
    expect(run.rows[0].status).toBe("refused");
    // The next run starts again from the same position (nothing was read: `after` null).
    const next = await openRequest(tokenB, WH_B);
    expect(next.runRef).not.toBe(item.runRef);
    expect(next.after).toBeNull();
    await post(tokenB, next.requestRef, report([])).expect(201);
  });

  it("is tenant-isolated: another tenant's requestRef is a non-disclosing 404 and nothing leaks", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    const res = await post(tokenB, item.requestRef, report([row({ item: ITEM_B })])).expect(404);
    expect(res.body.error.code).toBe("not_found");
    expect((await pull(tokenB)).some((i) => i.requestRef === item.requestRef)).toBe(false);
    // Tenant B's own import never lands in tenant A's store.
    const b = await openRequest(tokenB, WH_B);
    const rb = row({ item: ITEM_B, voucherNo: "MAT-PRE-B1" });
    await post(tokenB, b.requestRef, report([rb])).expect(201);
    const e = await effect((await rowRecord(rb["ledgerEntryRef"] as string))!.effect_id!);
    expect(e).toEqual(expect.objectContaining({ tenant_id: TENANT_B, store_id: STORE_B_X }));
    // RLS: tenant A's context sees none of tenant B's import rows.
    const seen = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM erp_stock_import_rows WHERE tenant_id = $1`, [TENANT_B]),
    );
    expect(seen.rows[0].n).toBe(0);
    await post(tokenA, item.requestRef, report([])).expect(201);
  });

  it("pending-aware reconciliation (RT-428) expects the imported Purchase Receipt (match inputs)", async () => {
    if (skip) return;
    const before = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      readPendingAwarePositions(c, STORE_A_X),
    );
    // No position yet (the latest anchor has no line for it and nothing moved since) reads as 0.
    const baseBook = Number(before.find((p) => p.tenantProductRef === PRODUCT_A_ACTIVE)?.expectedErpBook ?? "0");
    await importA([row({ voucherNo: "MAT-PRE-RECON", qty: "7" })]);
    const after = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      readPendingAwarePositions(c, STORE_A_X),
    );
    const p = after.find((x) => x.tenantProductRef === PRODUCT_A_ACTIVE)!;
    // A Bin that already holds the receipt reads expected_erp_book + 7, with no
    // pending term: the classifier's `match` (pending-aware-classify.ts).
    expect(Number(p.expectedErpBook) - baseBook).toBe(7);
    expect(Number(p.pendingErp)).toBe(0);
    expect(Number(p.pendingRetail)).toBe(0);
    expect(p.operationalUnit).toBe("ea");
  });
});

describe("stockImportReportRows — body rules (400)", () => {
  it("refuses a readThrough that is not the last row's position", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    const body = report([row(), row()]);
    (body["readThrough"] as Record<string, unknown>)["entryIndex"] = 7;
    const res = await post(tokenA, item.requestRef, body).expect(400);
    expect(res.body.error.code).toBe("validation_error");
    await post(tokenA, item.requestRef, report([])).expect(201);
  });

  it("refuses a body-supplied store or a float quantity", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    await post(tokenA, item.requestRef, { ...report([]), storeId: STORE_A_X }).expect(400);
    await post(tokenA, item.requestRef, report([{ ...row(), actualQty: 5 }])).expect(400);
    await post(tokenA, item.requestRef, report([])).expect(201);
  });
});

// ---------------------------------------------------------------------------
// Independent-review fixes (RT-1288)
// ---------------------------------------------------------------------------

describe("review fixes", () => {
  it("never compensates an original that was not imported (no stock-out of a receipt never booked)", async () => {
    if (skip) return;
    const LATE_ITEM = "ERP-ITEM-1288-LATE";
    const original = row({ voucherNo: "MAT-PRE-LATE", detail: "late-1", item: LATE_ITEM, qty: "6", cancelled: true });
    await importA([original]);
    expect(await findingsOf(original["ledgerEntryRef"] as string)).toEqual(["unknown_item"]);
    // The item is mapped afterwards; the voucher's cancellation (reverse row) now resolves.
    const product = newId();
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, 'Late', 'standard', $3, $3)`,
      [product, TENANT_A, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', 'manual', $4, now())`,
      [TENANT_A, product, LATE_ITEM, ACTOR_A],
    );
    const reverse = row({ voucherNo: "MAT-PRE-LATE", detail: "late-1", item: LATE_ITEM, qty: "-6", cancelled: true });
    await importA([reverse]);
    expect(await findingsOf(reverse["ledgerEntryRef"] as string)).toEqual(["duplicate_effect_key"]);
    expect(await effectsByKeyPrefix("Purchase%20Receipt:MAT-PRE-LATE:")).toBe(0);
  });

  it("links the cancel effect to the effect it compensates", async () => {
    if (skip) return;
    const original = row({ voucherNo: "MAT-PRE-CMP", detail: "cmp-1", qty: "2", cancelled: true });
    const reverse = row({ voucherNo: "MAT-PRE-CMP", detail: "cmp-1", qty: "-2", cancelled: true });
    await importA([original, reverse]);
    const o = (await rowRecord(original["ledgerEntryRef"] as string))!;
    const v = (await rowRecord(reverse["ledgerEntryRef"] as string))!;
    const r = await env!.admin.query(`SELECT compensates_effect_id FROM stock_movements WHERE id = $1`, [v.effect_id]);
    expect(r.rows[0].compensates_effect_id).toBe(o.effect_id);
  });

  it("stores the ERP document as {doctype, name} and keeps erpConfirmedAt's contract meaning in the positions read", async () => {
    if (skip) return;
    const r = row({ voucherNo: "MAT-PRE-DOC" });
    await importA([r]);
    const rec = (await rowRecord(r["ledgerEntryRef"] as string))!;
    const i = await env!.admin.query(`SELECT erp_document_ref FROM inventory_effect_integration WHERE effect_id = $1`, [rec.effect_id]);
    expect(JSON.parse(i.rows[0].erp_document_ref as string)).toEqual({ doctype: "Purchase Receipt", name: "MAT-PRE-DOC" });
    const positions = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      readPendingAwarePositions(c, STORE_A_X),
    );
    // No `confirmed` effect exists in this store: an external effect's creation is not a posted-ack time.
    expect(positions.every((p) => p.latestErpConfirmedAt === null)).toBe(true);
  });

  it("records an over-long key as unkeyable_row and refuses an entryIndex above INTEGER (400)", async () => {
    if (skip) return;
    const arabic = "م".repeat(140);
    const long = row({ voucherType: arabic, voucherNo: arabic, detail: arabic, item: ITEM_A });
    await importA([long]);
    expect(await findingsOf(long["ledgerEntryRef"] as string)).toEqual(["unkeyable_row"]);
    const item = await openRequest(tokenA, WH_A);
    const big = report([row({ index: 2_147_483_648 })]);
    expect((await post(tokenA, item.requestRef, big).expect(400)).body.error.code).toBe("validation_error");
    await post(tokenA, item.requestRef, report([])).expect(201);
  });

  it("offers an open page below the caller's cursor again once it is two minutes old", async () => {
    if (skip) return;
    const item = await openRequest(tokenA, WH_A);
    const later = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    const ahead = await http().get(`${FEED}?since=${later}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
    expect(ahead.body.items).toEqual([]);
    await env!.admin.query(`UPDATE erp_stock_import_pages SET issued_at = now() - interval '3 minutes' WHERE id = $1`, [
      item.requestRef,
    ]);
    const again = await http().get(`${FEED}?since=${later}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
    expect(again.body.items.map((i: Item) => i.requestRef)).toContain(item.requestRef);
    expect(again.body.cursor).toBe(later);
    await post(tokenA, item.requestRef, report([])).expect(201);
  });
});
