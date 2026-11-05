/**
 * RT-1214 — golden vectors for the settlement-intent request hash.
 *
 * `idempotency_keys.request_hash` for a settlement intent is compared
 * byte-for-byte on retry, so the serializer behind it must never drift. The
 * fingerprint is captured from the reservation INSERT (the serializer is not
 * called directly), so these vectors pin the stored bytes whichever function
 * produces them. Vectors live in `_helpers/canonical-json-golden.ts`.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";

import { ReceivableService } from "../../../src/settlement/receivable.service";
import {
  RECEIVABLE_INTENT_VECTORS,
  type ReceivableIntentVector,
} from "../../_helpers/canonical-json-golden";

class FingerprintCaptured extends Error {}

function empty(): QueryResult {
  return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as QueryResult;
}

async function storedFingerprint(vector: ReceivableIntentVector): Promise<string | null> {
  let captured: Buffer | null = null;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config")) return empty();
    if (sql.includes("INSERT INTO idempotency_keys")) {
      captured = params?.[5] as Buffer;
      throw new FingerprintCaptured("fingerprint captured");
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  await expect(
    new ReceivableService(pool).openFromIntent({
      tenantId: "71000000-0000-4000-8000-000000000001",
      storeId: "71000000-0000-4000-8000-000000000002",
      operation: {
        idempotencyKey: "settlement-golden-key",
        terminalId: "settlement-golden-terminal",
        actorUserId: "71000000-0000-4000-8000-000000000003",
        requestId: null,
      },
      saleRef: vector.saleRef,
      payers: vector.payers,
    }),
  ).rejects.toThrow(FingerprintCaptured);
  return (captured as Buffer | null)?.toString("hex") ?? null;
}

describe("settlement intent request-hash golden vectors (RT-1214)", () => {
  it.each(RECEIVABLE_INTENT_VECTORS.map((v) => [v.name, v] as const))(
    "%s: literal hashes to its pinned sha256",
    (_name, vector) => {
      expect(createHash("sha256").update(vector.canonical).digest("hex")).toBe(vector.sha256Hex);
    },
  );

  it.each(RECEIVABLE_INTENT_VECTORS.map((v) => [v.name, v] as const))(
    "%s: stores the pinned request_hash",
    async (_name, vector) => {
      expect(await storedFingerprint(vector)).toBe(vector.sha256Hex);
    },
  );
});
