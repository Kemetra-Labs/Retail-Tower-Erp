/**
 * 017-US3 — service-direct branch coverage for triggerRun / getRun / listResults
 * / repairStock (the error + idempotent-echo arms the api HTTP spec drives but
 * attributes to the controller). Drives ErpnextReconciliationService directly.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ErpnextReconciliationService,
  RunNotFoundError,
  StoreNotFoundError,
} from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import type { ResolvedContext } from "../../../../src/context/types";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  RUN_A,
  RESULT_A,
  RUN_B,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let skip = false;
const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const NON_EXISTENT = "0f000000-0000-7000-8000-00000000dead";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[stock-service-branches.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextReconciliationService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextReconciliationService(env.app, new MembershipRepository(env.app));
}

/**
 * RT-191: the session context the service's writes take. Tenant-wide store
 * access, as `TenantContextGuard` resolves it for an `'all'` membership (ACTOR_A
 * has no membership row here, so the scope comes from `storeAccess`).
 */
function sessionCtx(tenantId: string): ResolvedContext {
  return {
    userId: ACTOR_A,
    tenantId,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
  };
}

describe("017-US3 service — triggerRun", () => {
  it("creates a running run for a real store", async () => {
    if (skip) return;
    const run = await svc().triggerRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), actorUserId: ACTOR_A, storeId: STORE_A_X });
    expect(run.status).toBe("running");
    expect(run.kind).toBe("stock");
    expect(run.finishedAt).toBeNull();
  });

  it("an unknown store → StoreNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc().triggerRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), actorUserId: ACTOR_A, storeId: NON_EXISTENT }),
    ).rejects.toBeInstanceOf(StoreNotFoundError);
  });
});

/** RT-189: a stored RT-175 report: 20 windows x 500 entries (~1.5 MB of jsonb). */
const FULL_REPORT_RUN = "0a000000-0000-7000-8000-00000e0189a1";
/** RT-189: a pre-RT-175 stored report (no complete / attemptRef / windows). */
const OLD_REPORT_RUN = "0a000000-0000-7000-8000-00000e0189a2";

