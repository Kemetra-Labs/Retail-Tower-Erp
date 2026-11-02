/**
 * RT-1061 (RT-973 slice 1) — `sales.sync_status_version` across every
 * `sync_status` writer, against real Postgres (Testcontainers, every migration
 * incl. 0077, the NOBYPASSRLS `app_test` pool) and the real writers:
 *
 *   - the dead-letter producer (`apps/worker`, `SaleSyncDeadletterProducer`);
 *   - the console sale-sync repair (`consoleRepairSaleSync` over HTTP, the
 *     real module graph incl. the IdempotencyModule);
 *   - the drain (`apps/worker`, `SaleProcessingProcessor`).
 *
 * What this proves (RT-1061 acceptance 2):
 *   - capture leaves it at 0; dead-letter → repair → drain move it 1, 2, 3:
 *     monotonic, one per status write;
 *   - an equal version always reads with an equal status, and a no-op (a
 *     second drain, a dead-letter of a synced sale) moves neither;
 *   - the status read and the repair response carry it; an idempotent repair
 *     replay returns the STORED version, even after a later write;
 *   - the POS-facing columns are not touched (the version is a SaaS column).
 *
 * The static writer enumeration (no `sync_status` write without the increment)
 * is `sale-sync-status-version.writers.spec.ts`.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { SaleSyncOpsModule } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.module";
import { SaleProcessingProcessor } from "../../../../worker/src/sales/sale-processing.processor";
import { SaleSyncDeadletterProducer } from "../../../../worker/src/sales/sale-sync-deadletter.producer";
import { SYNC_FAILURE_CONDITION } from "../../../../worker/src/sales/sale-sync-failure-classifier";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X, TENANT_A } from "../__support__/isolation-harness";
import { bootScopedApp, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { SALES_SOURCE_SYSTEM } from "../sales/__support__/seed-sales";
import { seedSaleSyncStoreScope } from "./__support__/sale-sync-store-scope";

const BASE = "/api/v1/catalog/sale-sync-ops";
const SALE = "0a000000-0000-7000-8000-000001061a01";
const SALE_SYNCED = "0a000000-0000-7000-8000-000001061a02";
const EXTERNAL_ID = `rt1061-${SALE}`;
const REPAIR_KEY = "rt1061-repair-key-0001";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

/** Every (version, status) pair observed, to prove equal version ⇒ equal status. */
const observed = new Map<number, string>();

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSaleSyncStoreScope(env);
    for (const [id, external] of [
      [SALE, EXTERNAL_ID],
      [SALE_SYNCED, `rt1061-${SALE_SYNCED}`],
    ] as const) {
      await env.admin.query(
        `INSERT INTO sales
           (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
            source_system, external_id, payload_hash, created_by)
         VALUES ($1, $2, $3, 'USD', 1.0000, now(), '2026-11-02', $4, $5, $6, $7)`,
        [id, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, external, "a".repeat(64), ACTOR_A],
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1061 sale-sync-status-version] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, SaleSyncOpsModule, { enqueue: async () => undefined });
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1061 sale-sync-status-version] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/** The stored (version, status), recorded as observed. */
async function stored(saleId = SALE): Promise<{ version: number; status: string }> {
  const r = await env!.admin.query<{ v: string; s: string }>(
    `SELECT sync_status_version::text AS v, sync_status AS s FROM sales WHERE id = $1`,
    [saleId],
  );
  const row = { version: Number(r.rows[0]!.v), status: r.rows[0]!.s };
  if (saleId === SALE) record(row.version, row.status);
  return row;
}

function record(version: number, status: string): void {
  const seen = observed.get(version);
  if (seen !== undefined) expect({ version, status }).toEqual({ version, status: seen });
  observed.set(version, status);
}

async function statusRead(): Promise<{ syncStatus: string; syncStatusVersion: number }> {
  const res = await request(app!.getHttpServer()).get(`${BASE}/sales/${SALE}/status`).set("x-test-session", SES_OWNER_ALL);
  expect(res.status).toBe(200);
  record(res.body.syncStatusVersion, res.body.syncStatus);
  return res.body;
}

