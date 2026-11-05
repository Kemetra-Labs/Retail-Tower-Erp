/**
 * RT-1233 — a failed sale-processing drain reaches the dead-letter table and
 * the Console, against real Postgres (Testcontainers, every migration, the
 * NOBYPASSRLS `app_test` pool) and the real writers:
 *
 *   - the drain (`apps/worker`, `SaleProcessingProcessor`) wired to
 *   - the dead-letter producer (`apps/worker`, `SaleSyncDeadletterProducer`),
 *   - read back through the Console sale-sync-ops HTTP surface (the real
 *     `SaleSyncOpsModule` and its read model).
 *
 * A failure is forced on the drain's own transition only: a test-only BEFORE
 * UPDATE trigger raises a chosen SQLSTATE when `processed_at` goes from NULL to
 * set for a sale listed in `rt1233_forced_failure`. The producer's status
 * writes never set `processed_at`, so the trigger never fires on them.
 *
 * What this proves (RT-1233 acceptance 1):
 *   - a non-retryable failure (SQLSTATE 23514) gives ONE open `needs-repair`
 *     row with provenance, `sync_status = failed-needs-repair`, and the sale is
 *     listed by GET needs-repair; the job is told not to retry;
 *   - a retryable failure (SQLSTATE 40001) gives `failed-retryable`, NO
 *     dead-letter row, and the ORIGINAL error is rethrown so BullMQ retries;
 *     the retry then converges to `synced`;
 *   - a re-delivery creates no duplicate row and moves nothing;
 *   - a sale another drain synced concurrently is not overwritten.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";

import { SaleSyncOpsModule } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.module";
import { SaleProcessingQuarantinedError } from "../../../../worker/src/sales/sale-processing-failure";
import { SaleProcessingProcessor } from "../../../../worker/src/sales/sale-processing.processor";
import { SaleSyncDeadletterProducer } from "../../../../worker/src/sales/sale-sync-deadletter.producer";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X, TENANT_A } from "../__support__/isolation-harness";
import { bootScopedApp, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { SALES_SOURCE_SYSTEM } from "../sales/__support__/seed-sales";
import { seedSaleSyncStoreScope } from "./__support__/sale-sync-store-scope";

const BASE = "/api/v1/catalog/sale-sync-ops";
const SALE_REPAIR = "0a000000-0000-7000-8000-000001233a01";
const SALE_RETRY = "0a000000-0000-7000-8000-000001233a02";
const SALE_RACE_RETRY = "0a000000-0000-7000-8000-000001233a03";
const SALE_RACE_REPAIR = "0a000000-0000-7000-8000-000001233a04";
const ALL_SALES = [SALE_REPAIR, SALE_RETRY, SALE_RACE_RETRY, SALE_RACE_REPAIR];
const externalIdOf = (saleId: string): string => `rt1233-${saleId}`;

/** check_violation: deterministic → VALIDATION_FAILURE → needs-repair. */
const NON_RETRYABLE = "23514";
/** serialization_failure: TRANSIENT → failed-retryable. */
const RETRYABLE = "40001";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSaleSyncStoreScope(env);
    for (const id of ALL_SALES) {
      await env.admin.query(
        `INSERT INTO sales
           (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
            source_system, external_id, payload_hash, created_by)
         VALUES ($1, $2, $3, 'USD', 1.0000, now(), '2026-11-05', $4, $5, $6, $7)`,
        [id, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, externalIdOf(id), "b".repeat(64), ACTOR_A],
      );
    }
    // Test-only failure injection (this spec's own cloned database).
    await env.admin.query(`
      CREATE TABLE rt1233_forced_failure (sale_id uuid PRIMARY KEY, errcode text NOT NULL);
      CREATE FUNCTION rt1233_force_failure() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
      DECLARE v_code text;
      BEGIN
        SELECT errcode INTO v_code FROM rt1233_forced_failure WHERE sale_id = NEW.id;
        IF v_code IS NOT NULL THEN
          RAISE EXCEPTION 'rt1233 forced drain failure' USING ERRCODE = v_code;
        END IF;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER rt1233_force_failure BEFORE UPDATE ON sales
        FOR EACH ROW WHEN (OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL)
        EXECUTE FUNCTION rt1233_force_failure();
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1233 sale-processing-deadletter] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[RT-1233 sale-processing-deadletter] skipping — Docker unavailable");
    return true;
  }
  return false;
}

async function forceFailure(saleId: string, errcode: string | null): Promise<void> {
  await env!.admin.query(`DELETE FROM rt1233_forced_failure WHERE sale_id = $1`, [saleId]);
  if (errcode !== null) {
    await env!.admin.query(`INSERT INTO rt1233_forced_failure (sale_id, errcode) VALUES ($1, $2)`, [saleId, errcode]);
  }
}

/** The drain as WorkerModule builds it: the processor wired to the producer, on one pool. */
function drain(saleId: string, pool: Pool = env!.app): Promise<unknown> {
  const processor = new SaleProcessingProcessor(pool, undefined, new SaleSyncDeadletterProducer(pool));
  return processor.process({ saleId, tenantId: TENANT_A, storeId: STORE_A_X, correlationId: "not-a-uuid" });
}

async function drainError(saleId: string, pool?: Pool): Promise<unknown> {
  return await drain(saleId, pool).then(
    () => {
      throw new Error("expected the drain to fail");
    },
    (err: unknown) => err,
  );
}

async function stored(saleId: string): Promise<{ version: number; status: string; processed: boolean }> {
  const r = await env!.admin.query<{ v: string; s: string; p: boolean }>(
    `SELECT sync_status_version::text AS v, sync_status AS s, processed_at IS NOT NULL AS p
       FROM sales WHERE id = $1`,
    [saleId],
  );
  return { version: Number(r.rows[0]!.v), status: r.rows[0]!.s, processed: r.rows[0]!.p };
}

interface DeadletterRow {
  classification: string;
  reason_code: string;
  source_system: string;
  external_id: string;
  correlation_id: string | null;
  resolved_at: Date | null;
}

async function deadletters(saleId: string): Promise<DeadletterRow[]> {
  const r = await env!.admin.query<DeadletterRow>(
    `SELECT classification, reason_code, source_system, external_id, correlation_id, resolved_at
       FROM sale_sync_deadletters WHERE sale_id = $1`,
    [saleId],
  );
  return r.rows;
}

async function needsRepairRefs(): Promise<Array<Record<string, unknown>>> {
  const res = await request(app!.getHttpServer())
    .get(`${BASE}/needs-repair?page_size=100`)
    .set("x-test-session", SES_OWNER_ALL);
  expect(res.status).toBe(200);
  return res.body.items as Array<Record<string, unknown>>;
}

async function statusRead(saleId: string): Promise<Record<string, unknown>> {
  const res = await request(app!.getHttpServer())
    .get(`${BASE}/sales/${saleId}/status`)
    .set("x-test-session", SES_OWNER_ALL);
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

/** A pool whose SECOND connect (the failure recording) first lets "another drain" sync the sale. */
function racingPool(saleId: string): Pool {
  let connects = 0;
  return {
    connect: async () => {
      connects += 1;
      if (connects === 2) {
        await forceFailure(saleId, null);
        await env!.admin.query(
          `UPDATE sales
              SET processed_at = now(), sync_status = 'synced',
                  sync_status_version = sync_status_version + 1
            WHERE id = $1`,
          [saleId],
        );
      }
      return env!.app.connect();
    },
  } as unknown as Pool;
}

describe("RT-1233 non-retryable drain failure → needs-repair, visible to the Console", () => {
  it("one open needs-repair row with provenance, failed-needs-repair, and the job is told not to retry", async () => {
    if (skip()) return;
    await forceFailure(SALE_REPAIR, NON_RETRYABLE);

    const err = await drainError(SALE_REPAIR);

    expect(err).toBeInstanceOf(SaleProcessingQuarantinedError);
    expect(((err as SaleProcessingQuarantinedError).cause as { code?: string }).code).toBe(NON_RETRYABLE);
    expect(await stored(SALE_REPAIR)).toEqual({ version: 1, status: "failed-needs-repair", processed: false });
    expect(await deadletters(SALE_REPAIR)).toEqual([
      {
        classification: "needs-repair",
        reason_code: "validation_failure",
        source_system: SALES_SOURCE_SYSTEM,
        external_id: externalIdOf(SALE_REPAIR),
        correlation_id: null, // the job's free-text correlation id is not a UUID
        resolved_at: null,
      },
    ]);
  });

  it("the Console read model lists it as needs-repair and the status read agrees", async () => {
    if (skip()) return;
    const item = (await needsRepairRefs()).find((i) => i["saleRef"] === SALE_REPAIR);
    expect(item).toMatchObject({
      saleRef: SALE_REPAIR,
      storeId: STORE_A_X,
      syncStatus: "failed-needs-repair",
      sourceSystem: SALES_SOURCE_SYSTEM,
      externalId: externalIdOf(SALE_REPAIR),
      reasonCode: "validation_failure",
    });
    expect(await statusRead(SALE_REPAIR)).toMatchObject({ syncStatus: "failed-needs-repair", syncStatusVersion: 1 });
  });

  it("a re-delivery creates no duplicate row and moves nothing", async () => {
    if (skip()) return;
    expect(await drainError(SALE_REPAIR)).toBeInstanceOf(SaleProcessingQuarantinedError);
    expect(await deadletters(SALE_REPAIR)).toHaveLength(1);
    expect(await stored(SALE_REPAIR)).toEqual({ version: 1, status: "failed-needs-repair", processed: false });
  });
});

describe("RT-1233 retryable drain failure → failed-retryable, BullMQ retries", () => {
  it("failed-retryable, no dead-letter row, and the ORIGINAL error is rethrown", async () => {
    if (skip()) return;
    await forceFailure(SALE_RETRY, RETRYABLE);

    const err = await drainError(SALE_RETRY);

    expect(err).not.toBeInstanceOf(SaleProcessingQuarantinedError);
    expect((err as { code?: string }).code).toBe(RETRYABLE);
    expect(await stored(SALE_RETRY)).toEqual({ version: 1, status: "failed-retryable", processed: false });
    expect(await deadletters(SALE_RETRY)).toEqual([]);
    expect((await needsRepairRefs()).map((i) => i["saleRef"])).not.toContain(SALE_RETRY);
  });

  it("a re-delivered transient failure moves nothing and still writes no row", async () => {
    if (skip()) return;
    expect(((await drainError(SALE_RETRY)) as { code?: string }).code).toBe(RETRYABLE);
    expect(await stored(SALE_RETRY)).toEqual({ version: 1, status: "failed-retryable", processed: false });
    expect(await deadletters(SALE_RETRY)).toEqual([]);
  });

  it("the retry converges: once the cause clears, the drain syncs the sale (happy path unchanged)", async () => {
    if (skip()) return;
    await forceFailure(SALE_RETRY, null);
    await expect(drain(SALE_RETRY)).resolves.toMatchObject({ saleId: SALE_RETRY, applied: true });
    expect(await stored(SALE_RETRY)).toEqual({ version: 2, status: "synced", processed: true });
    expect(await deadletters(SALE_RETRY)).toEqual([]);
  });
});

describe("RT-1233 a concurrent synced is never overwritten", () => {
  it.each([
    ["a transient failure", SALE_RACE_RETRY, RETRYABLE],
    ["a non-retryable failure", SALE_RACE_REPAIR, NON_RETRYABLE],
  ])("%s recorded after another drain synced the sale leaves it synced, with no row", async (_l, saleId, code) => {
    if (skip()) return;
    await forceFailure(saleId, code);

    const err = await drainError(saleId, racingPool(saleId));

    // Nothing was recorded, so the original error goes back to BullMQ; the
    // retry then converges to the winner's synced state.
    expect(err).not.toBeInstanceOf(SaleProcessingQuarantinedError);
    expect((err as { code?: string }).code).toBe(code);
    expect(await stored(saleId)).toEqual({ version: 1, status: "synced", processed: true });
    expect(await deadletters(saleId)).toEqual([]);
  });
});
