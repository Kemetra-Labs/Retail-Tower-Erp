/**
 * RT-1221 PR 2 — characterization of the transfer, count and restock-backfill
 * write paths of InventoryService, written BEFORE they were split into
 * StockTransferService / StockCountService / InventoryBackfill.
 *
 * The split must not change the SQL text, the RLS GUC order, the transaction
 * boundaries, the outbox emission, the response shapes or the stock effects.
 * Each scenario therefore snapshots:
 *   - `sql`:   every statement the service sent on its pooled client, in order
 *              (BEGIN, the two set_config GUCs, the work, COMMIT/ROLLBACK),
 *              whitespace-collapsed, with params;
 *   - `rows`:  the stock_movements, inventory_effect_integration, audit_events,
 *              outbox_events and stock_counts rows the call added;
 *   - `body` / `error`: the response, or the error class, status and message.
 * Freshly generated ids (and server clocks) are replaced with stable
 * placeholders in order of first appearance; fixture ids stay literal.
 *
 * Scenarios run in declaration order on one database, so each sees the
 * on-hand left by the previous ones; the snapshot is deterministic for that
 * order. NOT Docker-optional: like the other inventory harnesses it fails
 * when no Postgres is reachable unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import type { Pool, PoolClient } from 'pg';

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';
import { VOID_A_X, seedSalesFixture } from '../../catalog/sales/__support__/seed-sales';
import { INVENTORY_FIXTURE_IDS, seedInventoryFixture } from '../__support__/seed-inventory';
import { InventoryService } from '../../../src/inventory/inventory.service';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g;

const FIXTURE_NAMES: Record<string, string> = {
  [TENANT_A]: 'TENANT_A',
  [STORE_A_X]: 'STORE_A_X',
  [STORE_A_Y]: 'STORE_A_Y',
  [STORE_B_X]: 'STORE_B_X',
  [ACTOR_A]: 'ACTOR_A',
  [PRODUCT_A_ACTIVE]: 'PRODUCT_A_ACTIVE',
  [VOID_A_X]: 'VOID_A_X',
};

/** Replaces generated ids/timestamps with stable placeholders per scenario. */
class Normalizer {
  private readonly ids = new Map<string, string>();
  constructor(private readonly locations: Record<string, string>) {}

  private id(raw: string): string {
    const key = raw.toLowerCase();
    const named = FIXTURE_NAMES[key] ?? this.locations[key];
    if (named) return named;
    let p = this.ids.get(key);
    if (!p) {
      p = `<id${this.ids.size + 1}>`;
      this.ids.set(key, p);
    }
    return p;
  }

  str(s: string): string {
    return s.replace(UUID_RE, (m) => this.id(m)).replace(TS_RE, '<ts>');
  }

  value(v: unknown): unknown {
    if (typeof v === 'string') return this.str(v);
    if (v instanceof Date) return '<ts>';
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, this.value(x)]),
      );
    }
    return v;
  }
}

interface LoggedQuery {
  readonly text: string;
  readonly params: unknown[] | undefined;
}

