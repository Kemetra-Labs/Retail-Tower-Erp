/**
 * RT-1312 Phase 3(b), slice C: `consoleRepairQuarantinedSale` over HTTP against
 * real Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test`
 * pool, the real module graph; only cookie authentication is faked, by the
 * RT-192 header stand-in). The repair runs the production capture code
 * (`captureSaleInTransaction`) on the item's stored body.
 *
 * Route (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft):
 *   POST /quarantined-sales/{quarantineRef}/repair   consoleRepairQuarantinedSale
 *
 * What this proves:
 *   - a repair captures the sale exactly once: one `sales` row for the
 *     provenance, attributed to the repairer (no cashier in the body), the
 *     uploading device, in the item's store; the item resolves to `captured`
 *     with its sale, the repair counted and the body kept (200, never 201);
 *   - an identical retry (same Idempotency-Key) replays the stored answer and a
 *     second repair of the resolved item is 409 `repair_conflict`: still one
 *     sale; two repairs at once: exactly one wins (the locking read);
 *   - `previousTerminalId` becomes the sale's device; a cashier named in the
 *     body is the sale's `created_by` when it was a member at `occurredAt`,
 *     including one removed since, and is `repair_operator_unproven` (item
 *     stays open, nothing captured) when it was not;
 *   - the capture rules still refuse: a 422 or a body-shape 400 keeps the item
 *     `open`, records the status and code, and leaves no sale rows (the
 *     savepoint), and a later repair counts again;
 *   - an already captured provenance with the same facts resolves the item
 *     (`already-captured`, no second sale); other facts (409) and a provenance
 *     captured in another store (404 `not_found`) keep it open for write-off;
 *   - the membership store scope bounds the repair: an item of an ungranted,
 *     deleted or foreign store, or none at all, is the identical 404 and
 *     writes nothing; an item that is not open is 409 with nothing changed;
 *   - the audit row carries ids, the state and the outcome, never the body.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";

import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { saleFactsDigest } from "../../../src/catalog/sales/quarantine/quarantine-facts";
import { SaleQuarantineOpsService } from "../../../src/catalog/sale-sync-ops/sale-quarantine-ops.service";
import { SaleQuarantineRepairService } from "../../../src/catalog/sale-sync-ops/sale-quarantine-repair.service";
import { SaleSyncOpsModule } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.module";
import { RepairConflictError } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.read-model.service";
import { schemaChecker } from "../../_helpers/scoped-http-harness";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import {
  bootScopedApp,
  S_DELETED,
  SES_OWNER_ALL,
  SES_OWNER_SPEC,
  SPECIFIC_SESSIONS,
} from "../erpnext-reconciliation/__support__/read-store-scope";
import { SES_ADMIN_EMPTY, seedSaleSyncStoreScope } from "./__support__/sale-sync-store-scope";

const BASE = "/api/v1/catalog/sale-sync-ops/quarantined-sales";
const repairPath = (ref: string): string => `${BASE}/${ref}/repair`;
const NOT_FOUND = { code: "not_found", message: "Not found." };
const conforms = schemaChecker("sale-sync-ops");

// The seeded users of the RT-192 fixture (read-store-scope.ts): the repairers and a cashier who is a member of tenant A.
const USER_OWNER_SPEC = "0a000000-0000-7000-8000-0000019202a1";
const USER_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019202a2";
const USER_CASHIER = "0a000000-0000-7000-8000-0000019202a3";
const USER_REMOVED = "0a000000-0000-7000-8000-000001312ee1";
const ADMIN_SESSION = SPECIFIC_SESSIONS.find(([role]) => role === "tenant_admin")![1];

// IDs use the `1312` mnemonic (hex only) and are valid UUIDv7.
const id = (n: number): string => `0a000000-0000-7000-8000-00000131${(0xc000 + n).toString(16).padStart(4, "0")}`;
const MISSING = id(0xfff);
const DEVICE_X = id(0xd1);
const DEVICE_X_OLD = id(0xd2);
const DEVICE_Y = id(0xd3);
const DEVICE_DEL = id(0xd4);
const DEVICE_B = "0b000000-0000-7000-8000-000000131cd5";
const DEVICE_OF: Record<string, string> = {
  [STORE_A_X]: DEVICE_X,
  [STORE_A_Y]: DEVICE_Y,
  [S_DELETED]: DEVICE_DEL,
  [STORE_B_X]: DEVICE_B,
};
const BODY_MARK = "BODY-MARK-must-never-be-audited";
const NOW = new Date();

interface Seed {
  readonly n: number;
  readonly store?: string;
  readonly tenant?: string;
  readonly body?: Record<string, unknown>;
  readonly state?: "open" | "captured" | "written-off";
  readonly previousTerminalId?: string;
}

/** A capture body the strict capture schema accepts (gates off): two lines, total 12.5. */
function captureBody(externalId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-pulse",
    externalId,
    currencyCode: "USD",
    posTotal: "12.5000",
    occurredAt: NOW.toISOString(),
    lines: [
      // The marker rides in a line name (the capture schema is closed): a repair must never copy it into an audit row.
      { lineName: BODY_MARK, unitPrice: "5.0000", currencyCode: "USD", quantity: "1", lineAmount: "5.0000", unit: "ea" },
      { lineName: "Gadget", unitPrice: "7.5000", currencyCode: "USD", quantity: "1", lineAmount: "7.5000", unit: "ea" },
    ],
    ...over,
  };
}
const ext = (n: number): string => `rt1312-repair-${n.toString(16)}`;

