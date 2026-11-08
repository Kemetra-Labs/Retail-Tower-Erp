/**
 * Opaque keyset cursor of `listSaleLineFindings` — Jira RT-451 slice S3
 * (contract `inventory/inventory.yaml`; RT-731 convention, as
 * `safety-history.cursor.ts`).
 *
 * The list is ordered `recorded_at DESC, id DESC`. The token is unsigned
 * base64url JSON bound to this operation, the tenant and a digest of the
 * normalized filters (`kind`, `storeId`); any other token is refused
 * (`SaleLineFindingsCursorError` → 400 `validation_error`). It carries only the
 * keyset position: the role and store scope are checked on every request and
 * the position is ANDed with the tenant, the scope and the filters, so a
 * hand-built token can only reposition the walk inside rows the caller may
 * already read.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { decodeOpaque, encodeOpaque } from '../../common/cursor/opaque-cursor';
import { KEY_INSTANT, LOWER_UUID, namesRealInstant } from '../../console-sales/console-sales.query';

const OPERATION = 'sale_line_findings';

export class SaleLineFindingsCursorError extends Error {
  constructor() {
    super('cursor is not a valid continuation token for this query');
    this.name = 'SaleLineFindingsCursorError';
  }
}

/** What a cursor is bound to: the tenant and the normalized filters. */
export interface SaleLineFindingsCursorBinding {
  readonly tenantId: string;
  readonly kind: string | null;
  readonly storeId: string | null;
}

/** The last row of a page: `atKey` is UTC with six fractional digits (microseconds). */
export interface SaleLineFindingsKeyset {
  readonly atKey: string;
  readonly id: string;
}

const CursorPayload = z
  .object({
    op: z.literal(OPERATION),
    tenant: z.string().regex(LOWER_UUID),
    digest: z.string().min(1),
    at: z.string().regex(KEY_INSTANT).refine(namesRealInstant),
    id: z.string().regex(LOWER_UUID),
  })
  .strict();

type CursorPayload = z.infer<typeof CursorPayload>;

function digestOf(binding: SaleLineFindingsCursorBinding): string {
  const ordered = [binding.kind, binding.storeId === null ? null : binding.storeId.toLowerCase()];
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('base64url').slice(0, 22);
}

export function encodeSaleLineFindingsCursor(
  binding: SaleLineFindingsCursorBinding,
  keyset: SaleLineFindingsKeyset,
): string {
  const payload: CursorPayload = {
    op: OPERATION,
    tenant: binding.tenantId.toLowerCase(),
    digest: digestOf(binding),
    at: keyset.atKey,
    id: keyset.id.toLowerCase(),
  };
  return encodeOpaque(payload);
}

/** The keyset position of `cursor`, or SaleLineFindingsCursorError when it was not issued for `binding`. */
export function decodeSaleLineFindingsCursor(
  binding: SaleLineFindingsCursorBinding,
  cursor: string,
): SaleLineFindingsKeyset {
  const p = decodeOpaque(cursor, CursorPayload, () => new SaleLineFindingsCursorError());
  const boundHere = p.tenant === binding.tenantId.toLowerCase() && p.digest === digestOf(binding);
  if (!boundHere) throw new SaleLineFindingsCursorError();
  return { atKey: p.at, id: p.id };
}