/** A Pool stand-in that records every statement sent on its clients. */
function recordingPool(real: Pool, log: LoggedQuery[]): Pool {
  return {
    connect: async (): Promise<PoolClient> => {
      const client = await real.connect();
      return new Proxy(client, {
        get(target, prop, receiver): unknown {
          if (prop === 'query') {
            return (text: unknown, params?: unknown[]) => {
              const sql = typeof text === 'string' ? text : (text as { text: string }).text;
              log.push({ text: sql.replace(/\s+/g, ' ').trim(), params });
              return (target.query as (...a: unknown[]) => unknown).call(target, text, params);
            };
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
  } as unknown as Pool;
}

let env: PgTestEnv | null = null;
let skipped = false;
let locationNames: Record<string, string> = {};
const log: LoggedQuery[] = [];
let service: InventoryService;
const seen = { movements: new Set<string>(), audits: new Set<string>(), outbox: new Set<string>(), counts: new Set<string>() };

async function ids(table: string, col: string): Promise<string[]> {
  const r = await env!.admin.query<{ id: string }>(`SELECT ${col}::text AS id FROM ${table}`);
  return r.rows.map((x) => x.id);
}

async function markSeen(): Promise<void> {
  for (const id of await ids('stock_movements', 'id')) seen.movements.add(id);
  for (const id of await ids('audit_events', 'id')) seen.audits.add(id);
  for (const id of await ids('outbox_events', 'event_id')) seen.outbox.add(id);
  for (const id of await ids('stock_counts', 'id')) seen.counts.add(id);
}

/** Rows added since the last call, in a stable order. */
async function newRows(): Promise<Record<string, unknown[]>> {
  const admin = env!.admin;
  const movements = (
    await admin.query(
      `SELECT id, tenant_id, store_id, movement_type, quantity::text AS quantity, stocking_unit,
              tenant_product_ref, reason, transfer_group_id, stock_count_id, source_system,
              external_id, sale_id, sale_line_id, terminal_event_ref, created_by, event_type,
              event_ref_id, stock_location_id, inventory_status,
              (occurred_at IS NOT NULL) AS has_occurred_at
         FROM stock_movements ORDER BY movement_type, store_id, id`,
    )
  ).rows.filter((r: { id: string }) => !seen.movements.has(r.id));
  const movementIds = movements.map((m: { id: string }) => m.id);
  const integration = (
    await admin.query(
      `SELECT effect_id, tenant_id, state, posting_status_id, erp_document_ref, state_reason
         FROM inventory_effect_integration WHERE effect_id = ANY($1::uuid[])
        ORDER BY effect_id`,
      [movementIds],
    )
  ).rows;
  const audits = (
    await admin.query(
      `SELECT id, actor_user_id, tenant_id, action, target_type, target_id, metadata
         FROM audit_events ORDER BY action, id`,
    )
  ).rows.filter((r: { id: string }) => !seen.audits.has(r.id));
  const outbox = (
    await admin.query(
      `SELECT event_id, tenant_id, store_id, event_type, payload, delivery_state, attempts,
              correlation_id
         FROM outbox_events ORDER BY event_type, event_id`,
    )
  ).rows.filter((r: { event_id: string }) => !seen.outbox.has(r.event_id));
  const counts = (
    await admin.query(
      `SELECT id, tenant_id, store_id, tenant_product_ref, counted_quantity::text AS counted_quantity,
              derived_on_hand_at_count::text AS derived_on_hand_at_count, stocking_unit,
              created_by, (counted_at IS NOT NULL) AS has_counted_at
         FROM stock_counts ORDER BY id`,
    )
  ).rows.filter((r: { id: string }) => !seen.counts.has(r.id));
  await markSeen();
  return { stock_movements: movements, inventory_effect_integration: integration, audit_events: audits, outbox_events: outbox, stock_counts: counts };
}

/**
 * Run one service call and return its normalized observable footprint.
 * Generated ids are ordered by their first appearance in the SQL log, so the
 * placeholders follow the statement order (not the random id values).
 */
async function observe(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  log.length = 0;
  let body: unknown;
  let error: unknown;
  try {
    body = await call();
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string; getStatus?: () => number };
    error = {
      class: (err as object).constructor.name,
      status: typeof e.getStatus === 'function' ? e.getStatus() : null,
      message: e.message,
    };
  }
  const n = new Normalizer(locationNames);
  const sql = log.map((q) => ({ text: n.str(q.text), params: n.value(q.params ?? []) }));
  const rows = n.value(await newRows());
  return {
    sql,
    rows,
    ...(error === undefined ? { body: n.value(body) } : { error: n.value(error) }),
  };
}

async function onHand(storeId: string): Promise<string> {
  const r = await service.getOnHand({ tenantId: TENANT_A, storeId, productId: PRODUCT_A_ACTIVE });
  return r.quantity;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      skipped = true;
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedSalesFixture(env);
  await seedInventoryFixture(env);
  const locs = await env.admin.query<{ id: string; store_id: string; kind: string }>(
    `SELECT id::text AS id, store_id::text AS store_id, kind FROM stock_locations`,
  );
  locationNames = Object.fromEntries(
    locs.rows.map((l) => [l.id, `LOC(${FIXTURE_NAMES[l.store_id] ?? 'other'}:${l.kind})`]),
  );
  expect(INVENTORY_FIXTURE_IDS).toBeDefined();
  await markSeen();
  service = new InventoryService(recordingPool(env.app as unknown as Pool, log));
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const transfer = (o: Record<string, unknown> = {}): Parameters<InventoryService['createStockTransfer']>[0] =>
  ({
    tenantId: TENANT_A,
    userId: ACTOR_A,
    sourceStoreId: STORE_A_X,
    destinationStoreId: STORE_A_Y,
    tenantProductRef: PRODUCT_A_ACTIVE,
    quantity: '3.0000',
    stockingUnit: 'ea',
    reason: '  rebalance  ',
    ...o,
  }) as never;

const count = (o: Record<string, unknown> = {}): Parameters<InventoryService['recordStockCount']>[0] =>
  ({
    tenantId: TENANT_A,
    userId: ACTOR_A,
    storeId: STORE_A_X,
    tenantProductRef: PRODUCT_A_ACTIVE,
    countedQuantity: '20.0000',
    stockingUnit: 'ea',
    countedAt: '2026-01-02T03:04:05.000Z',
    ...o,
  }) as never;

const restock = (o: Record<string, unknown> = {}): Parameters<InventoryService['backfillRestockInbound']>[0] =>
  ({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    userId: ACTOR_A,
    sourceSystem: ' pos-restock ',
    externalId: ' char-restock-1 ',
    movementType: 'inbound',
    quantity: '2.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
    terminalEventRef: VOID_A_X,
    reason: 'void restock',
    occurredAt: '2026-01-02T03:04:05.000Z',
    correlationId: '0a000000-0000-7000-8000-0000c0441001',
    ...o,
  }) as never;

describe('RT-1221 characterization — transfer', () => {
  it('a transfer appends linked transfer_out/transfer_in legs, audit, outbox, not_posted', async () => {
    if (skipped) return;
    expect(await observe(() => service.createStockTransfer(transfer()))).toMatchSnapshot();
    expect(await onHand(STORE_A_X)).toMatchSnapshot('on-hand A.X after transfer');
    expect(await onHand(STORE_A_Y)).toMatchSnapshot('on-hand A.Y after transfer');
  });

  it('a transfer that drives the source negative is still recorded (allow-and-flag)', async () => {
    if (skipped) return;
    expect(
      await observe(() => service.createStockTransfer(transfer({ quantity: '50', reason: null }))),
    ).toMatchSnapshot();
    expect(await onHand(STORE_A_X)).toMatchSnapshot('on-hand A.X after negative transfer');
  });

  it.each([
    ['same source and destination', { destinationStoreId: STORE_A_X }],
    ['zero quantity', { quantity: '0' }],
    ['negative quantity', { quantity: '-1' }],
    ['blank stocking unit', { stockingUnit: '  ' }],
    ['cross-tenant destination', { destinationStoreId: STORE_B_X }],
    ['cross-unit at the source', { stockingUnit: 'kg' }],
  ])('rejects: %s', async (_name, o) => {
    if (skipped) return;
    expect(await observe(() => service.createStockTransfer(transfer(o)))).toMatchSnapshot();
  });
});

describe('RT-1221 characterization — count', () => {
  it('a count with variance records the count and a linked count_correction', async () => {
    if (skipped) return;
    expect(await observe(() => service.recordStockCount(count()))).toMatchSnapshot();
    expect(await onHand(STORE_A_X)).toMatchSnapshot('on-hand A.X after count');
  });

  it('a zero-variance count records the count, no correction, no outbox', async () => {
    if (skipped) return;
    expect(
      await observe(() => service.recordStockCount(count({ countedAt: undefined }))),
    ).toMatchSnapshot();
  });

  it('a count below on-hand appends a negative correction', async () => {
    if (skipped) return;
    expect(
      await observe(() => service.recordStockCount(count({ countedQuantity: '4.5' }))),
    ).toMatchSnapshot();
    expect(await onHand(STORE_A_X)).toMatchSnapshot('on-hand A.X after negative count');
  });

  it.each([
    ['negative counted quantity', { countedQuantity: '-1' }],
    ['blank stocking unit', { stockingUnit: '' }],
    ['cross-tenant store', { storeId: STORE_B_X }],
    ['cross-unit', { stockingUnit: 'kg' }],
  ])('rejects: %s', async (_name, o) => {
    if (skipped) return;
    expect(await observe(() => service.recordStockCount(count(o)))).toMatchSnapshot();
  });
});

describe('RT-1221 characterization — restock backfill', () => {
  it('a first restock appends an inbound with provenance, audit and outbox', async () => {
    if (skipped) return;
    expect(await observe(() => service.backfillRestockInbound(restock()))).toMatchSnapshot();
  });

  it('a redelivered restock returns the existing movement with no new rows', async () => {
    if (skipped) return;
    expect(await observe(() => service.backfillRestockInbound(restock()))).toMatchSnapshot();
  });

  it('a non-UUID correlation id is audited but not forwarded to the outbox', async () => {
    if (skipped) return;
    expect(
      await observe(() =>
        service.backfillRestockInbound(
          restock({
            externalId: 'char-restock-2',
            correlationId: 'not-a-uuid',
            terminalEventRef: undefined,
            reason: '   ',
            occurredAt: undefined,
          }),
        ),
      ),
    ).toMatchSnapshot();
  });

  it('an ad-hoc (no product) restock skips the unit check', async () => {
    if (skipped) return;
    expect(
      await observe(() =>
        service.backfillRestockInbound(
          restock({ externalId: 'char-restock-3', tenantProductRef: null, stockingUnit: 'box' }),
        ),
      ),
    ).toMatchSnapshot();
    expect(await onHand(STORE_A_X)).toMatchSnapshot('on-hand A.X after restocks');
  });

  it.each([
    ['outbound movement type', { movementType: 'outbound' }],
    ['zero quantity', { quantity: '0.00001' }],
    ['negative quantity', { quantity: '-2' }],
    ['blank provenance', { externalId: '  ' }],
    ['blank stocking unit', { externalId: 'char-restock-4', stockingUnit: ' ' }],
    ['cross-unit', { externalId: 'char-restock-5', stockingUnit: 'kg' }],
  ])('rejects: %s', async (_name, o) => {
    if (skipped) return;
    expect(await observe(() => service.backfillRestockInbound(restock(o)))).toMatchSnapshot();
  });
});
