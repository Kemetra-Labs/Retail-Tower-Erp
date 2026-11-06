/**
 * RT-1250 — a Console sale-sync repair re-queues the sale even after the
 * 7-day re-drive window, against real Postgres (Testcontainers, every
 * migration, the NOBYPASSRLS `app_test` pool) and the real writers:
 *
 *   - the drain (`apps/worker`, `SaleProcessingProcessor`) wired to the
 *     dead-letter producer, which quarantines the sale as needs-repair;
 *   - the Console repair (`POST .../sales/{saleRef}/repair` over HTTP, the real
 *     `SaleSyncOpsModule`), which resolves the dead-letter and moves the sale
 *     to failed-retryable with no enqueue;
 *   - the RT-457 re-drive sweep (`PgSaleRedriveRepository` + the processor),
 *     with the DEFAULT window from `resolveSaleRedriveWindow({})`, so
 *     `SALE_REDRIVE_MAX_AGE_MS` is the unchanged 7 days.
 *
 * Owner decision (RT-1250 comment 15797): option 2 — the sweep also selects a
 * repaired sale by its repair time (the needs-repair row's `resolved_at`).
 *
 * What this proves (RT-1250 acceptance 1 and 2):
 *   - a sale captured 8 days ago, quarantined, then repaired through the
 *     Console ends up `synced` and processed, with one posting intent;
 *   - a replayed repair (same Idempotency-Key) writes nothing new;
 *   - the sweep alone processes it (the repair enqueues nothing); a double
 *     delivery (two overlapping ticks) processes it once, and a late
 *     re-delivery of the old BullMQ job is a no-op;
 *   - `sync_status_version` moves by exactly one per status write (RT-1061):
 *     0 captured → 1 failed-needs-repair → 2 failed-retryable → 3 synced.
 *
 * The repair's `resolved_at` is set back 20 minutes after the HTTP repair: the
 * sweep, like for a fresh capture, leaves an item younger than the minimum
 * age (15 minutes) for the next tick. That is the only clock moved; the
 * window itself is the production default.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { SaleSyncOpsModule } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.module";
import { SaleProcessingQuarantinedError } from "../../../../worker/src/sales/sale-processing-failure";
import { SaleProcessingProcessor } from "../../../../worker/src/sales/sale-processing.processor";
import {
  DEFAULT_SALE_REDRIVE_MAX_AGE_MS,
  resolveSaleRedriveWindow,
} from "../../../../worker/src/sales/sale-redrive.config";
import { SALE_REDRIVE_JOB_NAME, SaleRedriveProcessor } from "../../../../worker/src/sales/sale-redrive.processor";
import { PgSaleRedriveRepository } from "../../../../worker/src/sales/sale-redrive.repository";
import { SaleSyncDeadletterProducer } from "../../../../worker/src/sales/sale-sync-deadletter.producer";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X, TENANT_A } from "../__support__/isolation-harness";
import { bootScopedApp, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { SALES_SOURCE_SYSTEM } from "../sales/__support__/seed-sales";
import { seedSaleSyncStoreScope } from "./__support__/sale-sync-store-scope";

const BASE = "/api/v1/catalog/sale-sync-ops";
const SALE = "0a000000-0000-7000-8000-000001250a01";
const REPAIR_KEY = "rt1250-repair-key-0001";
const POSTING_EVENT = "erpnext.posting.requested";
/** check_violation: deterministic → VALIDATION_FAILURE → needs-repair. */
const NON_RETRYABLE = "23514";
const CAPTURE_AGE_DAYS = 8;
const quiet = (): void => undefined;

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
/** Every (version, status) pair seen, to prove one version per status write. */
const observed = new Map<number, string>();

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSaleSyncStoreScope(env);
    await env.admin.query(
      `INSERT INTO sales
         (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
          source_system, external_id, payload_hash, created_by, created_at)
       VALUES ($1, $2, $3, 'USD', 1.0000, now() - ($7::int * interval '1 day'), '2026-10-29',
               $4, $5, $6, $8, now() - ($7::int * interval '1 day'))`,
      [SALE, TENANT_A, STORE_A_X, SALES_SOURCE_SYSTEM, `rt1250-${SALE}`, "c".repeat(64), CAPTURE_AGE_DAYS, ACTOR_A],
    );
    // Test-only failure injection on the drain's own transition (this spec's
    // own cloned database), the RT-1233 spec's technique.
    await env.admin.query(`
      CREATE TABLE rt1250_forced_failure (sale_id uuid PRIMARY KEY, errcode text NOT NULL);
      CREATE FUNCTION rt1250_force_failure() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
      DECLARE v_code text;
      BEGIN
        SELECT errcode INTO v_code FROM rt1250_forced_failure WHERE sale_id = NEW.id;
        IF v_code IS NOT NULL THEN
          RAISE EXCEPTION 'rt1250 forced drain failure' USING ERRCODE = v_code;
        END IF;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER rt1250_force_failure BEFORE UPDATE ON sales
        FOR EACH ROW WHEN (OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL)
        EXECUTE FUNCTION rt1250_force_failure();
    `);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1250 sale-repair-redrive] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[RT-1250 sale-repair-redrive] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function record(version: number, status: string): void {
  const seen = observed.get(version);
  if (seen !== undefined) expect({ version, status }).toEqual({ version, status: seen });
  observed.set(version, status);
}

