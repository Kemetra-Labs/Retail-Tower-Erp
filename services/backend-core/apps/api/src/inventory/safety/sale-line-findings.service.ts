/**
 * SaleLineFindingsService — Jira RT-451 slice S3 (RT-455 OD-2; RT-50 G7-9
 * rows 2 and 3). Contract: `listSaleLineFindings` in `inventory/inventory.yaml`.
 *
 * Reads the append-only `sale_line_findings` (0089) recorded at sale capture:
 * newest first (`recorded_at DESC, id DESC`), filtered by `kind` and
 * `storeId`, in keyset pages as `listStockMovements` (RT-731). Every finding is
 * critical (the severity is not stored).
 *
 * Scope: the caller's store scope (`callerStoreScope`, RT-51 D6), as
 * `listInventorySafetyFindings` — owner / tenant_admin see the tenant (bounded
 * by their membership), a store_manager only its own stores. Filters narrow
 * and never widen: a `storeId` outside the scope or not of this tenant
 * matches nothing and answers an empty page.
 *
 * Read-only, under the tenant's RLS context. The cursor is decoded and checked
 * against the operation, the tenant and the filters before any read (400 on a
 * foreign token), and its position is ANDed with them.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext, type SaleLineFindingKind } from '@data-pulse-2/db';
import type { Pool } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { MembershipRepository } from '../../context/membership.repository';
import { callerStoreScope, scopeStoreIds } from '../../context/operator-store-scope';
import type { ResolvedContext } from '../../context/types';
import {
  SaleLineFindingsCursorError,
  decodeSaleLineFindingsCursor,
  encodeSaleLineFindingsCursor,
  type SaleLineFindingsCursorBinding,
  type SaleLineFindingsKeyset,
} from './sale-line-findings.cursor';
import { instantKeySql } from './safety-history.cursor';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListSaleLineFindingsInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  readonly kind?: SaleLineFindingKind | undefined;
  readonly storeId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Contract `SaleLineFinding`. */
export interface SaleLineFindingBody {
  readonly id: string;
  readonly kind: string;
  readonly severity: 'critical';
  readonly cause: string;
  readonly storeId: string;
  readonly saleId: string;
  readonly saleLineId: string;
  readonly tenantProductRef: string;
  readonly trackingIdentityId: string;
  readonly holdId: string | null;
  readonly businessDate: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** Contract `SaleLineFindingList`. */
export interface SaleLineFindingListBody {
  readonly items: SaleLineFindingBody[];
  readonly nextCursor: string | null;
}

interface FindingRow {
  readonly id: string;
  readonly kind: string;
  readonly cause: string;
  readonly store_id: string;
  readonly sale_id: string;
  readonly sale_line_id: string;
  readonly tenant_product_ref: string;
  readonly tracking_identity_id: string;
  readonly hold_id: string | null;
  readonly business_date: string;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
  readonly at_key: string;
}

/**
 * `$2` kind, `$3` storeId, `$4` the scoped store ids (null when tenant-wide,
 * empty → no row), `$5`/`$6` the keyset position, `$7` limit + 1.
 */
const LIST_SQL = `
  SELECT f.id, f.kind, f.cause, f.store_id, f.sale_id, f.sale_line_id, f.tenant_product_ref,
         f.tracking_identity_id, f.hold_id, f.business_date::text AS business_date,
         f.occurred_at, f.recorded_at, ${instantKeySql('f.recorded_at')} AS at_key
    FROM sale_line_findings f
   WHERE f.tenant_id = $1
     AND ($2::text IS NULL OR f.kind = $2)
     AND ($3::uuid IS NULL OR f.store_id = $3)
     AND ($4::uuid[] IS NULL OR f.store_id = ANY($4::uuid[]))
     AND ($5::timestamptz IS NULL OR (f.recorded_at, f.id) < ($5::timestamptz, $6::uuid))
   ORDER BY f.recorded_at DESC, f.id DESC
   LIMIT $7`;

function toBody(row: FindingRow): SaleLineFindingBody {
  return {
    id: row.id,
    kind: row.kind,
    severity: 'critical',
    cause: row.cause,
    storeId: row.store_id,
    saleId: row.sale_id,
    saleLineId: row.sale_line_id,
    tenantProductRef: row.tenant_product_ref,
    trackingIdentityId: row.tracking_identity_id,
    holdId: row.hold_id,
    businessDate: row.business_date,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
  };
}

@Injectable()
export class SaleLineFindingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly memberships: MembershipRepository,
  ) {}

  listFindings(input: ListSaleLineFindingsInput): Promise<SaleLineFindingListBody> {
    const binding: SaleLineFindingsCursorBinding = {
      tenantId: input.tenantId,
      kind: input.kind ?? null,
      storeId: input.storeId ?? null,
    };
    const after = decodeCursor(binding, input.cursor);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const scope = await callerStoreScope(client, this.memberships, input);
        const r = await client.query<FindingRow>(LIST_SQL, [
          input.tenantId,
          binding.kind,
          binding.storeId,
          scopeStoreIds(scope),
          after?.atKey ?? null,
          after?.id ?? null,
          limit + 1,
        ]);
        const items = r.rows.slice(0, limit);
        const last = items[items.length - 1];
        return {
          items: items.map(toBody),
          nextCursor:
            r.rows.length > limit && last
              ? encodeSaleLineFindingsCursor(binding, { atKey: last.at_key, id: last.id })
              : null,
        };
      },
    );
  }
}

/** A foreign or malformed cursor is a 400, refused before any read. */
function decodeCursor(
  binding: SaleLineFindingsCursorBinding,
  cursor: string | undefined,
): SaleLineFindingsKeyset | null {
  if (cursor === undefined) return null;
  try {
    return decodeSaleLineFindingsCursor(binding, cursor);
  } catch (err: unknown) {
    if (err instanceof SaleLineFindingsCursorError) throw new BadRequestException(err.message);
    throw err;
  }
}
