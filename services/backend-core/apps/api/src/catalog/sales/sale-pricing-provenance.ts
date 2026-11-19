/**
 * sale-pricing-provenance.ts — RT-1151 (RT-282 PR-07; contract
 * `pos-sales/sales.yaml` 1.25.0-draft `CaptureSaleLine.pricingProvenance`,
 * migration 0122).
 *
 * A captured line may carry `pricingProvenance`: what priced it on the till
 * (`origin: pricing` after the tenant's cutover, `origin: legacy` from the
 * legacy catalogue path). It is stored VERBATIM, one row per line that carries
 * it, in the capture transaction (owner D3, RT-1151 comment 17783): never
 * recomputed, never checked against the price. A till may sell from a cached
 * revision while offline, so a mismatch is a later Pricing Health finding
 * (spec 043 G4-13), never a refused sale. A line without it stores nothing.
 * The DTO already validated the shape (400).
 */
import type { PoolClient } from "pg";

import type { CaptureSaleLineDto } from "./dto/capture-sale-request.dto";

type ProvenancedLine = { readonly index: number; readonly provenance: NonNullable<CaptureSaleLineDto["pricingProvenance"]> };

/** Writes the provenance of every line that carries one; a sale with none writes nothing. */
export async function writeSaleLinePricingProvenance(
  client: PoolClient,
  sale: { readonly saleId: string; readonly tenantId: string; readonly storeId: string },
  lineIds: ReadonlyArray<string>,
  lines: ReadonlyArray<CaptureSaleLineDto>,
): Promise<void> {
  const carried: ProvenancedLine[] = lines.flatMap((line, index) =>
    line.pricingProvenance === undefined ? [] : [{ index, provenance: line.pricingProvenance }],
  );
  if (carried.length === 0) return;
  const pricing = (p: ProvenancedLine["provenance"]) => (p.origin === "pricing" ? p : null);
  const legacy = (p: ProvenancedLine["provenance"]) => (p.origin === "legacy" ? p : null);
  await client.query(
    `INSERT INTO sale_line_pricing_provenance
       (sale_line_id, sale_id, tenant_id, store_id, origin, source_scope, price_event_id, price_kind,
        pricing_revision, catalog_cursor)
     SELECT f.line_id, $2::uuid, $3::uuid, $4::uuid, f.origin, f.source_scope, f.price_event_id, f.price_kind,
            f.pricing_revision, f.catalog_cursor
       FROM unnest($1::uuid[], $5::text[], $6::text[], $7::uuid[], $8::text[], $9::bigint[], $10::text[])
              AS f(line_id, origin, source_scope, price_event_id, price_kind, pricing_revision, catalog_cursor)`,
    [
      carried.map((c) => lineIds[c.index]!),
      sale.saleId,
      sale.tenantId,
      sale.storeId,
      carried.map((c) => c.provenance.origin),
      carried.map((c) => c.provenance.sourceScope),
      carried.map((c) => pricing(c.provenance)?.priceEventId ?? null),
      carried.map((c) => pricing(c.provenance)?.priceKind ?? null),
      carried.map((c) => pricing(c.provenance)?.pricingRevision ?? null),
      carried.map((c) => legacy(c.provenance)?.catalogCursor ?? null),
    ],
  );
}