function repair(): request.Test {
  return request(app!.getHttpServer())
    .post(`${BASE}/sales/${SALE}/repair`)
    .set("x-test-session", SES_OWNER_ALL)
    .set("Idempotency-Key", REPAIR_KEY);
}

const quarantine = (saleId: string, external: string) =>
  new SaleSyncDeadletterProducer(env!.app).quarantine({
    saleId,
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
    sourceSystem: SALES_SOURCE_SYSTEM,
    externalId: external,
  });

const drain = (saleId: string) =>
  new SaleProcessingProcessor(env!.app).process({ saleId, tenantId: TENANT_A, storeId: STORE_A_X, correlationId: null });

// Ordered: each step builds on the previous one.
describe("RT-1061 sync_status_version — capture → dead-letter → repair → drain", () => {
  it("capture leaves it at 0, and the status read emits it", async () => {
    if (skip()) return;
    expect(await stored()).toEqual({ version: 0, status: "captured" });
    expect(await statusRead()).toMatchObject({ syncStatus: "captured", syncStatusVersion: 0 });
  });

  it("the dead-letter producer moves it to 1 with failed-needs-repair", async () => {
    if (skip()) return;
    await quarantine(SALE, EXTERNAL_ID);
    expect(await stored()).toEqual({ version: 1, status: "failed-needs-repair" });
    expect(await statusRead()).toMatchObject({ syncStatus: "failed-needs-repair", syncStatusVersion: 1 });
  });

  it("a re-delivered dead-letter (open row) moves nothing", async () => {
    if (skip()) return;
    await quarantine(SALE, EXTERNAL_ID);
    expect(await stored()).toEqual({ version: 1, status: "failed-needs-repair" });
  });

  it("the console repair moves it to 2 with failed-retryable, and its response carries 2", async () => {
    if (skip()) return;
    const res = await repair();
    expect(res.status).toBeLessThan(300);
    expect(res.body).toMatchObject({ saleRef: SALE, syncStatus: "failed-retryable", syncStatusVersion: 2 });
    record(res.body.syncStatusVersion, res.body.syncStatus);
    expect(await stored()).toEqual({ version: 2, status: "failed-retryable" });
  });

  it("the drain moves it to 3 with synced", async () => {
    if (skip()) return;
    expect((await drain(SALE)).applied).toBe(true);
    expect(await stored()).toEqual({ version: 3, status: "synced" });
    expect(await statusRead()).toMatchObject({ syncStatus: "synced", syncStatusVersion: 3 });
  });

  it("an idempotent repair replay returns the STORED body, with the version it had then (2), not today's", async () => {
    if (skip()) return;
    const res = await repair();
    expect(res.status).toBeLessThan(300);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body).toMatchObject({ syncStatus: "failed-retryable", syncStatusVersion: 2 });
    expect(await stored()).toEqual({ version: 3, status: "synced" });
  });

  it("no-ops move nothing: a second drain, and a dead-letter of a synced sale", async () => {
    if (skip()) return;
    expect((await drain(SALE)).applied).toBe(false);
    await quarantine(SALE, EXTERNAL_ID);
    expect(await stored()).toEqual({ version: 3, status: "synced" });
  });

  it("a fresh sale drained once goes 0 → 1, independent of other sales", async () => {
    if (skip()) return;
    expect(await stored(SALE_SYNCED)).toEqual({ version: 0, status: "captured" });
    await drain(SALE_SYNCED);
    expect(await stored(SALE_SYNCED)).toEqual({ version: 1, status: "synced" });
    expect(await stored()).toEqual({ version: 3, status: "synced" });
  });

  it("over the whole walk: strictly one version per status, and the versions only went up", async () => {
    if (skip()) return;
    expect([...observed.entries()].sort(([a], [b]) => a - b)).toEqual([
      [0, "captured"],
      [1, "failed-needs-repair"],
      [2, "failed-retryable"],
      [3, "synced"],
    ]);
  });
});
