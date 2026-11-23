/**
 * RT-1577 (RT-1511 S2) — the POS store-availability snapshot, `posGetStoreAvailability`.
 * Contract: `packages/contracts/openapi/inventory/pos-availability.yaml`. Rules: the RT-1511 decision record (Confluence
 * 91389953), A-1 to A-10 and the band of section 3.
 *
 * One page = the store's next `limit` products (the catalogue read-down's sellable set, asked of the catalog's port), the
 * Available-to-Sell facts of those products in one statement (`availability.snapshot.query.ts`) and the pure composition
 * of `availability.rules.ts`, the same one `OnHand.availability` uses. Everything runs on one tenant-scoped client, so RLS
 * is active; the store is the device's, never the request's. Compute-on-read: no stored projection, no new table.
 *
 * Paging is keyset by product id and stable: the walk continues after the last product scanned, so a product added or
 * retired mid-walk never repeats or hides another. Each page carries its own `asOf`; the till keeps the oldest one of a
 * refresh as its freshness.
 */
import { Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool } from 'pg';

import { readStoreSellablePage } from '../../catalog';
import { PG_POOL } from '../../database';
import { composeStoreAvailabilityItem, type StoreAvailabilityItem } from './availability.rules';
import { readAvailabilityFactsOfPage } from './availability.snapshot.query';
import { decodeAvailabilityCursor, encodeAvailabilityCursor } from './pos-availability.cursor';

/** Default page size (contract `Limit`: 1..1000, default 500; the controller bounds `limit`). */
const DEFAULT_LIMIT = 500;

/** Contract `StoreAvailabilityPage`. */
export interface StoreAvailabilityPage {
  readonly storeId: string;
  readonly asOf: string;
  readonly items: readonly StoreAvailabilityItem[];
  readonly nextCursor: string | null;
}

@Injectable()
export class PosAvailabilityService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** One page of the snapshot for the device's (tenant, store); `cursor` is the previous page's `nextCursor`. */
  getSnapshot(
    tenantId: string,
    storeId: string,
    opts: { readonly limit?: number | undefined; readonly cursor?: string | null | undefined } = {},
  ): Promise<StoreAvailabilityPage> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    // Decoded before any read: a foreign or malformed cursor reaches no data.
    const afterProductId = opts.cursor ? decodeAvailabilityCursor(opts.cursor, tenantId, storeId) : null;
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<StoreAvailabilityPage> => {
        const page = await readStoreSellablePage(client, { tenantId, storeId, afterProductId, limit });
        const facts = await readAvailabilityFactsOfPage(client, {
          storeId,
          productIds: page.items.map((item) => item.productId),
        });
        const items = page.items.map((product) =>
          composeStoreAvailabilityItem(
            product.productId,
            // Every requested product has a row (a product with no movement reads zero).
            facts.byProduct.get(product.productId) ?? ZERO_FACTS,
            product.lowStockLevel,
          ),
        );
        return {
          storeId,
          asOf: facts.asOf.toISOString(),
          items,
          nextCursor:
            page.hasMore && page.lastScannedProductId !== null
              ? encodeAvailabilityCursor({ tenantId, storeId, afterProductId: page.lastScannedProductId })
              : null,
        };
      },
    );
  }
}

const ZERO_FACTS = { primarySellable: '0.0000', expiredTrackedSellable: '0.0000', activeReserved: '0.0000' } as const;