const SEEDS: readonly Seed[] = [
  { n: 1 }, // plain repair, no cashier
  { n: 2 }, // idempotent replay
  { n: 3 }, // specific tenant_admin repairs
  { n: 4, previousTerminalId: DEVICE_X_OLD }, // earlier pairing becomes the sale's device
  { n: 5, body: captureBody(ext(5), { operatorUserId: USER_CASHIER }) }, // member now
  { n: 6, body: captureBody(ext(6), { operatorUserId: USER_REMOVED, occurredAt: "2026-03-01T10:00:00.000Z" }) }, // removed since
  { n: 7, body: captureBody(ext(7), { operatorUserId: USER_CASHIER, occurredAt: "2025-12-01T10:00:00.000Z" }) }, // not yet a member
  { n: 8, body: captureBody(ext(8), { lines: [{ lineName: "Widget", unitPrice: "5.0000", currencyCode: "USD", quantity: "1", lineAmount: "6.0000", unit: "ea" }], posTotal: "6.0000" }) }, // 422 line pricing
  { n: 9, body: captureBody(ext(9), { notACaptureField: true }) }, // 400 body shape
  { n: 10 }, // already captured, same facts
  { n: 11 }, // captured with other facts
  { n: 12 }, // captured in another store
  { n: 13, store: STORE_A_Y }, // out of scope for a specific owner
  { n: 14, store: S_DELETED }, // deleted store
  { n: 15, store: STORE_B_X, tenant: TENANT_B }, // another tenant
  { n: 16, state: "captured" }, // not open
  { n: 17, state: "written-off" }, // not open
  { n: 18 }, // two repairs at once
  { n: 19 }, // scope and request-shape cases: never repaired
];
const Q = (n: number): string => id(n);

