/**
 * RT-1463 — the single-snapshot posting statements keep their exact SQL text through the catalog split.
 *
 * The owner chose a sales SQL fragment port for the two statements that must stay one statement (RT-1463 comment
 * 18321): the feed page query and the operator resolution freeze. Re-composing them from fragments must leave the text
 * Postgres receives unchanged, byte for byte, so behaviour cannot change. The frozen texts are in
 * `__support__/legacy/frozen-sql.ts` (origin/main da17c0d3). Docker-free: a recording client stands in for Postgres.
 */
import type { PoolClient } from "pg";

import { POSTING_FEED_PAGE_SQL } from "../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { freezeOperatorResolution } from "../../../src/catalog/erpnext-reconciliation/posting-resolution.writer";
import {
  FROZEN_FREEZE_REVERSAL_SQL,
  FROZEN_FREEZE_SALE_SQL,
  FROZEN_POSTING_FEED_PAGE_SQL,
} from "./__support__/legacy/frozen-sql";

/** Records every statement; answers the next-version read with 1 and every write with 0 rows (so all branches run). */
function recorder(): { client: PoolClient; sql: string[] } {
  const sql: string[] = [];
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (text.includes("MAX(resolution_version)")) return { rows: [{ v: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { client, sql };
}

const INPUT = { tenantId: "t", intentId: "i", saleId: "s", storeId: "st" } as const;

describe("RT-1463 posting SQL is unchanged by the catalog split", () => {
  it("the feed page query is byte-identical to the frozen text", () => {
    expect(POSTING_FEED_PAGE_SQL).toBe(FROZEN_POSTING_FEED_PAGE_SQL);
  });

  it("the operator resolution freeze of a reversal sends exactly the frozen statements", async () => {
    const r = recorder();
    await freezeOperatorResolution(r.client, { ...INPUT, kind: "reversal" });
    expect(r.sql).toEqual(FROZEN_FREEZE_REVERSAL_SQL);
  });

  it("the operator resolution freeze of a sale_post sends exactly the frozen statements", async () => {
    const r = recorder();
    await freezeOperatorResolution(r.client, { ...INPUT, kind: "sale_post" });
    expect(r.sql).toEqual(FROZEN_FREEZE_SALE_SQL);
  });
});
