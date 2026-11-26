/**
 * T032 — 008 Slice 1b shared sale types.
 *
 * Closed enums + canonical types consumed by both the main process and the
 * renderer through `src/shared/bridge-api.ts`. Mirrors
 * `specs/008-sale-finalization-and-receipts/data-model.md §"Entity: Sale"` +
 * `contracts/bridge-api.md §"Namespace: sales.*"`.
 *
 * Constitution §VII (no leakage): only display-safe / structural values
 * appear here. The main-only fields explicitly excluded from the renderer
 * surface — `envelope_handoff_action_id`, `payment_attempt_id`,
 * `envelope_cart_id`, `tenant_tax_registration_id` — are NEVER typed here.
 * Pattern mirrors `src/shared/payments/types.ts` (006 S3b).
 *
 * **Closed-set discipline.** Each exported `as const` tuple drives a
 * derived union; tests assert exhaustive membership at runtime.
 */

// ── Branded primitives ───────────────────────────────────────────────────────

/**
 * Branded `string` for sale identifiers. Prevents accidentally passing a
 * raw string where a `SaleId` is expected. Cast via `'…' as SaleId` at
 * the trust boundary.
 */
export type SaleId = string & { readonly __brand: 'SaleId' };

/**
 * Branded `string` for the canonical sale-number format
 * `<terminal_label>-<YYYY-MM-DD>-<NNNNNN>` per AD-7. Treated as opaque by
 * the renderer; the main-side allocator is the only producer.
 */
export type SaleNumber = string & { readonly __brand: 'SaleNumber' };

// ── Tender-line summary (cached on Sale; FR-017 minimum) ─────────────────────

/**
 * The 3 tender types from 006 (per `src/shared/payments/types.ts`
 * TENDER_TYPES). Re-declared here narrowly so the 008 contract is
 * self-contained for the renderer; matching the 006 surface verbatim.
 */
export const SALES_TENDER_TYPES = ['cash', 'external_card_terminal', 'internal_voucher'] as const;
export type SalesTenderType = (typeof SALES_TENDER_TYPES)[number];

/**
 * Cached per-line summary carried on the Sale row + crossing the bridge to
 * the renderer (`sales.read` response). Per FR-017 + spec §"Sensitive-data
 * minimisation":
 *
 *   • `tender_type` + `amount_applied_minor` always present.
 *   • `change_due_minor` populated for cash lines ONLY (FR-017).
 *   • `external_reference` populated for external_card_terminal lines
 *     ONLY (006 OQ-PLAN-5 permissive resolution).
 *   • `voucher_authority_redemption_id` populated for internal_voucher
 *     lines ONLY (006 FR-017 / OQ-PLAN-7 permissive resolution).
 *
 * **NO voucher code. NO PAN. NO PIN record id. NO issuer name. NO
 * envelope_handoff_action_id.** Constitution §P6/§P7 + spec FR-071 +
 * 008 CR3 forbidden-fields.
 */
export interface TenderLineSummary {
  tender_type: SalesTenderType;
  amount_applied_minor: number;
  change_due_minor?: number;
  external_reference?: string;
  voucher_authority_redemption_id?: string;
  /**
   * RT-362: the source tender line, frozen at finalize. Absent on a sale
   * finalized before RT-362 (or whose lines could not all be identified).
   */
  tender_line_id?: string;
  /** RT-362: 1-based rank of the line among the sale's applied lines, by `apply_order`. */
  sequence?: number;
}

// ── Print-event projection (latest by timestamp) ─────────────────────────────

export const PRINT_EVENT_OUTCOMES = ['success', 'failure', 'manual_override'] as const;
export type PrintEventOutcome = (typeof PRINT_EVENT_OUTCOMES)[number];

export const PRINT_EVENT_PURPOSES = ['first_print', 'reprint', 'retry_after_failure'] as const;
export type PrintEventPurpose = (typeof PRINT_EVENT_PURPOSES)[number];

/**
 * Latest PrintEvent projection — the renderer uses this to gate the
 * reprint affordance (AD-10) and to project the printer-failure banner.
 * NOT the full row; `failure_reason`, `previous_failed_print_event_ids`,
 * and `render_path` stay main-side per Constitution §P15 (minimised
 * state to renderer).
 */
export interface PrintEventSummary {
  print_event_id: string;
  outcome: PrintEventOutcome;
  purpose: PrintEventPurpose;
  printed_at: string;
  duplicate_copy_sequence_number?: number;
}