async function seedDevices(admin: Pool): Promise<void> {
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    [DEVICE_X, TENANT_A, STORE_A_X],
    [DEVICE_X_OLD, TENANT_A, STORE_A_X],
    [DEVICE_Y, TENANT_A, STORE_A_Y],
    [DEVICE_DEL, TENANT_A, S_DELETED],
    [DEVICE_B, TENANT_B, STORE_B_X],
  ];
  for (const [deviceId, tenant, store] of rows) {
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'rt1312-till', $4)`,
      [deviceId, tenant, store, `rt1312-repair-token-hash-${deviceId}`],
    );
  }
}

/**
 * Membership history for decision C2. The seeded cashier is backdated to 2026-01-01 (a member at the repaired
 * sales' `occurredAt`, not at 2025-12-01), and a second member was removed in June 2026, after the sale on
 * 2026-03-01, to prove a later removal does not block a historical repair.
 */
async function seedRemovedCashier(admin: Pool): Promise<void> {
  await admin.query(`UPDATE memberships SET created_at = '2026-01-01T00:00:00Z' WHERE tenant_id = $1 AND user_id = $2`, [
    TENANT_A,
    USER_CASHIER,
  ]);
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1312-removed@example.test')`, [USER_REMOVED]);
  const role = await admin.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND code = 'owner'`, [TENANT_A]);
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, created_at, revoked_at, deleted_at)
     VALUES ($1, $2, $3, $4, 'all', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [id(0xe1), TENANT_A, USER_REMOVED, role.rows[0]!.id],
  );
}

async function seedItems(admin: Pool): Promise<void> {
  for (const seed of SEEDS) {
    const store = seed.store ?? STORE_A_X;
    const tenant = seed.tenant ?? TENANT_A;
    const body = seed.body ?? captureBody(ext(seed.n));
    const state = seed.state ?? "open";
    const saleId = state === "captured" ? await insertSale(admin, tenant, store, "pos-pulse", ext(seed.n), "a".repeat(64)) : null;
    await admin.query(
      `INSERT INTO sale_quarantine_items
         (id, tenant_id, store_id, device_id, previous_terminal_id, source_system, external_id, idempotency_key,
          reason_kind, till_http_status, till_error_code, till_recorded_at, sale_body, facts_digest,
          summary_occurred_at, summary_pos_total, summary_currency_code, summary_line_count,
          state, resolved_at, sale_id, write_off_note)
       VALUES ($1, $2, $3, $4, $5, 'pos-pulse', $6, $7, 'refused', 422, 'sale_tender_mismatch', now(),
               $8::jsonb, $9, '2026-11-11T09:00:00Z', '12.5000', 'USD', 2,
               $10, CASE WHEN $10 = 'open' THEN NULL ELSE now() END, $11,
               CASE WHEN $10 = 'written-off' THEN 'handled outside' ELSE NULL END)`,
      [
        Q(seed.n),
        tenant,
        store,
        DEVICE_OF[store],
        seed.previousTerminalId ?? null,
        ext(seed.n),
        `rt1312-capture-key-${seed.n}`,
        JSON.stringify(body),
        saleFactsDigest(body) ?? "a".repeat(64),
        state,
        saleId,
      ],
    );
  }
}

let saleSeq = 0;
async function insertSale(
  admin: Pool,
  tenant: string,
  store: string,
  sourceSystem: string,
  externalId: string,
  payloadHash: string,
): Promise<string> {
  saleSeq += 1;
  const saleId = `0a000000-0000-7000-8000-00000131${(0x5000 + saleSeq).toString(16)}`;
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, sync_status)
     VALUES ($1, $2, $3, 'USD', 12.5000, $4, '2026-11-11', $5, $6, $7, $8, 'captured')`,
    [saleId, tenant, store, NOW.toISOString(), sourceSystem, externalId, payloadHash, USER_OWNER_SPEC],
  );
  return saleId;
}

interface ItemState {
  state: string;
  resolved_at: Date | null;
  sale_id: string | null;
  sale_body: unknown;
  repair_count: number;
  last_repair_outcome: string | null;
  last_repair_http_status: number | null;
  last_repair_error_code: string | null;
}

async function itemState(admin: Pool, ref: string): Promise<ItemState> {
  const r = await admin.query<ItemState>(
    `SELECT state, resolved_at, sale_id, sale_body, repair_count, last_repair_outcome,
            last_repair_http_status, last_repair_error_code
       FROM sale_quarantine_items WHERE id = $1`,
    [ref],
  );
  return r.rows[0]!;
}

interface SaleOf {
  id: string;
  store_id: string;
  created_by: string;
  device_id: string | null;
}

async function salesOf(admin: Pool, externalId: string): Promise<SaleOf[]> {
  const r = await admin.query<SaleOf>(
    `SELECT id, store_id, created_by, device_id FROM sales WHERE source_system = 'pos-pulse' AND external_id = $1`,
    [externalId],
  );
  return r.rows;
}

const lineCount = async (admin: Pool): Promise<number> =>
  Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sale_lines`)).rows[0]!.n);
const salesCount = async (admin: Pool): Promise<number> =>
  Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sales`)).rows[0]!.n);

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
const audited: AuditJobPayload[] = [];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSaleSyncStoreScope(env);
    await seedDevices(env.admin);
    await seedRemovedCashier(env.admin);
    await seedItems(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1312 sale-quarantine-repair] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, SaleSyncOpsModule, {
    enqueue: async (payload) => {
      audited.push(payload);
    },
  });
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1312 sale-quarantine-repair] skipping — Docker unavailable");
    return true;
  }
  return false;
}

