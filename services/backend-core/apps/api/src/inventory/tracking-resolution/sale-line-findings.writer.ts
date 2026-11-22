/**
 * The append-only `sale_line_findings` writer (RT-451 S3, migration 0089), moved here from
 * `sales/tracked-lines/capture-tracking.ts` (RT-1463). `inventory` owns the table: it reads the
 * findings (`safety/sale-line-findings.service.ts`) and writes them on a tracking resolution; sale
 * capture writes a first capture's findings through this port (`inventory/index.ts`). Runs on the
 * caller's tenant-context transaction client.
 */
import type { PoolClient } from "pg";

/** One finding of a line: its kind, its cause and the hold it names (if any). */
interface SaleLineFinding {
  readonly kind: string;
  readonly cause: string;
  readonly holdId: string | null;
}

/** One stored line and the findings its classification produced. */
export interface LineFindingsToWrite {
  readonly saleLineId: string;
  readonly productId: string;
  readonly identityId: string;
  readonly findings: ReadonlyArray<SaleLineFinding>;
}

/** Append the row-2 and row-3 findings of a first capture, one per (line, kind, cause). */
export async function writeSaleLineFindings(
  client: PoolClient,
  sale: { readonly tenantId: string; readonly storeId: string; readonly saleId: string; readonly businessDate: string; readonly occurredAt: string },
  lines: ReadonlyArray<LineFindingsToWrite>,
): Promise<void> {
  const rows = lines.flatMap((l) => l.findings.map((f) => ({ ...f, line: l })));
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO sale_line_findings
       (tenant_id, store_id, sale_id, sale_line_id, tenant_product_ref, tracking_identity_id,
        kind, cause, hold_id, business_date, occurred_at)
     SELECT $1, $2, $3, f.line_id, f.product_id, f.identity_id, f.kind, f.cause, f.hold_id, $4::date, $5::timestamptz
       FROM unnest($6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::text[], $11::uuid[])
            AS f(line_id, product_id, identity_id, kind, cause, hold_id)
     ON CONFLICT (sale_line_id, kind, cause) DO NOTHING`,
    [
      sale.tenantId,
      sale.storeId,
      sale.saleId,
      sale.businessDate,
      sale.occurredAt,
      rows.map((r) => r.line.saleLineId),
      rows.map((r) => r.line.productId),
      rows.map((r) => r.line.identityId),
      rows.map((r) => r.kind),
      rows.map((r) => r.cause),
      rows.map((r) => r.holdId),
    ],
  );
}