// ── Drawer-event projection (latest by timestamp) ────────────────────────────

export const DRAWER_EVENT_OUTCOMES = ['opened', 'suppressed', 'failed'] as const;
export type DrawerEventOutcome = (typeof DRAWER_EVENT_OUTCOMES)[number];

/**
 * Latest DrawerEvent projection. The renderer uses `outcome='failed'` to
 * project the drawer-failure banner. The full row (suppression_reason,
 * failure_reason, last_successful_open_at_for_terminal,
 * triggering_print_event_id) stays main-side until a UI surface
 * actually needs each field.
 */
export interface DrawerEventSummary {
  drawer_event_id: string;
  outcome: DrawerEventOutcome;
  attempted_at: string;
}

// ── Banner state (sales.subscribe topic='banner_state' projection) ───────────

/**
 * Printer-failure slice of `BannerState` — the sale whose own latest print
 * event is an unresolved `outcome='failure'`. Carries the fields
 * `<PrinterFailureBanner>` needs (Slice 3 / T290).
 */
export interface PrinterBannerFailure {
  sale_id: string;
  failure_reason: string;
  /** AD-10: whether the sale already has a prior successful print. */
  has_successful_print: boolean;
}

/**
 * Drawer-failure slice of `BannerState` — the sale whose own drawer event is
 * `outcome='failed'`. Carries `last_successful_open_at` for the banner's
 * relative-timestamp display (Slice 4 / T360); null when the terminal has no
 * prior successful drawer open on record. UTC ISO-8601.
 */
export interface DrawerBannerFailure {
  sale_id: string;
  last_successful_open_at: string | null;
}

/**
 * The renderer's persistent-banner projection for the current terminal.
 * Computed PER-SALE (never terminal-global-latest — that would silently mask
 * an older unresolved failure behind a newer sale's success; see coordination
 * §S3c projection rule): the terminal surfaces, per failure class, the
 * most-recently-finalized sale whose OWN latest print/drawer event is still an
 * unresolved failure.
 *
 * **Coexistence record, NOT a single-kind union** (Slice 4 decision, Ahmed
 * 2026-05-29): the printer-failure and drawer-failure banners can be on screen
 * AT THE SAME TIME (T330 / T361 / NFR-008). A single discriminated union could
 * only ever report ONE banner, so a printer failure would silently hide a
 * concurrent drawer failure. Each slice is projected and consumed
 * independently:
 *
 *   • `printer_failure: null`   — no unresolved print failure → no printer banner.
 *   • `printer_failure: {...}`   — `<PrinterFailureBanner>` mounts (`useBannerState`).
 *   • `drawer_failure: null`     — no unresolved drawer failure → no drawer banner.
 *   • `drawer_failure: {...}`     — `<DrawerFailureBanner>` mounts (`useDrawerBannerState`).
 *
 * `{ printer_failure: null, drawer_failure: null }` is the no-banner state.
 */
export interface BannerState {
  printer_failure: PrinterBannerFailure | null;
  drawer_failure: DrawerBannerFailure | null;
}

// ── Recent-sale summary (sales.subscribe topic='recent' projection) ──────────

/** Compact most-recent-finalized-sale summary (FR-046 "recent sale" UI). */
export interface RecentSaleSummary {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
}

// ── Sale lines (RT-541 detail projection) ────────────────────────────────────

/**
 * One recorded line of a sale, from the frozen `sales.lines_json` snapshot
 * (008 T028a). Display fields only; snapshot bookkeeping (line_id, version,
 * last_action_id) stays main-side. Money is integer minor units.
 */
export interface SaleLineView {
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  note: string | null;
}

/**
 * The lines of a sale, or why they cannot be shown (RT-541):
 *   • `recorded`     — the snapshot finalize wrote;
 *   • `not_recorded` — a sale finalized before migration 0028, whose column
 *     holds the default '[]': show "lines not recorded", never an empty sale;
 *   • `unreadable`   — the snapshot is present but malformed; nothing is guessed.
 */
export type SaleLinesView =
  | { state: 'recorded'; items: SaleLineView[] }
  | { state: 'not_recorded' }
  | { state: 'unreadable' };

// ── Local sales history (RT-541 `sales.list`) ────────────────────────────────