let keySeq = 0;
const nextKey = (): string => {
  keySeq += 1;
  return `rt1312-repair-key-${String(keySeq).padStart(4, "0")}`;
};

/** A repair with its own Idempotency-Key unless one is given (one request at a time: supertest shares the not-yet-listening server). */
function repair(ref: string, session: string, key: string | null = nextKey()): request.Test {
  const req = request(app!.getHttpServer()).post(repairPath(ref)).set("x-test-session", session);
  return key === null ? req : req.set("Idempotency-Key", key);
}

const UNTOUCHED = { state: "open", resolved_at: null, sale_id: null, repair_count: 0, last_repair_outcome: null };

describe("RT-1312 consoleRepairQuarantinedSale: a repair captures the sale", () => {
  it("captures exactly once for the repairer, in the item's store, with the uploading device (200, not 201)", async () => {
    if (skip()) return;
    const auditBefore = audited.length;
    const res = await repair(Q(1), SES_OWNER_SPEC).expect(200);
    conforms("QuarantinedSale", res.body);
    expect(res.body).toMatchObject({
      quarantineRef: Q(1),
      state: "captured",
      saleRef: expect.any(String),
      repairCount: 1,
      lastRepair: { at: expect.any(String), outcome: "captured", httpStatus: null, errorCode: null },
    });
    const sales = await salesOf(env!.admin, ext(1));
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ id: res.body.saleRef, store_id: STORE_A_X, created_by: USER_OWNER_SPEC, device_id: DEVICE_X });
    const row = await itemState(env!.admin, Q(1));
    expect(row).toMatchObject({ state: "captured", sale_id: sales[0]!.id, repair_count: 1, last_repair_outcome: "captured" });
    expect(row.resolved_at).not.toBeNull();
    // Repair never edits the stored body (it is purged later, P3).
    expect(row.sale_body).toMatchObject({ externalId: ext(1) });
    // The sale's lines are written by the capture code.
    const lines = await env!.admin.query(`SELECT 1 FROM sale_lines WHERE sale_id = $1`, [sales[0]!.id]);
    expect(lines.rowCount).toBe(2);
    // Audited with ids, the state and the outcome, never the body.
    const events = audited.slice(auditBefore).filter((a) => a.action === "sale_sync_ops.quarantine.repair.requested");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: TENANT_A,
      metadata: { quarantine_ref: Q(1), store_id: STORE_A_X, state: "captured", outcome: "captured" },
    });
    expect(JSON.stringify(events[0])).not.toContain(BODY_MARK);
  });

  it("an identical retry replays the stored answer, and a second repair is 409 repair_conflict: still one sale", async () => {
    if (skip()) return;
    const key = nextKey();
    const first = await repair(Q(2), SES_OWNER_SPEC, key).expect(200);
    const replay = await repair(Q(2), SES_OWNER_SPEC, key).expect(200);
    expect(replay.body).toEqual(first.body);
    const again = await repair(Q(2), SES_OWNER_SPEC).expect(409);
    expect(again.body.error.code).toBe("repair_conflict");
    const sales = await salesOf(env!.admin, ext(2));
    expect(sales).toHaveLength(1);
    expect(first.body.saleRef).toBe(sales[0]!.id);
    expect((await itemState(env!.admin, Q(2))).repair_count).toBe(1);
  });

  it("a specific-membership tenant_admin repairs an item of the granted store, as itself", async () => {
    if (skip()) return;
    const res = await repair(Q(3), ADMIN_SESSION).expect(200);
    expect(res.body.state).toBe("captured");
    expect((await salesOf(env!.admin, ext(3)))[0]).toMatchObject({ created_by: USER_ADMIN_SPEC });
  });

  it("the earlier pairing's device becomes the sale's device", async () => {
    if (skip()) return;
    await repair(Q(4), SES_OWNER_SPEC).expect(200);
    expect((await salesOf(env!.admin, ext(4)))[0]).toMatchObject({ device_id: DEVICE_X_OLD, created_by: USER_OWNER_SPEC });
  });

  it("two repairs of one item at once: exactly one wins, the other is a conflict, one sale (the locking read)", async () => {
    if (skip()) return;
    const items = new SaleQuarantineOpsService(env!.app, { findRoleCodeForUserInTenant: async () => "owner" } as never);
    const service = new SaleQuarantineRepairService(items);
    const caller = {
      tenantId: TENANT_A,
      repairerUserId: USER_OWNER_SPEC,
      context: { tenantId: TENANT_A, storeId: null, userId: USER_OWNER_SPEC, isPlatformAdmin: false, source: "session", storeAccess: { kind: "all" } },
    } as never;
    const results = await Promise.allSettled([service.repair(caller, Q(18)), service.repair(caller, Q(18))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(RepairConflictError);
    expect(await salesOf(env!.admin, ext(18))).toHaveLength(1);
    expect((await itemState(env!.admin, Q(18))).repair_count).toBe(1);
  });
});