describe("RT-189 service — getRun bounds summary.bin_view_report", () => {
  beforeAll(async () => {
    if (skip || !env) return;
    const entry = (i: number): Record<string, unknown> => ({
      erpnextItemRef: `ITEM-${String(i).padStart(6, "0")}-${"x".repeat(60)}`,
      productRef: null,
      quantity: "12.500",
      stockUom: "Nos",
    });
    const windows = Array.from({ length: 20 }, (_, w) => ({
      windowSeq: w,
      entryCount: 500,
      isFinal: w === 19,
      recordedAt: "2026-10-29T10:00:01.000Z",
    }));
    const full = {
      quantity_divergence: 4,
      bin_view_report: {
        requestRef: "req-189",
        runRef: FULL_REPORT_RUN,
        erpnextWarehouseRef: "WH-189",
        attemptRef: "att-189",
        readAt: "2026-10-29T10:00:00.000Z",
        recordedAt: "2026-10-29T10:00:01.000Z",
        complete: true,
        windowsRecorded: 20,
        acceptedEntryCount: 10_000,
        windows,
        entries: Array.from({ length: 10_000 }, (_, i) => entry(i)),
        supersededAttemptRefs: [],
      },
    };
    const old = {
      bin_view_report: {
        requestRef: "req-old",
        runRef: OLD_REPORT_RUN,
        erpnextWarehouseRef: "WH-old",
        readAt: "2026-01-01T00:00:00.000Z",
        recordedAt: "2026-01-01T00:00:01.000Z",
        entries: [entry(1), entry(2), entry(3)],
      },
    };
    for (const [id, summary] of [
      [FULL_REPORT_RUN, full],
      [OLD_REPORT_RUN, old],
    ] as const) {
      await env.admin.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, finished_at, actor_user_id, summary)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now(), $4, $5::jsonb)
         ON CONFLICT DO NOTHING`,
        [id, TENANT_A, STORE_A_X, ACTOR_A, JSON.stringify(summary)],
      );
    }
  }, 60_000);

  it("a full 20 x 500 report reads as metadata only: < 10 KB, no entries, other keys kept", async () => {
    if (skip) return;
    const run = await svc().getRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: FULL_REPORT_RUN });
    const json = JSON.stringify(run);
    expect(json.length).toBeLessThan(10_240);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("ITEM-");
    expect(run.summary).toEqual({
      quantity_divergence: 4,
      bin_view_report: {
        complete: true,
        windowsRecorded: 20,
        acceptedEntryCount: 10_000,
        readAt: "2026-10-29T10:00:00.000Z",
        recordedAt: "2026-10-29T10:00:01.000Z",
        attemptRef: "att-189",
      },
    });
  });

  it("a pre-RT-175 report reads with the normalizeStored defaults", async () => {
    if (skip) return;
    const run = await svc().getRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: OLD_REPORT_RUN });
    expect(run.summary).toEqual({
      bin_view_report: {
        complete: true,
        windowsRecorded: 1,
        acceptedEntryCount: 3,
        readAt: "2026-01-01T00:00:00.000Z",
        recordedAt: "2026-01-01T00:00:01.000Z",
        attemptRef: null,
      },
    });
  });
});

describe("017-US3 service — getRun / listResults", () => {
  it("getRun returns the seeded run", async () => {
    if (skip) return;
    const run = await svc().getRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_A });
    expect(run.id).toBe(RUN_A);
    expect(run.status).toBe("completed");
    expect(run.finishedAt).not.toBeNull();
  });

  it("getRun for a foreign-tenant run → RunNotFoundError", async () => {
    if (skip) return;
    await expect(svc().getRun({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_B })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });

  it("listResults returns the run's classified results; class filter narrows", async () => {
    if (skip) return;
    const all = await svc().listResults({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_A, cursor: null, limit: 100 });
    expect(all.items.some((i) => i.id === RESULT_A)).toBe(true);
    const filtered = await svc().listResults({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      runId: RUN_A,
      cursor: null,
      limit: 100,
      mismatchClass: "quantity_divergence",
    });
    for (const i of filtered.items) expect(i.mismatchClass).toBe("quantity_divergence");
  });

  it("listResults for a foreign run → RunNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc().listResults({ tenantId: TENANT_A, context: sessionCtx(TENANT_A), runId: RUN_B, cursor: null, limit: 100 }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("017-US3 service — repairStock", () => {
  it("an OPEN result → repaired (eligible_again); a 2nd repair → no_op_echo (replayed)", async () => {
    if (skip) return;
    // RESULT_A is seeded 'open'. First repair transitions it.
    await env!.admin.query(`UPDATE erpnext_reconciliation_result SET result_state='open' WHERE id=$1`, [
      RESULT_A,
    ]);
    const first = await svc().repairStock({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      runId: RUN_A,
      resultId: RESULT_A,
      repairKind: "re_sync",
    });
    expect(first.repair.outcome).toBe("eligible_again");
    expect(first.replayed).toBe(false);

    const state = await env!.admin.query<{ result_state: string }>(
      `SELECT result_state FROM erpnext_reconciliation_result WHERE id=$1`,
      [RESULT_A],
    );
    expect(state.rows[0]?.result_state).toBe("repaired");

    const second = await svc().repairStock({
      tenantId: TENANT_A,
      context: sessionCtx(TENANT_A),
      actorUserId: ACTOR_A,
      runId: RUN_A,
      resultId: RESULT_A,
      repairKind: "re_sync",
    });
    expect(second.repair.outcome).toBe("no_op_echo");
    expect(second.replayed).toBe(true);
  });

  it("a foreign run/result → RunNotFoundError", async () => {
    if (skip) return;
    await expect(
      svc().repairStock({
        tenantId: TENANT_A,
        context: sessionCtx(TENANT_A),
        actorUserId: ACTOR_A,
        runId: RUN_A,
        resultId: NON_EXISTENT,
        repairKind: "re_map",
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
