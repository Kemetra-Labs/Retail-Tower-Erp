/**
 * RT-738 / RT-1334 / RT-1507 — the refusals of the console catalog writes, in one place so the single-product writes
 * (`console-catalog.write.service.ts`) and the shared domain functions (`console-catalog.domain.ts`, also called by the
 * product import's publish) raise the same errors. `console-catalog.write.service.ts` re-exports these names, so no
 * importer changes.
 */

type CatalogWriteRefusalCode =
  | "stale_write"
  | "product_retired"
  | "alias_conflict"
  | "price_override_present"
  | "category_unavailable"
  | "brand_unavailable"
  | "brand_name_conflict"
  | "override_empty"
  | "tax_override_forbidden";

const REFUSAL_STATUS: Readonly<Record<CatalogWriteRefusalCode, 403 | 409 | 422>> = {
  stale_write: 409,
  product_retired: 409,
  alias_conflict: 409,
  price_override_present: 409,
  category_unavailable: 422,
  brand_unavailable: 422,
  brand_name_conflict: 409,
  override_empty: 422,
  tax_override_forbidden: 403,
};

/** A write the contract refuses with a 403 / 409 / 422 and its code. Nothing is written. */
export class CatalogWriteRefusedError extends Error {
  readonly status: 403 | 409 | 422;
  constructor(readonly code: CatalogWriteRefusalCode) {
    super(code);
    this.name = "CatalogWriteRefusedError";
    this.status = REFUSAL_STATUS[code];
  }
}