/** OD-534-4: at most 31 inclusive business days per query; wider is refused. */
export const SALES_LIST_MAX_SPAN_DAYS = 31;
/** OD-534-4: rows per page by default. */
export const SALES_LIST_DEFAULT_PAGE_SIZE = 50;
/** OD-534-4: the page-size cap. */
export const SALES_LIST_MAX_PAGE_SIZE = 100;

/**
 * What a history answer covers. The local SQLite holds this device's sales
 * only, so a local answer is always `this_device_only`: the screen must say
 * "this device only / incomplete store view" (RT-534 comment 12023).
 */
export type SalesHistoryCoverage = 'this_device_only';

// ── Refusal reason (closed enum — contract §"Refusal envelope") ──────────────

/**
 * The closed `reason` enum across all 008 sales.* + receipts.* handlers.
 * Per `contracts/bridge-api.md §"Refusal envelope"`. Adding a value here
 * requires also extending every exhaustive-switch consumer.
 *
 * The renderer translates each reason to **generic** copy (Constitution
 * §P11 — no factor-distinguishing variants). Per-reason diagnostic context
 * lives in the audit payload only.
 */
export const SALES_REFUSAL_REASONS = [
  'no_session',
  'role_denied',
  'tenant_isolation',
  'sale_not_found',
  'not_yet_printed',
  'idempotency_payload_mismatch',
  'printer_unavailable',
  'forbidden_field_in_request',
  // S1c.2 addition — mirrors 005's CartRefusalReason posture for the
  // sales.subscribe stub. The push-subscription primitive isn't yet
  // implemented; subscribe refuses with this reason until a follow-up
  // task lands the webContents.send + token registry.
  'not_implemented',
  // RT-541 `sales.list`: a malformed day, page size, cursor or key, or
  // to_day before from_day.
  'invalid_request',
  // RT-541 `sales.list`: more than SALES_LIST_MAX_SPAN_DAYS days (OD-534-4).
  'range_too_wide',
  // RT-542 `receipts.reprint`: the sale has a live void; OD-534-8 B allows no
  // unmarked duplicate of it.
  'sale_voided',
  // RT-1189 `sales.listRecent`: a request key other than `short_number`, or a
  // `short_number` that is not one to nine digits after normalisation.
  'invalid_input',
] as const;
export type SalesRefusalReason = (typeof SALES_REFUSAL_REASONS)[number];

// ── Finalization-internal refusal reason (main-side T091 vocabulary) ─────────

/**
 * Refusal reasons emitted by the AD-2 atomic finalize transaction
 * (`src/main/sales/finalize-transaction.ts`). These NEVER cross the bridge
 * to the renderer — they're audit-payload values only, recorded in the
 * `sale.finalization_refused` audit event per data-model.md §
 * "sale.finalization_refused payload".
 *
 * Distinct from `SALES_REFUSAL_REASONS` (above), which is the
 * bridge-handler refusal vocabulary visible to the renderer. The two
 * vocabularies are deliberately separate:
 *   • `SALES_REFUSAL_REASONS` covers session / role / tenant / not-found /
 *     reprint-precondition / IPC-input-defensive refusals — things the
 *     cashier sees as a generic refusal copy.
 *   • `SALE_FINALIZATION_REFUSAL_REASONS` covers source-006-attempt
 *     conditions + tender-summary forbidden-field hits — things the
 *     cashier never sees because the finalize is a background AD-2
 *     listener, not a renderer-initiated action.
 */
export const SALE_FINALIZATION_REFUSAL_REASONS = [
  'force_failed_attempt',
  'reversal_pending_line',
  'source_attempt_not_settled',
  'forbidden_field_in_tender_summary',
] as const;
export type SaleFinalizationRefusalReason = (typeof SALE_FINALIZATION_REFUSAL_REASONS)[number];

// ────────────────────────────────────────────────────────────────────────────
// 008-sale-finalization-and-receipts Slice 1: `sales.*` namespace (read-only)
// ────────────────────────────────────────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"Namespace: sales.* (read-only)"
//
// All handlers are gated server-side by `requireOperatorSession` (every
// 008 bridge handler MUST start with that call). No `idempotency_key` on
// any `sales.*` handler — they are read-only.
//
// Slice 1 lands these read handlers. Slice 2+ adds the mutating
// `receipts.*` namespace (preview, reprint, retryPrint, manualOverride).

