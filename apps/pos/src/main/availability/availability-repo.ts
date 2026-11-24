/**
 * RT-1578 (RT-1511 S3) — the local availability cache (`availability_state` and `availability_item`,
 * migration 0072). The scope key ties the rows to one pairing; `replaceAll` swaps the whole snapshot in
 * one transaction, so a failed refresh can never leave a half-written cache. Read-only toward the server.
 */

import type { DatabaseHandle } from '../db/client.js';
import type { WireAvailabilityItem, WireBand } from './availability-client.js';

interface AvailabilityStateRow {
  readonly scope_key: string;
  readonly oldest_as_of: string;
}

interface AvailabilitySnapshot {
  readonly scopeKey: string;
  readonly oldestAsOf: string;
  readonly refreshedAt: string;
  readonly items: readonly WireAvailabilityItem[];
}

export interface AvailabilityRepo {
  readState(): AvailabilityStateRow | null;
  /** The band of each product the cache holds a record for (others are absent). */
  readBands(productIds: readonly string[]): ReadonlyMap<string, WireBand>;
  replaceAll(snapshot: AvailabilitySnapshot): void;
  purge(): void;
}

interface Statement<Row> {
  get(...params: unknown[]): Row | undefined;
  run(...params: unknown[]): unknown;
}

export function createAvailabilityRepo(db: DatabaseHandle): AvailabilityRepo {
  const stmt = <Row>(sql: string): Statement<Row> => db.prepare(sql) as Statement<Row>;

  // Built per call, so wiring this repo never needs a transaction-capable handle until a write happens.
  const replace = (snapshot: AvailabilitySnapshot): void => {
    db.transaction(() => {
      stmt('DELETE FROM availability_item').run();
      stmt('DELETE FROM availability_state').run();
      const insert = stmt(
        'INSERT OR REPLACE INTO availability_item (product_id, band, available_to_sell) VALUES (?, ?, ?)',
      );
      for (const item of snapshot.items) {
        insert.run(item.productId, item.band, item.availableToSell);
      }
      stmt(
        'INSERT INTO availability_state (id, scope_key, oldest_as_of, refreshed_at) VALUES (1, ?, ?, ?)',
      ).run(snapshot.scopeKey, snapshot.oldestAsOf, snapshot.refreshedAt);
    })();
  };

  const purge = (): void => {
    db.transaction(() => {
      stmt('DELETE FROM availability_item').run();
      stmt('DELETE FROM availability_state').run();
    })();
  };

  return {
    readState: () =>
      stmt<AvailabilityStateRow>(
        'SELECT scope_key, oldest_as_of FROM availability_state WHERE id = 1',
      ).get() ?? null,
    readBands(productIds) {
      const bands = new Map<string, WireBand>();
      const select = stmt<{ band: WireBand }>(
        'SELECT band FROM availability_item WHERE product_id = ?',
      );
      for (const id of productIds) {
        const row = select.get(id);
        if (row !== undefined) bands.set(id, row.band);
      }
      return bands;
    },
    replaceAll: (snapshot) => {
      replace(snapshot);
    },
    purge: () => {
      purge();
    },
  };
}
