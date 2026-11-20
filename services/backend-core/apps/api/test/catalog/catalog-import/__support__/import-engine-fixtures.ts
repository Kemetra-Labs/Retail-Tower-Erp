/**
 * RT-1505 part B — fixtures of the validate engine specs (`import-row-validate.unit.spec.ts`): an in-memory catalogue
 * and a row builder, so each rule and each matching outcome is tested without a database.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. Arabic text is written as code points.
 */
import type { CatalogLookups, ProductFacts } from "../../../../src/catalog/catalog-import/import-lookups";
import { collectLookupKeys } from "../../../../src/catalog/catalog-import/import-lookups";
import type { ColumnMapping, ImportMode, MappingTarget } from "../../../../src/catalog/catalog-import/import-mapping";
import { evaluateRows, type RowResult } from "../../../../src/catalog/catalog-import/import-row-evaluate";
import { parseRows } from "../../../../src/catalog/catalog-import/import-row-parse";
import type { StagedCell } from "../../../../src/catalog/catalog-import/staged-cell";

export interface FixtureProduct {
  readonly id: string;
  readonly name: string;
  readonly sku?: string;
  readonly barcodes?: readonly string[];
  readonly plu?: string;
  readonly description?: string | null;
  readonly tax?: string;
  readonly category?: string | null;
  readonly brand?: string | null;
  readonly active?: boolean;
  readonly retired?: boolean;
  readonly updated?: string;
}

export interface FixtureCatalogue {
  readonly products?: readonly FixtureProduct[];
  /** Active store-scoped identifiers: the product that holds each. */
  readonly storeScoped?: ReadonlyArray<{ readonly type: "sku" | "barcode" | "plu"; readonly value: string; readonly productId: string }>;
  readonly categories?: readonly string[];
  readonly brands?: readonly string[];
  readonly usedTax?: readonly string[];
}

const key = (type: string, value: string): string => `${type}\u{0}${value}`;

export function catalogue(c: FixtureCatalogue = {}): CatalogLookups {
  const products = new Map<string, ProductFacts>();
  const tenantWide = new Map<string, string>();
  const productsByName = new Map<string, string[]>();
  for (const p of c.products ?? []) {
    const identifiers: Array<{ type: "sku" | "barcode" | "plu"; value: string }> = [];
    if (p.sku !== undefined) identifiers.push({ type: "sku", value: p.sku });
    for (const b of p.barcodes ?? []) identifiers.push({ type: "barcode", value: b });
    if (p.plu !== undefined) identifiers.push({ type: "plu", value: p.plu });
    for (const i of identifiers) tenantWide.set(key(i.type, i.value), p.id);
    products.set(p.id, {
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      taxCategory: p.tax ?? "standard",
      isActive: p.active ?? true,
      retired: p.retired ?? false,
      updatedAtText: p.updated ?? "2026-11-20 10:00:00.123456+00",
      categoryName: p.category ?? null,
      brandName: p.brand ?? null,
      identifiers,
    });
    if (p.retired !== true) productsByName.set(p.name, [...(productsByName.get(p.name) ?? []), p.id]);
  }
  const storeScoped = new Map<string, string[]>();
  for (const s of c.storeScoped ?? []) storeScoped.set(key(s.type, s.value), [...(storeScoped.get(key(s.type, s.value)) ?? []), s.productId]);
  for (const s of c.storeScoped ?? []) {
    if (!products.has(s.productId)) throw new Error(`fixture: store-scoped holder ${s.productId} is not a product`);
  }
  return {
    tenantWide,
    storeScoped,
    products,
    categories: new Set(c.categories ?? []),
    brands: new Set(c.brands ?? []),
    usedTaxCategories: new Set(c.usedTax ?? ["standard"]),
    productsByName,
  };
}

/** The mapping of columns 1..n to `targets`, in order. */
export function mapOf(...targets: MappingTarget[]): ColumnMapping[] {
  return targets.map((target, i) => ({ columnNumber: i + 1, target }));
}

/** Validates rows (each an array of staged cells; source row numbers 2, 3, ...) the way the service does. */
export function run(
  mode: ImportMode,
  mapping: readonly ColumnMapping[],
  cellRows: ReadonlyArray<readonly StagedCell[]>,
  lookups: CatalogLookups = catalogue(),
): RowResult[] {
  const parsed = parseRows(
    mapping,
    cellRows.map((cells, i) => ({ rowNumber: i + 2, cells })),
  );
  // The keys a file would ask the catalogue about are computed, as the service does, so a regression there shows.
  collectLookupKeys(parsed);
  return evaluateRows(mode, mapping, parsed, lookups);
}

export const codes = (r: RowResult): string[] => r.issues.map((i) => i.code);

export const num = (v: string): StagedCell => ({ t: "n", v });
export const formula = (v: string | null | { t: "n" | "b" | "d"; v: string }): StagedCell => ({ t: "f", v });

/** Arabic words as code points. */
export const AR = {
  yes: "\u{0646}\u{0639}\u{0645}",
  no: "\u{0644}\u{0627}",
  barcode: "\u{0628}\u{0627}\u{0631}\u{0643}\u{0648}\u{062F}",
  digits: "\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}",
};