async function stored(): Promise<{ version: number; status: string; processed: boolean }> {
  const r = await env!.admin.query<{ v: string; s: string; p: boolean }>(
    `SELECT sync_status_version::text AS v, sync_status AS s, processed_at IS NOT NULL AS p
       FROM sales WHERE id = $1`,
    [SALE],
  );
  const row = { version: Number(r.rows[0]!.v), status: r.rows[0]!.s, processed: r.rows[0]!.p };
  record(row.version, row.status);
  return row;
}

async function deadletters(): Promise<Array<{ classification: string; resolved: boolean }>> {
  const r = await env!.admin.query<{ classification: string; resolved: boolean }>(
    `SELECT classification, resolved_at IS NOT NULL AS resolved FROM sale_sync_deadletters WHERE sale_id = $1`,
    [SALE],
  );
  return r.rows;
}

async function postingEventCount(): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events WHERE event_type = $1 AND payload->>'source_ref_id' = $2`,
    [POSTING_EVENT, SALE],
  );
  return Number(r.rows[0]!.n);
}

/** The old BullMQ sale-processing job, as WorkerModule builds it. */
function drain(): Promise<{ applied: boolean }> {
  return new SaleProcessingProcessor(env!.app, undefined, new SaleSyncDeadletterProducer(env!.app)).process({
    saleId: SALE,
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    correlationId: null,
  });
}

/** One sweep tick, built as WorkerModule builds it, with the default window. */
function sweep(): Promise<{ salesProcessed: number }> {
  return new SaleRedriveProcessor(
    new PgSaleRedriveRepository(env!.app),
    new SaleProcessingProcessor(env!.app, undefined, new SaleSyncDeadletterProducer(env!.app)),
    resolveSaleRedriveWindow({}),
    quiet,
  ).process(SALE_REDRIVE_JOB_NAME, {});
}

function repair(): request.Test {
  return request(app!.getHttpServer())
    .post(`${BASE}/sales/${SALE}/repair`)
    .set("x-test-session", SES_OWNER_ALL)
    .set("Idempotency-Key", REPAIR_KEY);
}

// Ordered: each step builds on the previous one.
describe("RT-1250 — repair after the 7-day window → re-driven by repair time → synced", () => {
  it("uses the unchanged default max age (7 days), and the sale is older than it", async () => {
    if (skip()) return;
    expect(resolveSaleRedriveWindow({}).maxAgeMs).toBe(DEFAULT_SALE_REDRIVE_MAX_AGE_MS);
    expect(DEFAULT_SALE_REDRIVE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(await stored()).toEqual({ version: 0, status: "captured", processed: false });
  });

  it("before the repair, the sweep leaves the old unprocessed sale alone (history stays history)", async () => {
    if (skip()) return;
    await sweep();
    expect(await stored()).toEqual({ version: 0, status: "captured", processed: false });
  });

  it("a non-retryable drain failure quarantines it as needs-repair (version 1)", async () => {
    if (skip()) return;
    await env!.admin.query(`INSERT INTO rt1250_forced_failure (sale_id, errcode) VALUES ($1, $2)`, [
      SALE,
      NON_RETRYABLE,
    ]);
    await expect(drain()).rejects.toBeInstanceOf(SaleProcessingQuarantinedError);
    expect(await stored()).toEqual({ version: 1, status: "failed-needs-repair", processed: false });
    expect(await deadletters()).toEqual([{ classification: "needs-repair", resolved: false }]);
    // The cause is fixed before the operator repairs.
    await env!.admin.query(`DELETE FROM rt1250_forced_failure WHERE sale_id = $1`, [SALE]);
  });

  it("the Console repair resolves the row and moves it to failed-retryable (version 2)", async () => {
    if (skip()) return;
    const res = await repair();
    expect(res.status).toBeLessThan(300);
    expect(res.body).toMatchObject({ saleRef: SALE, syncStatus: "failed-retryable", syncStatusVersion: 2 });
    record(res.body.syncStatusVersion, res.body.syncStatus);
    expect(await stored()).toEqual({ version: 2, status: "failed-retryable", processed: false });
    expect(await deadletters()).toEqual([{ classification: "needs-repair", resolved: true }]);
  });

  it("a replayed repair (same Idempotency-Key) returns the stored body and writes nothing", async () => {
    if (skip()) return;
    const res = await repair();
    expect(res.status).toBeLessThan(300);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body).toMatchObject({ syncStatus: "failed-retryable", syncStatusVersion: 2 });
    expect(await stored()).toEqual({ version: 2, status: "failed-retryable", processed: false });
    expect(await deadletters()).toEqual([{ classification: "needs-repair", resolved: true }]);
  });

  it("a repair younger than the minimum age is left for a later tick", async () => {
    if (skip()) return;
    await sweep();
    expect(await stored()).toEqual({ version: 2, status: "failed-retryable", processed: false });
    expect(await postingEventCount()).toBe(0);
  });

  it("once the repair is past the minimum age, a double delivery processes it once (version 3, synced)", async () => {
    if (skip()) return;
    // 20 minutes pass (the minimum age is 15).
    await env!.admin.query(
      `UPDATE sale_sync_deadletters SET resolved_at = resolved_at - interval '20 minutes' WHERE sale_id = $1`,
      [SALE],
    );

    // The sweep alone must pick it up (no job was enqueued by the repair):
    // two overlapping ticks deliver it twice and process it once.
    const [a, b] = await Promise.all([sweep(), sweep()]);

    expect(a.salesProcessed + b.salesProcessed).toBe(1);
    expect(await stored()).toEqual({ version: 3, status: "synced", processed: true });
    expect(await postingEventCount()).toBe(1);
  });

  it("a late re-delivery of the old sale-processing job is a no-op", async () => {
    if (skip()) return;
    await expect(drain()).resolves.toMatchObject({ applied: false });
    expect(await stored()).toEqual({ version: 3, status: "synced", processed: true });
    expect(await postingEventCount()).toBe(1);
  });

  it("a later tick is a no-op: the processed sale is no longer selected", async () => {
    if (skip()) return;
    const found = await new PgSaleRedriveRepository(env!.app).findUnprocessedSales(
      TENANT_A,
      resolveSaleRedriveWindow({}),
      100,
    );
    expect(found.map((s) => s.saleId)).not.toContain(SALE);
    await sweep();
    expect(await stored()).toEqual({ version: 3, status: "synced", processed: true });
    expect(await postingEventCount()).toBe(1);
  });

  it("over the whole walk: strictly one version per status, and the versions only went up", async () => {
    if (skip()) return;
    expect([...observed.entries()].sort(([x], [y]) => x - y)).toEqual([
      [0, "captured"],
      [1, "failed-needs-repair"],
      [2, "failed-retryable"],
      [3, "synced"],
    ]);
  });
});
