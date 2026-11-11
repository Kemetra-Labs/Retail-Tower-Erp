/**
 * RT-1325 (RT-1125 R-03) — what guards the Connector posting ack once its
 * in-flight claim is a short lease (`claimLeaseSec`) and a retry can run the
 * handler a second time, concurrently or after the first committed.
 *
 *   - a double-run `posted` ack (same document) records ONE document: one run
 *     transitions, the other echoes (row `FOR UPDATE` + terminal echo);
 *   - a double-run `posted` ack reporting another document never overwrites
 *     the first: the loser gets AckConflictError;
 *   - accepted effect (RT-1325 decision, 2026-11-11): a double-run
 *     `failed_transient` spends one more retry, nothing else.
 *
 * Drives `ErpnextPostingService.ackOutcome` directly, as posting-ack.spec does.
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../../_helpers/postgres-container";
import {
  AckConflictError,
  ErpnextPostingService,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-1325" };
const OTHER_DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-1325-B" };

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack-double-run.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

async function resetPending(): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET rejection_message = NULL, status='pending', document_ref=NULL, posted_at=NULL,
            rejection_category=NULL, retry_count=0
      WHERE id = $1`,
    [POST_A_PENDING],
  );
}

async function row(): Promise<{ status: string; document_ref: string | null; retry_count: number }> {
  const r = await env!.admin.query<{ status: string; document_ref: string | null; retry_count: number }>(
    `SELECT status, document_ref, retry_count FROM erpnext_posting_status WHERE id = $1`,
    [POST_A_PENDING],
  );
  return r.rows[0]!;
}

const posted = (documentRef: typeof DOC) => ({
  tenantId: TENANT_A,
  workItemRef: POST_A_PENDING,
  outcome: "posted" as const,
  documentRef,
});

describe("posting ack double run (RT-1325)", () => {
  beforeEach(async () => {
    if (skip) return;
    await resetPending();
  });

  it("a concurrent double-run posted ack records one ERP document: one transition, one echo", async () => {
    if (skip) return;
    const s = svc();
    const [a, b] = await Promise.all([s.ackOutcome(posted(DOC)), s.ackOutcome(posted(DOC))]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.outcome.documentRef).toEqual(DOC);
    expect(b.outcome.documentRef).toEqual(DOC);
    const stored = await row();
    expect(stored.status).toBe("posted");
    expect(JSON.parse(stored.document_ref!)).toEqual(DOC);
  });

  it("a sequential re-run of a posted ack (first run committed, never saved) echoes the same document", async () => {
    if (skip) return;
    const s = svc();
    const first = await s.ackOutcome(posted(DOC));
    const again = await s.ackOutcome(posted(DOC));
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.outcome).toEqual(first.outcome);
  });

  it("a double run reporting another document never overwrites the first: the loser gets AckConflictError", async () => {
    if (skip) return;
    const s = svc();
    const results = await Promise.allSettled([s.ackOutcome(posted(DOC)), s.ackOutcome(posted(OTHER_DOC))]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AckConflictError);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ outcome: { documentRef: unknown } }>).value;
    const stored = await row();
    expect(JSON.parse(stored.document_ref!)).toEqual(winner.outcome.documentRef);
  });

  it("accepted effect: a double-run failed_transient spends one more retry and nothing else", async () => {
    if (skip) return;
    const s = svc();
    const transient = { tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "failed_transient" as const };
    await s.ackOutcome(transient);
    await s.ackOutcome(transient);
    const stored = await row();
    expect(stored.status).toBe("pending");
    expect(stored.retry_count).toBe(2);
    expect(stored.document_ref).toBeNull();
  });
});