/**
 * The shape returned by `sales.read` + `sales.findByNumber`. Strict subset
 * of the persisted `sales` row — main-only fields (envelope_handoff_action_id,
 * payment_attempt_id, envelope_cart_id, tenant_tax_registration_id) are
 * EXCLUDED per `contracts/bridge-api.md` §"Notes" + Constitution §P15.
 */
export interface SaleSummary {
  sale_id: SaleId;
  sale_number: SaleNumber;
  receipt_number: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  terminal_label: string;
  selling_operator_id: string;
  selling_operator_display_name: string;
  subtotal_minor: number;
  total_tax_minor: number;
  total_change_due_minor: number;
  tender_lines_summary: TenderLineSummary[];
  finalized_at: string;
  /** Latest PrintEvent projection (gates the reprint affordance per AD-10). */
  latest_print_event?: PrintEventSummary;
  /** Latest DrawerEvent projection (drives the drawer-failure banner). */
  latest_drawer_event?: DrawerEventSummary;
  /**
   * RT-541: the sale's recorded lines, or why they cannot be shown. Always set
   * by main; optional in the type only so older consumers and fixtures that
   * never read it keep compiling.
   */
  lines?: SaleLinesView;
}

// ── sales.read ──────────────────────────────────────────────────────────────

export interface SalesReadRequest {
  sale_id: SaleId;
}

export type SalesReadResponse =
  | { kind: 'ok'; sale: SaleSummary }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── sales.findByNumber ──────────────────────────────────────────────────────

export interface SalesFindByNumberRequest {
  sale_number: SaleNumber;
}

export type SalesFindByNumberResponse =
  | { kind: 'ok'; sale: SaleSummary }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── sales.subscribe / sales.unsubscribe ─────────────────────────────────────

/**
 * Subscription topic. `recent` emits compact summaries on every new
 * `sale.finalized` audit event for the current terminal. `banner_state`
 * emits the projected banner state on every new PrintEvent / DrawerEvent.
 */
export type SalesSubscribeTopic = 'recent' | 'banner_state';

export interface SalesSubscribeRequest {
  topic: SalesSubscribeTopic;
}

/**
 * Snapshot-subscribe (008 follow-up slice): `subscribe` returns the current
 * projection for the topic, exactly as 006's `subscribe ≡ read`. The renderer
 * POLLS this on an interval (no `webContents.send` push — consistent with the
 * deliberately poll-based AD-2 finalize design; see coordination §S3c
 * mechanism-corrected note). `subscription_token` is retained for `unsubscribe`
 * symmetry (additive per PRODUCT.md Principle 4 — extend, don't rename); the
 * snapshot field carried depends on the requested `topic`:
 *   • `topic='banner_state'` → `banner_state: BannerState`
 *   • `topic='recent'`       → `recent: RecentSaleSummary | null`
 */
export type SalesSubscribeResponse =
  | { kind: 'ok'; subscription_token: string; banner_state: BannerState }
  | { kind: 'ok'; subscription_token: string; recent: RecentSaleSummary | null }
  | { kind: 'refused'; reason: SalesRefusalReason };

export interface SalesUnsubscribeRequest {
  subscription_token: string;
}

export type SalesUnsubscribeResponse = { kind: 'ok' };

// ── sales.list (RT-541) ─────────────────────────────────────────────────────

/**
 * This device's sales over a range of store business days (Africa/Cairo),
 * newest first. A sale's day is its `finalized_at` in the store zone, never
 * the stored `local_calendar_day`. Tenant, branch, terminal and (for a
 * cashier, OD-534-1) the selling operator always come from the session.
 */
export interface SalesListRequest {
  /** First business day, `YYYY-MM-DD`, inclusive. */
  from_day: string;
  /** Last business day, `YYYY-MM-DD`, inclusive; at most 31 days after from. */
  to_day: string;
  /** 1-100; 50 when absent. */
  page_size?: number;
  /** `next_cursor` from the previous page; absent or null for page one. */
  cursor?: string | null;
}

/** One history row. Lines and tenders stay on the detail read. */
export interface SaleListItem {
  sale_id: SaleId;
  sale_number: SaleNumber;
  /**
   * The store business day of `finalized_at` (`YYYY-MM-DD`), or null when the
   * stored time cannot be read (shown as unknown, never guessed).
   */
  business_day: string | null;
  finalized_at: string;
  terminal_label: string;
  selling_operator_display_name: string;
  subtotal_minor: number;
  total_tax_minor: number;
}