describe("RT-1312 consoleRepairQuarantinedSale: the cashier the body names (decision C2)", () => {
  it("a member at occurredAt is the sale's created_by", async () => {
    if (skip()) return;
    await repair(Q(5), SES_OWNER_SPEC).expect(200);
    expect((await salesOf(env!.admin, ext(5)))[0]).toMatchObject({ created_by: USER_CASHIER });
  });

  it("a member removed since occurredAt still counts: a later removal never blocks a historical repair", async () => {
    if (skip()) return;
    const res = await repair(Q(6), SES_OWNER_SPEC).expect(200);
    expect(res.body.state).toBe("captured");
    expect((await salesOf(env!.admin, ext(6)))[0]).toMatchObject({ created_by: USER_REMOVED });
  });

  it("a cashier who was not a member at occurredAt is repair_operator_unproven: nothing captured, the item stays open", async () => {
    if (skip()) return;
    const salesBefore = await salesCount(env!.admin);
    const res = await repair(Q(7), SES_OWNER_SPEC).expect(200);
    conforms("QuarantinedSale", res.body);
    expect(res.body).toMatchObject({
      state: "open",
      saleRef: null,
      repairCount: 1,
      lastRepair: { outcome: "refused", httpStatus: null, errorCode: "repair_operator_unproven" },
    });
    expect(await salesCount(env!.admin)).toBe(salesBefore);
    expect(await itemState(env!.admin, Q(7))).toMatchObject({ state: "open", sale_id: null, repair_count: 1, last_repair_outcome: "refused" });
    // It can only be written off, which still works.
    await request(app!.getHttpServer())
      .post(`${BASE}/${Q(7)}/write-off`)
      .set("x-test-session", SES_OWNER_SPEC)
      .set("Idempotency-Key", nextKey())
      .send({ note: "operator not provable" })
      .expect(200);
  });
});

