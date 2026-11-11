/**
 * RT-1325 (RT-1125 R-21) — one unbuildable row never fails the posting feed,
 * against a real RLS-forced Postgres through the real `ErpnextPostingService`.
 *
 * Three pending frozen `sale_post` rows in feed order: GOOD_1, BAD, GOOD_2.
 * BAD's sale records one tender (`tender_count = 1`) but has no visible
 * `sale_tenders` row, so its projection throws `SaleTendersNotVisibleError`.
 *
 *   - the pull no longer fails: GOOD_1 and GOOD_2 are offered and the cursor
 *     is GOOD_2's sequence (the page's last row, as before);
 *   - BAD is never offered without its tenders, and never skipped silently:
 *     it stays `pending`, re-headed past the cursor with retry_count + 1;
 *   - each further pull spends one retry; once POSTING_RETRY_BUDGET is spent
 *     it ends visibly as `permanently_rejected` / `retry_budget_exhausted`
 *     (the dead-letter the 017 repair re-offers);
 *   - the good items are byte-identical on every re-pull.
 *
 * Docker policy mirrors posting-feed.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { createHash } from "node:crypto";

import {
  ErpnextPostingService,
  POSTING_RETRY_BUDGET,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../../_helpers/postgres-container";
import { ACTOR_A, seedCatalogIsolationFixture, STORE_A_X, TENANT_A } from "../../__support__/isolation-harness";

const hashOf = (externalId: string): string => createHash("sha256").update(externalId).digest("hex");

const S_GOOD_1 = "0a000000-0000-7000-8000-0000013251a1";
const S_BAD = "0a000000-0000-7000-8000-0000013251a2";
const S_GOOD_2 = "0a000000-0000-7000-8000-0000013251a3";
const W_GOOD_1 = "0a000000-0000-7000-8000-0000013252a1";
const W_BAD = "0a000000-0000-7000-8000-0000013252a2";
const W_GOOD_2 = "0a000000-0000-7000-8000-0000013252a3";

let env: PgTestEnv | null = null;
let skip = false;

async function seedSale(id: string, externalId: string): Promise<string> {
  const a = env!.admin;
  await a.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-11-11T10:00:00Z', '2026-11-11', 'pos-1325', $4, $5, $6)`,
    [id, TENANT_A, STORE_A_X, externalId, hashOf(externalId), ACTOR_A],
  );
  const line = await a.query<{ id: string }>(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 10, 'EGP', 1, 10, 'ea') RETURNING id`,
    [id, TENANT_A, STORE_A_X],
  );
  return line.rows[0]!.id;
}

async function seedFrozenPosting(id: string, saleId: string, externalId: string, lineId: string): Promise<void> {
  const a = env!.admin;
  await a.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status)
     VALUES ($1, $2, $3, $4, 'sale_post', $4, 'pos-1325', $5, $6, 'pending')`,
    [id, TENANT_A, STORE_A_X, saleId, externalId, hashOf(externalId)],
  );
  await a.query(
    `INSERT INTO erpnext_posting_resolution
       (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id,
        warehouse_ref, warehouse_map_id, resolved_by)
     VALUES ($1, $2, 1, $3, 'ERP-ITEM-1325', gen_random_uuid(), 'ERP-WH-1325', gen_random_uuid(), 'system')`,
    [TENANT_A, id, lineId],
  );
  await a.query(`UPDATE erpnext_posting_status SET current_resolution_version = 1 WHERE id = $1`, [id]);
}

async function rowOf(id: string): Promise<{
  status: string;
  retry_count: number;
  sequence: string;
  rejection_category: string | null;
}> {
  const r = await env!.admin.query<{ status: string; retry_count: number; sequence: string; rejection_category: string | null }>(
    `SELECT status, retry_count, sequence::text AS sequence, rejection_category
       FROM erpnext_posting_status WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    const l1 = await seedSale(S_GOOD_1, "rt1325-good-1");
    const lb = await seedSale(S_BAD, "rt1325-bad");
    const l2 = await seedSale(S_GOOD_2, "rt1325-good-2");
    // One tender recorded, none visible: the projection's fail-closed guard throws.
    await env.admin.query(`UPDATE sales SET tender_count = 1 WHERE id = $1`, [S_BAD]);
    await seedFrozenPosting(W_GOOD_1, S_GOOD_1, "rt1325-good-1", l1);
    await seedFrozenPosting(W_BAD, S_BAD, "rt1325-bad", lb);
    await seedFrozenPosting(W_GOOD_2, S_GOOD_2, "rt1325-good-2", l2);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-row-isolation.spec] Docker unavailable: ${String(err)}`);
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

describe("posting feed row isolation (RT-1325, RT-1125 R-21)", () => {
  it("offers the good rows, leaves the bad one out, and re-offers it past the cursor", async () => {
    if (skip) return;
    const before = await rowOf(W_BAD);
    const good2Seq = (await rowOf(W_GOOD_2)).sequence;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(page.items.map((i) => i.workItemRef)).toEqual([W_GOOD_1, W_GOOD_2]);
    expect(page.cursor).toBe(good2Seq);

    const after = await rowOf(W_BAD);
    expect(after.status).toBe("pending");
    expect(after.retry_count).toBe(before.retry_count + 1);
    expect(BigInt(after.sequence)).toBeGreaterThan(BigInt(good2Seq));
  });

  it("every further pull spends one retry, then dead-letters it as retry_budget_exhausted; the good items never change", async () => {
    if (skip) return;
    const s = svc();
    const baseline = (await s.pullPostings({ tenantId: TENANT_A, since: null, limit: 100 })).items;
    expect(baseline.map((i) => i.workItemRef)).toEqual([W_GOOD_1, W_GOOD_2]);

    // The previous test spent one retry and this baseline pull another.
    for (let pulls = 0; pulls < POSTING_RETRY_BUDGET + 2; pulls += 1) {
      const row = await rowOf(W_BAD);
      if (row.status !== "pending") break;
      const page = await s.pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
      expect(page.items).toEqual(baseline);
    }

    const end = await rowOf(W_BAD);
    expect(end.status).toBe("permanently_rejected");
    expect(end.rejection_category).toBe("retry_budget_exhausted");
    expect(end.retry_count).toBe(POSTING_RETRY_BUDGET);

    const settled = await s.pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(settled.items).toEqual(baseline);
  });
});
