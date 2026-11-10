/**
 * RT-1312 F19 (RT447-F05) — a snapshot continuation reuses the head pinned on page 1.
 *
 * Before the fix, the controller passed only `page_token`, and the service re-read the
 * change-log head (`max(sequence)`) on every page. A catalog edit during a multi-page walk then
 * changed the cursor, and the POS rejected the whole refresh (read-down-client.ts cursor-drift
 * rule). The page token now carries the pinned head, so a continuation never re-reads it.
 * The database end-to-end proof is in snapshot.spec.ts (T033 + RT-1312 F19).
 */
import type { Pool, PoolClient } from "pg";

import { decodeCursor } from "../../../../src/catalog/read-down/read-down.cursor";
import { ReadDownService } from "../../../../src/catalog/read-down/read-down.service";
import { encodeOpaque } from "../../../../src/common/cursor/opaque-cursor";

const TENANT = "0a000000-0000-7000-8000-000013120001";
const STORE = "0a000000-0000-7000-8000-000013120002";
const AFTER = "0a000000-0000-7000-8000-000013120003";

/** A pool whose client answers the head query with `head` and every other read with no rows. */
function fakePool(head: string): { pool: Pool; headReads: () => number } {
  let headReads = 0;
  const client = {
    query: async (sql: string) => {
      if (/max\(sequence\)/i.test(sql)) {
        headReads += 1;
        return { rows: [{ head }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, headReads: () => headReads };
}

describe("RT-1312 F19 snapshot cursor pinned across pages", () => {
  it("a continuation page uses the head pinned in its page token, not the current head", async () => {
    const { pool, headReads } = fakePool("999");
    const service = new ReadDownService(pool);
    const pageToken = encodeOpaque({ t: TENANT, s: STORE, a: AFTER, q: "5" });

    const page = await service.getSnapshot(TENANT, STORE, { pageToken });

    expect(decodeCursor(page.cursor, TENANT, STORE).sequence).toBe("5");
    expect(headReads()).toBe(0);
  });

  it("a page token without a pinned head (issued before the fix) still continues at the current head", async () => {
    const { pool } = fakePool("999");
    const service = new ReadDownService(pool);
    const legacyToken = encodeOpaque({ t: TENANT, s: STORE, a: AFTER });

    const page = await service.getSnapshot(TENANT, STORE, { pageToken: legacyToken });

    expect(decodeCursor(page.cursor, TENANT, STORE).sequence).toBe("999");
  });
});