describe("RT-1312 consoleRepairQuarantinedSale: the capture rules still refuse", () => {
  it("a 422 keeps the item open with the status and code, leaves no sale rows, and a later repair counts again", async () => {
    if (skip()) return;
    const salesBefore = await salesCount(env!.admin);
    const linesBefore = await lineCount(env!.admin);
    const res = await repair(Q(8), SES_OWNER_SPEC).expect(200);
    conforms("QuarantinedSale", res.body);
    expect(res.body).toMatchObject({
      state: "open",
      saleRef: null,
      repairCount: 1,
      lastRepair: { outcome: "refused", httpStatus: 422, errorCode: "sale_line_pricing_invalid" },
    });
    // The savepoint rolled the capture back, the item's record committed.
    expect(await salesCount(env!.admin)).toBe(salesBefore);
    expect(await lineCount(env!.admin)).toBe(linesBefore);
    expect(await salesOf(env!.admin, ext(8))).toHaveLength(0);
    const again = await repair(Q(8), SES_OWNER_SPEC).expect(200);
    expect(again.body).toMatchObject({ state: "open", repairCount: 2, lastRepair: { outcome: "refused", httpStatus: 422 } });
  });

  it("a body that is not a valid capture request is refused 400 validation_error", async () => {
    if (skip()) return;
    const res = await repair(Q(9), SES_OWNER_SPEC).expect(200);
    expect(res.body).toMatchObject({
      state: "open",
      lastRepair: { outcome: "refused", httpStatus: 400, errorCode: "validation_error" },
    });
    expect(await salesOf(env!.admin, ext(9))).toHaveLength(0);
  });

  it("an already captured provenance with the same facts resolves the item as already-captured, with no second sale", async () => {
    if (skip()) return;
    const body = captureBody(ext(10));
    const existing = await insertSale(env!.admin, TENANT_A, STORE_A_X, "pos-pulse", ext(10), saleFactsDigest(body)!);
    const res = await repair(Q(10), SES_OWNER_SPEC).expect(200);
    expect(res.body).toMatchObject({
      state: "already-captured",
      saleRef: existing,
      lastRepair: { outcome: "already-captured", httpStatus: null, errorCode: null },
    });
    expect(await salesOf(env!.admin, ext(10))).toHaveLength(1);
    expect(await itemState(env!.admin, Q(10))).toMatchObject({ state: "already-captured", sale_id: existing, repair_count: 1 });
  });

  it("a sale captured with other facts is refused 409 and the item stays open for write-off", async () => {
    if (skip()) return;
    await insertSale(env!.admin, TENANT_A, STORE_A_X, "pos-pulse", ext(11), "b".repeat(64));
    const res = await repair(Q(11), SES_OWNER_SPEC).expect(200);
    expect(res.body).toMatchObject({
      state: "open",
      saleRef: null,
      lastRepair: { outcome: "refused", httpStatus: 409, errorCode: "idempotency_key_conflict" },
    });
    expect(await salesOf(env!.admin, ext(11))).toHaveLength(1);
  });

  it("a provenance captured in ANOTHER store is refused 404 not_found, non-disclosing, and stays open", async () => {
    if (skip()) return;
    await insertSale(env!.admin, TENANT_A, STORE_A_Y, "pos-pulse", ext(12), saleFactsDigest(captureBody(ext(12)))!);
    const res = await repair(Q(12), SES_OWNER_SPEC).expect(200);
    expect(res.body).toMatchObject({
      state: "open",
      saleRef: null,
      lastRepair: { outcome: "refused", httpStatus: 404, errorCode: "not_found" },
    });
    expect(JSON.stringify(res.body)).not.toContain(STORE_A_Y);
  });
});

describe("RT-1312 consoleRepairQuarantinedSale: scope, state and request shape", () => {
  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: an out-of-scope repair is the identical 404 and writes nothing",
    async (_role, session) => {
      if (skip()) return;
      const salesBefore = await salesCount(env!.admin);
      const before = audited.length;
      for (const ref of [Q(13), Q(14), Q(15), MISSING]) {
        const res = await repair(ref, session).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
      for (const n of [13, 14, 15]) expect(await itemState(env!.admin, Q(n))).toMatchObject(UNTOUCHED);
      expect(await salesCount(env!.admin)).toBe(salesBefore);
      expect(audited.slice(before)).toEqual([]);
    },
  );

  it("an empty store scope cannot repair, and another tenant's item is 404 even for an all-membership owner", async () => {
    if (skip()) return;
    await repair(Q(19), SES_ADMIN_EMPTY).expect(404);
    await repair(Q(15), SES_OWNER_ALL).expect(404);
    expect(await itemState(env!.admin, Q(19))).toMatchObject(UNTOUCHED);
    expect(await itemState(env!.admin, Q(15))).toMatchObject(UNTOUCHED);
  });

  it.each([
    ["captured", 16],
    ["written-off", 17],
  ])("an item already %s is 409 repair_conflict, with nothing changed", async (state, n) => {
    if (skip()) return;
    const before = await itemState(env!.admin, Q(n));
    const res = await repair(Q(n), SES_OWNER_ALL).expect(409);
    expect(res.body.error.code).toBe("repair_conflict");
    expect(await itemState(env!.admin, Q(n))).toEqual(before);
    expect(before.state).toBe(state);
  });

  it("is 400 without an Idempotency-Key, and for a malformed ref, writing nothing", async () => {
    if (skip()) return;
    const salesBefore = await salesCount(env!.admin);
    await repair(Q(19), SES_OWNER_SPEC, null).expect(400);
    await repair("nope", SES_OWNER_SPEC).expect(400);
    expect(await itemState(env!.admin, Q(19))).toMatchObject(UNTOUCHED);
    expect(await salesCount(env!.admin)).toBe(salesBefore);
  });

  it("is 401 without a session", async () => {
    if (skip()) return;
    await request(app!.getHttpServer()).post(repairPath(Q(19))).set("Idempotency-Key", nextKey()).expect(401);
    expect(await itemState(env!.admin, Q(19))).toMatchObject(UNTOUCHED);
  });
});
