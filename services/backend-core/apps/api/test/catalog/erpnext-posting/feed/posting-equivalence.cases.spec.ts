/**
 * RT-1463 — the fixed case list for the posting equivalence guard (owner request, RT-1463 comment 18315).
 *
 * Every call below goes through `test/_helpers/posting-equivalence.setup.ts`, which runs the live read and its frozen
 * pre-refactor copy on the same real client and fails on any difference. This spec seeds the cases directly, so their
 * coverage does not depend on what other specs happen to create:
 *   - a live sale_post (item map join), a sale with no item map (omitted), an unknown sale;
 *   - a void reversal, a legacy refund reversal, a reversal with an unknown source;
 *   - a frozen sale_post at resolution versions 1 and 2 (more than one resolution), with and without tracking;
 *   - the repair eligibility check on a mapped and an unmapped sale.
 * Returns, credit reversals, tenders, responsibilities and tracked lines are covered by their own real-database specs,
 * each of which asserts that the guard compared (`describePostingGuardCompared`).
 */
import type { PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { describePostingGuardCompared, postingGuardComparisons } from "../../../_helpers/posting-equivalence.assert";
import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { freezeOperatorResolution } from "../../../../src/catalog/erpnext-reconciliation/posting-resolution.writer";
import { allSaleLinesMapped } from "../../../../src/catalog/erpnext-reconciliation/sale-lines-mapped";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import {
  REFUND_A_X,
  SALE_A_X,
  SALE_A_Y,
  SALE_REFUNDED_A_X,
  SALE_VOIDED_A_X,
  VOID_A_X,
} from "../../sales/__support__/seed-sales";
import { POSTING_STATUS_FIXTURE_IDS, POST_A_PENDING, seedPostingStatusFixture } from "../__support__/seed-posting-status";

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const TPROD_AX = "01900000-0000-7000-8000-0000000a7e63";
const UNKNOWN = "01900000-0000-7000-8000-00000000dead";

let env: PgTestEnv | null = null;
let skip = false;
let client: PoolClient | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
    const a = env.admin;
    // Make the tenant-A store-X sales resolvable (their seeded lines are ad-hoc); SALE_A_Y stays unmapped.
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'RT-1463 Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [TPROD_AX, TENANT_A, ACTOR_A],
    );
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = ANY($2::uuid[])`, [
      TPROD_AX,
      [SALE_A_X, SALE_VOIDED_A_X, SALE_REFUNDED_A_X],
    ]);
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-1463', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, TPROD_AX, ACTOR_A],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-1463', $3, 1) ON CONFLICT DO NOTHING`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
    client = await a.connect();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-equivalence.cases.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  client?.release();
  if (env) await stopPgEnv(env);
}, 60_000);

function row(over: { kind?: "sale_post" | "reversal"; saleId: string; sourceRefId?: string; version?: number | null }) {
  return {
    id: POST_A_PENDING,
    kind: over.kind ?? ("sale_post" as const),
    saleId: over.saleId,
    sourceRefId: over.sourceRefId ?? over.saleId,
    sourceSystem: "fixture-pos",
    externalId: "rt-1463-case",
    payloadHash: "a".repeat(64),
    sequence: "1",
    currentResolutionVersion: over.version ?? null,
  };
}

/** Runs `fn` and asserts the guard compared exactly one more result. */
async function guarded<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const before = postingGuardComparisons();
  const out = await fn(client!);
  expect(postingGuardComparisons()).toBe(before + 1);
  return out;
}

describe("RT-1463 posting equivalence — fixed cases", () => {
  it("a live sale_post builds its work item from the confirmed item map", async () => {
    if (skip) return;
    const item = await guarded((c) => buildWorkItem(c, row({ saleId: SALE_A_X })));
    expect(item).not.toBeNull();
    expect(item!.sale.lines.length).toBeGreaterThan(0);
    expect(item!.sale.lines[0]!.erpnextItemRef).toEqual({ doctype: "Item", name: "ERP-ITEM-1463" });
  });

  it("a sale whose lines have no item map is omitted (null)", async () => {
    if (skip) return;
    expect(await guarded((c) => buildWorkItem(c, row({ saleId: SALE_A_Y })))).toBeNull();
  });

  it("an unknown sale is null", async () => {
    if (skip) return;
    expect(await guarded((c) => buildWorkItem(c, row({ saleId: UNKNOWN })))).toBeNull();
  });

  it("a void reversal carries its reversal reference", async () => {
    if (skip) return;
    const item = await guarded((c) => buildWorkItem(c, row({ kind: "reversal", saleId: SALE_VOIDED_A_X, sourceRefId: VOID_A_X })));
    expect(item?.reversalOf?.reversalKind).toBe("void");
  });

  it("a legacy refund reversal carries its reversal reference", async () => {
    if (skip) return;
    const item = await guarded((c) =>
      buildWorkItem(c, row({ kind: "reversal", saleId: SALE_REFUNDED_A_X, sourceRefId: REFUND_A_X })),
    );
    expect(item?.reversalOf?.reversalKind).toBe("refund");
  });

  it("a reversal with an unknown source is null", async () => {
    if (skip) return;
    expect(await guarded((c) => buildWorkItem(c, row({ kind: "reversal", saleId: SALE_A_X, sourceRefId: UNKNOWN })))).toBeNull();
  });

  it("a frozen sale_post reads exactly its resolution version (versions 1 and 2), with and without tracking", async () => {
    if (skip) return;
    const input = { tenantId: TENANT_A, intentId: POST_A_PENDING, kind: "sale_post" as const, saleId: SALE_A_X, storeId: STORE_A_X };
    const v1 = await freezeOperatorResolution(client!, input);
    const v2 = await freezeOperatorResolution(client!, input);
    expect([v1, v2]).toEqual([1, 2]);
    for (const version of [1, 2]) {
      const item = await guarded((c) => buildWorkItem(c, row({ saleId: SALE_A_X, version })));
      expect(item?.resolutionVersion).toBe(version);
      await guarded((c) => buildWorkItem(c, row({ saleId: SALE_A_X, version }), true));
    }
  });

  it("the repair eligibility check agrees on a mapped and an unmapped sale", async () => {
    if (skip) return;
    expect(await guarded((c) => allSaleLinesMapped(c, SALE_A_X))).toBe(true);
    expect(await guarded((c) => allSaleLinesMapped(c, SALE_A_Y))).toBe(false);
  });
});

describePostingGuardCompared();
