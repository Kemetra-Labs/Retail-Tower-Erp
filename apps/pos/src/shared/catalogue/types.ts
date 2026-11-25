// RT-1222: the `catalogue.*` bridge types, moved verbatim out of bridge-api.ts.
import type { ProductSnapshotDisplay, ResolvedSeam } from './product-snapshot.js';

// ────────────────────────────────────────────────────────────────────────────
// 009-product-search-and-barcode-lookup — `catalogue.*` namespace (read-only)
// ────────────────────────────────────────────────────────────────────────────
//
// Schema source of truth:
//   specs/009-product-search-and-barcode-lookup/contracts/bridge-api.md
//
// Slice S1 (§A0/§A1 ratified 2026-05-30) lands the typed surface + a
// session-gated SKELETON (every handler returns the `catalogue_unavailable`
// stub until the read model is wired). Exact lookup lands in S2 (§A2), folded
// search in S3 (§A2), resolve + 005 seam wiring in S4 (§A1). The namespace is
// READ-ONLY — there is no insert/update/delete handler (AD-2). Every handler's
// first step is the active-session gate (NFR-6a); refusals are generic.

export interface CatalogueLookupBarcodeRequest {
  barcode: string;
}
export interface CatalogueLookupSkuRequest {
  sku: string;
}
export interface CatalogueSearchRequest {
  query: string;
}
export interface CatalogueResolveRequest {
  product_id: string;
}

/**
 * Generic gate refusals (NFR-6a). The `reason` is for diagnostic logging only
 * and is NEVER echoed to the cashier verbatim. No role gate beyond an active
 * session — cashier/manager/admin all look up products.
 */
export type CatalogueRefusalReason = 'no_session' | 'tenant_isolation';

/** Shared by `lookupBarcode` + `lookupSku` (exact lookup, FR-4/FR-9). */
export type CatalogueLookupResponse =
  | { kind: 'one'; product: ProductSnapshotDisplay } // exactly one active product → confirm-first (FR-5)
  | { kind: 'not_found' } // zero matches (FR-6)
  | { kind: 'ambiguous' } // >1 active product for this barcode (FR-7)
  | { kind: 'catalogue_unavailable' } // empty/missing/unreadable read model (FR-24)
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/** Folded substring name/alias search (FR-11/12/13). */
export type CatalogueSearchResponse =
  | { kind: 'results'; items: readonly ProductSnapshotDisplay[]; truncated: boolean } // ranked, ≤20 (NFR-4)
  | { kind: 'not_found' }
  | { kind: 'too_short' } // < 2 normalized chars (FR-16)
  | { kind: 'catalogue_unavailable' }
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * Resolve a chosen product to the confirm-and-add snapshot. `seam` is the 005
 * cart-seam success shape (`ResolvedSeam` = `{ display_name, unit_price_minor }`
 * — §A1 ratified: no `version`, matching 005's live `ItemRefResolver`).
 */
export type CatalogueResolveResponse =
  | { kind: 'ok'; snapshot: ProductSnapshotDisplay; seam: ResolvedSeam }
  | {
      kind: 'refused';
      // Gate refusals (NFR-6a — resolve is session-gated like every handler)
      // PLUS the resolve-specific refusals (FR-18/FR-19): inactive product,
      // unknown id, missing required field, or any other generic failure.
      reason:
        | CatalogueRefusalReason
        | 'unknown_item'
        | 'disabled'
        | 'missing_required_field'
        | 'generic';
    }
  | { kind: 'catalogue_unavailable' };

// ───────────────────────────────────────────────────────────────────────────
// 010-pos-catalog-read-down-consumption (T041) — `catalogue.refresh` /
// `catalogue.freshness` additions (§A4 bridge-security review). Both requests
// are `{}` (INP-1 — the terminal identity + tenant come from session/pairing,
// NEVER the renderer payload). Both gate on the session FIRST (AD-1) and refuse
// generically (AD-2). Neither returns catalogue data or any secret (WR-2/SEC-1).
// ───────────────────────────────────────────────────────────────────────────

/** Empty request — no renderer-supplied identity/scope/cursor (INP-1 / FR-15a). */
export type CatalogueRefreshRequest = Record<string, never>;
export type CatalogueFreshnessRequest = Record<string, never>;
export type CatalogueCountsRequest = Record<string, never>;

/**
 * `catalogue.refresh` response (contract Addition 1). Status ONLY — no catalogue
 * data, no per-record content (WR-2). Returns immediately after kicking off the
 * tick, NOT after the promote commits (P9-2 / FR-12 — no fake "done").
 */
export type CatalogueRefreshResponse =
  | { kind: 'started' } // a read-down tick was kicked off
  | { kind: 'already_running' } // single-flight: a tick is in progress (FR-14)
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * `catalogue.freshness` response (contract Addition 2). A truthful last-updated
 * read for the FR-16 indicator. `is_empty` closes the empty-catalogue
 * truthfulness hole (SC-10): a successful EMPTY promote sets a non-null
 * `last_success_at` while the live products table has 0 rows, so the indicator
 * must distinguish three states (P9-1) — never a bare timestamp implying data
 * when there is none.
 */
export type CatalogueFreshnessResponse =
  | { kind: 'ok'; last_success_at: string | null; is_empty: boolean }
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * `catalogue.counts` response (diagnostics) — the tenant-scoped LOCAL read-model
 * size for the Catalogue Diagnostics screen. Integers ONLY (WR-2): no catalogue
 * rows, no secrets, no device token. `products` = live products row count;
 * `barcodes` = product_barcodes (alias) row count. Both scoped to the session
 * tenant (P17-1). Refuses (never throws/leaks) with no session or no source.
 */
export type CatalogueCountsResponse =
  | { kind: 'ok'; products: number; barcodes: number }
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * 009 read-only `catalogue.*` bridge surface, EXTENDED by 010 with the read-down
 * `refresh` / `freshness` additions. Gated server-side on an active operator
 * session (NFR-6a); renderer-side checks are never load-bearing. Tenant scoping
 * is derived from the session at the repo layer (S2). Optional for the same
 * staged-wiring reason as `sales`/`receipts` above — the preload
 * (`src/preload/index.ts`) wires it in S1 (T016); 010 adds `refresh`/`freshness`.
 */
export interface CatalogueBridgeAPI {
  /** Exact barcode lookup (FR-4). */
  lookupBarcode(req: CatalogueLookupBarcodeRequest): Promise<CatalogueLookupResponse>;
  /** Exact SKU lookup (FR-9). */
  lookupSku(req: CatalogueLookupSkuRequest): Promise<CatalogueLookupResponse>;
  /** Folded substring name/alias search (FR-11/12/13). */
  search(req: CatalogueSearchRequest): Promise<CatalogueSearchResponse>;
  /** Resolve a chosen product to the confirm-and-add snapshot (FR-19). */
  resolve(req: CatalogueResolveRequest): Promise<CatalogueResolveResponse>;
  /** 010 — kick off one manual read-down tick (status only; §A4 Addition 1). */
  refresh(req: CatalogueRefreshRequest): Promise<CatalogueRefreshResponse>;
  /** 010 — truthful last-updated read for the FR-16 indicator (§A4 Addition 2). */
  freshness(req: CatalogueFreshnessRequest): Promise<CatalogueFreshnessResponse>;
  /** 010 diagnostics — tenant-scoped local read-model counts (integers only). */
  counts(req: CatalogueCountsRequest): Promise<CatalogueCountsResponse>;
}