export type SalesListResponse =
  | {
      kind: 'ok';
      sales: SaleListItem[];
      /** Opaque; null when this is the last page. */
      next_cursor: string | null;
      /** Always `this_device_only` for the local read. */
      coverage: SalesHistoryCoverage;
    }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── sales.listRecent (RT-1189, RT-249 N-S1) ─────────────────────────────────

/**
 * This terminal's sales on the current Africa/Cairo business day (main's
 * clock), newest first, local only, at most 300. Tenant, branch, terminal and
 * (for a cashier, OD-534-1) the selling operator always come from the session;
 * the request can name none of them. The one optional field is the short form.
 */
export interface SalesListRecentRequest {
  /**
   * A short form to look for (doc 20 §4): one to nine digits. Main normalises
   * Arabic-Indic digits and leading zeros; anything else is `invalid_input`.
   */
  short_number?: string;
}

/** One row of the recent list. No main-only id and no per-tender detail (§P15). */
export interface RecentSaleRow {
  sale_id: SaleId;
  /** The exact number, as printed on the receipt. */
  sale_number: SaleNumber;
  /** The sequence without leading zeros, or null when the number does not parse. */
  short_number: string | null;
  /** UTC ISO instant; the renderer formats it in the store zone. */
  finalized_at: string;
  /** `subtotal_minor + total_tax_minor`. */
  total_minor: number;
  tender_types: SalesTenderType[];
  selling_operator_display_name: string;
  /** The outcome of the newest print event, or `none` when there is none. */
  latest_print_outcome: PrintEventOutcome | 'none';
}

export type SalesListRecentResponse =
  | {
      kind: 'ok';
      /** The Cairo business day the list covers, `YYYY-MM-DD`. */
      business_day: string;
      items: RecentSaleRow[];
      /** True when more rows matched than the 300 returned. */
      truncated: boolean;
    }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── sales.readForHandoff (RT-1322, RT-249 N-S2) ─────────────────────────────

/**
 * Completion reads ITS OWN finalized sale (doc 20 §5.1). The key is the exact
 * UNIQUE `envelope_handoff_action_id` of the payment on screen plus its
 * `payment_attempt_id`; both are ids the renderer already holds. Main confirms
 * the attempt and the session's scope, so the answer can never be another sale.
 * The request carries no scope, role, operator or date.
 */
export interface SalesReadForHandoffRequest {
  handoff_action_id: string;
  payment_attempt_id: string;
}

export type SalesReadForHandoffResponse =
  | {
      kind: 'ok';
      /** The same projection as `sales.read`; it omits both ids of the key (§P15). */
      sale: SaleSummary;
      /** The sequence without leading zeros, or null when the number does not parse. */
      short_number: string | null;
    }
  /** No sale has finalized for this handoff yet. Not an error; ask again. */
  | { kind: 'pending' }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── SalesBridgeAPI surface ──────────────────────────────────────────────────

/**
 * 008-sale-finalization-and-receipts Slice 1 read-only bridge surface.
 *
 * Every handler is gated server-side by `requireOperatorSession`; no
 * renderer-side authorization is load-bearing (AD-1). Tenant / branch /
 * terminal scoping is derived from the operator session and enforced at
 * each handler entry per the §A4 8-item checklist (PR #257).
 */
export interface SalesBridgeAPI {
  /** Read a single sale by id. */
  read(req: SalesReadRequest): Promise<SalesReadResponse>;
  /** Lookup by cashier-quotable sale_number (tenant/branch/terminal-scoped). */
  findByNumber(req: SalesFindByNumberRequest): Promise<SalesFindByNumberResponse>;
  /** Subscribe to live updates on the current terminal's sales activity. */
  subscribe(req: SalesSubscribeRequest): Promise<SalesSubscribeResponse>;
  /** Detach a previously-acquired subscription. */
  unsubscribe(req: SalesUnsubscribeRequest): Promise<SalesUnsubscribeResponse>;
  /** RT-541: this device's sales over a range of store business days. */
  list(req: SalesListRequest): Promise<SalesListResponse>;
  /** RT-1189: this terminal's sales on the current Cairo business day. */
  listRecent(req: SalesListRecentRequest): Promise<SalesListRecentResponse>;
  /** RT-1322: Completion's own sale, by the exact handoff key plus the payment attempt. */
  readForHandoff(req: SalesReadForHandoffRequest): Promise<SalesReadForHandoffResponse>;
}
