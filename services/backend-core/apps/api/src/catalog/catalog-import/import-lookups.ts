/**
 * RT-1505 part B (spec 049 section 7.1): the catalogue facts validate matches against, and the keys a file needs
 * looked up. The repository fills these (`catalog-import.validate-repository.ts`); the evaluator only reads them.
 */
import { identifierKey, type ParsedRow } from "./import-row-parse";
import type { ProductRef } from "./import-issues";

/** A product of the tenant and what an import compares or names. */
export interface ProductFacts {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly taxCategory: string;
  readonly isActive: boolean;
  readonly retired: boolean;
  /** `updated_at` as Postgres prints it (microseconds kept: the publish stale re-check compares it, spec 049 section 8.2). */
  readonly updatedAtText: string;
  readonly categoryName: string | null;
  readonly brandName: string | null;
  /** The product's ACTIVE tenant-wide identifiers. */
  readonly identifiers: ProductRef["identifiers"];
}

export interface CatalogLookups {
  /** (type, value) key -> the product that holds it as an active tenant-wide identifier (the unique index allows one). */
  readonly tenantWide: ReadonlyMap<string, string>;
  /** (type, value) key -> the products that hold it as an active store-scoped identifier. */
  readonly storeScoped: ReadonlyMap<string, readonly string[]>;
  readonly products: ReadonlyMap<string, ProductFacts>;
  /** Names of active categories and brands, and tax categories any product uses, among those the file names. */
  readonly categories: ReadonlySet<string>;
  readonly brands: ReadonlySet<string>;
  readonly usedTaxCategories: ReadonlySet<string>;
  /** Exact name -> the (at most five) non-retired products with it, among the names the file carries. */
  readonly productsByName: ReadonlyMap<string, readonly string[]>;
}

/** The distinct values a file asks the catalogue about. */
export interface LookupKeys {
  readonly identifierTypes: string[];
  readonly identifierValues: string[];
  readonly names: string[];
  readonly categories: string[];
  readonly brands: string[];
  readonly taxCategories: string[];
}

/** The most products of one name a `possible_duplicate` review lists. */
export const MAX_NAME_MATCHES = 5;

export function collectLookupKeys(rows: readonly ParsedRow[]): LookupKeys {
  const identifiers = new Set<string>();
  const sets = { names: new Set<string>(), categories: new Set<string>(), brands: new Set<string>(), taxCategories: new Set<string>() };
  const types: string[] = [];
  const values: string[] = [];
  for (const row of rows) {
    for (const id of row.identifiers) {
      const key = identifierKey(id.type, id.value);
      if (identifiers.has(key)) continue;
      identifiers.add(key);
      types.push(id.type);
      values.push(id.value);
    }
    if (row.name !== null) sets.names.add(row.name.value);
    if (row.category !== null) sets.categories.add(row.category.value);
    if (row.brand !== null) sets.brands.add(row.brand.value);
    if (row.taxCategory !== null) sets.taxCategories.add(row.taxCategory.value);
  }
  return {
    identifierTypes: types,
    identifierValues: values,
    names: [...sets.names],
    categories: [...sets.categories],
    brands: [...sets.brands],
    taxCategories: [...sets.taxCategories],
  };
}
