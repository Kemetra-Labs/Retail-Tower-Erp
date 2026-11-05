/**
 * RT-1225 — characterization of `UnknownItemsService.captureItem`'s exact
 * statement sequence (Docker-free).
 *
 * Pins, against a recording fake pool, the SQL text (whitespace-normalised),
 * the parameter order and the RLS GUC order for the three outcomes:
 * alias hit, duplicate-pending (FR-032) and fresh INSERT. It exists so the
 * RT-1225 extraction of `findPendingDuplicate` / `insertPendingUnknownItem`
 * / `toUnknownItemDto` can be proven behaviour-preserving without Postgres.
 * The Testcontainers specs next to it keep covering real RLS behaviour.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";

const TENANT = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();

const PENDING_ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  tenant_id: TENANT,
  store_id: STORE,
  identifier_type: "barcode",
  value: "6221234567890",
  source_system: null,
  resolution_status: "pending" as const,
  resolution_action: null,
  resolved_at: null,
  resolved_by: null,
  resolved_product_id: null,
  encountered_at: new Date("2026-11-01T10:00:00.000Z"),
  sale_context: { line: 3 },
};

function fakePool(responders: {
  alias?: unknown[];
  dedup?: unknown[];
  insert?: unknown[];
}): { pool: Pool; log: Recorded[] } {
  const log: Recorded[] = [];
  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      log.push({ sql: norm(sql), params });
      const s = norm(sql);
      if (s.startsWith("SELECT id, product_id FROM product_aliases")) {
        return { rows: responders.alias ?? [] };
      }
      if (s.includes("FROM unknown_items") && s.startsWith("SELECT id")) {
        return { rows: responders.dedup ?? [] };
      }
      if (s.startsWith("INSERT INTO unknown_items")) {
        return { rows: responders.insert ?? [] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, log };
}

const INPUT = {
  tenantId: TENANT,
  storeId: STORE,
  actorUserId: ACTOR,
  correlationId: "corr-1",
  identifierType: "barcode" as const,
  identifierValue: "6221234567890",
  sourceSystem: null,
  saleContext: { line: 3 },
};

/** Statements issued by `captureItem` itself, after the tenant-context prelude. */
function afterContext(log: Recorded[]): Recorded[] {
  const i = log.findIndex((r) => r.sql.includes("product_aliases"));
  expect(i).toBeGreaterThan(0);
  return log.slice(i);
}

const ALIAS_SQL =
  "SELECT id, product_id FROM product_aliases WHERE tenant_id = $1 AND identifier_type = $2 AND value = $3 AND retired_at IS NULL AND (store_id IS NULL OR store_id = $4) ORDER BY (store_id IS NULL) ASC, created_at DESC LIMIT 1";
const DEDUP_SQL =
  "SELECT id, tenant_id, store_id, identifier_type, value, source_system, resolution_status, resolution_action, resolved_at, resolved_by, resolved_product_id, encountered_at, sale_context FROM unknown_items WHERE tenant_id = $1 AND store_id = $2 AND identifier_type = $3 AND value = $4 AND source_system IS NOT DISTINCT FROM $5 AND resolution_status = 'pending' ORDER BY encountered_at ASC LIMIT 1";
const INSERT_SQL =
  "INSERT INTO unknown_items (id, tenant_id, store_id, identifier_type, value, source_system, resolution_status, sale_context, correlation_id) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING id, tenant_id, store_id, identifier_type, value, source_system, resolution_status, resolution_action, resolved_at, resolved_by, resolved_product_id, encountered_at, sale_context";
const STORE_GUC_SQL = "SELECT set_config('app.current_store', $1, true)";

const DTO = {
  id: PENDING_ROW.id,
  tenantId: TENANT,
  storeId: STORE,
  identifierType: "barcode",
  identifierValue: "6221234567890",
  sourceSystem: null,
  resolutionStatus: "pending",
  resolutionAction: null,
  resolvedAt: null,
  resolvedBy: null,
  resolvedProductId: null,
  encounteredAt: PENDING_ROW.encountered_at,
  saleContext: { line: 3 },
};

describe("UnknownItemsService.captureItem — statement sequence (RT-1225)", () => {
  it("duplicate-pending: alias miss, store GUC, dedup SELECT, NO insert, row returned unchanged", async () => {
    const { pool, log } = fakePool({ dedup: [PENDING_ROW] });
    const svc = new UnknownItemsService(pool);

    const out = await svc.captureItem(INPUT);

    expect(afterContext(log)).toEqual([
      { sql: ALIAS_SQL, params: [TENANT, "barcode", "6221234567890", STORE] },
      { sql: STORE_GUC_SQL, params: [STORE] },
      {
        sql: DEDUP_SQL,
        params: [TENANT, STORE, "barcode", "6221234567890", null],
      },
      { sql: "COMMIT", params: [] },
    ]);
    expect(out).toEqual({ kind: "unknown", unknownItem: DTO });
  });

  it("duplicate-pending for external_pos_id passes source_system through to the dedup predicate", async () => {
    const row = {
      ...PENDING_ROW,
      identifier_type: "external_pos_id",
      source_system: "pos-a",
    };
    const { pool, log } = fakePool({ dedup: [row] });
    const svc = new UnknownItemsService(pool);

    const out = await svc.captureItem({
      ...INPUT,
      identifierType: "external_pos_id",
      sourceSystem: "pos-a",
    });

    const dedup = afterContext(log).find((r) => r.sql === DEDUP_SQL);
    expect(dedup?.params).toEqual([
      TENANT,
      STORE,
      "external_pos_id",
      "6221234567890",
      "pos-a",
    ]);
    expect(out).toMatchObject({
      kind: "unknown",
      unknownItem: { sourceSystem: "pos-a", identifierType: "external_pos_id" },
    });
  });

  it("fresh capture: alias miss, store GUC, dedup miss, INSERT with generated id", async () => {
    const { pool, log } = fakePool({ insert: [PENDING_ROW] });
    const svc = new UnknownItemsService(pool);

    const out = await svc.captureItem(INPUT);

    const seq = afterContext(log);
    expect(seq.map((r) => r.sql)).toEqual([
      ALIAS_SQL,
      STORE_GUC_SQL,
      DEDUP_SQL,
      INSERT_SQL,
      "COMMIT",
    ]);
    const insert = seq[3]!;
    expect(insert.params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(insert.params.slice(1)).toEqual([
      TENANT,
      STORE,
      "barcode",
      "6221234567890",
      null,
      { line: 3 },
      "corr-1",
    ]);
    expect(out).toEqual({ kind: "unknown", unknownItem: DTO });
  });

  it("alias hit: resolves without touching unknown_items or the store GUC", async () => {
    const { pool, log } = fakePool({
      alias: [{ id: "alias-1", product_id: "prod-1" }],
    });
    const svc = new UnknownItemsService(pool);

    const out = await svc.captureItem(INPUT);

    expect(afterContext(log).map((r) => r.sql)).toEqual([ALIAS_SQL, "COMMIT"]);
    expect(out).toEqual({
      kind: "resolved",
      productId: "prod-1",
      aliasId: "alias-1",
    });
  });

  it("insert returning no row throws the guard error", async () => {
    const { pool } = fakePool({ insert: [] });
    const svc = new UnknownItemsService(pool);
    await expect(svc.captureItem(INPUT)).rejects.toThrow(
      "unknown_items: insert produced no row",
    );
  });
});
