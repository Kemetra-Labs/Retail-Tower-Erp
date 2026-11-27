// Canonical source of truth from T022 onward. specs/001-foundation/contracts/preload-bridge.ts
// is a planning snapshot and is NOT re-synced after this file exists.
import type { LogRecord } from './log-record.js';
import type { AppConfig } from './app-config.js';
import type { RendererErrorReport } from './renderer-error-report.js';
import type { AvailabilityBridgeAPI } from './availability/types.js';
import type { ReturnsBridgeAPI } from './returns/types.js';
import type { ShiftCashupBridgeAPI } from './shift-cashup/types.js';
import type { ManagerApprovalBridgeAPI } from './operator/manager-approval.js';
import type { RecoveryBridgeAPI } from './operator/recovery.js';
import type { SaleVoidBridgeAPI } from './sale-void/types.js';
import type { SaleHistoryBridgeAPI } from './sale-history/types.js';
import type { TerminalStatusSnapshot } from './terminal-status/types.js';
import type { UpdateStatusSnapshot } from './update-status/types.js';
import type { BrandingSnapshot } from './branding/types.js';
import type { PrinterBridgeAPI } from './printer/types.js';

export type {
  ReturnJournalView,
  ReturnLineInput,
  ReturnQuoteView,
  ReturnableSaleView,
  ReturnsBridgeAPI,
  ReturnsListResponse,
  ReturnsLookupRequest,
  ReturnsLookupResponse,
  ReturnsQuoteRequest,
  ReturnsQuoteResponse,
  ReturnsRefusalReason,
  ReturnsResolveResponse,
  ReturnsSubmitRequest,
  ReturnsSubmitResponse,
} from './returns/types.js';
import type { PairingBridgeAPI } from './pairing-types.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI, VouchersBridgeAPI } from './payments/types.js';
import type { SalesBridgeAPI } from './sales/types.js';
import type { ReceiptsBridgeAPI } from './receipts/types.js';
import type { CartBridgeAPI } from './cart/bridge-types.js';
import type { CatalogueBridgeAPI } from './catalogue/types.js';
import type { OperatorBridgeAPI } from './operator/types.js';

export type { PairingBridgeAPI } from './pairing-types.js';
export type {
  PaymentsBridgeAPI,
  PaymentsCancelRequest,
  PaymentsCancelResponse,
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsForceFailRequest,
  PaymentsForceFailResponse,
  PaymentsReadRequest,
  PaymentsReadResponse,
  PaymentsStartRequest,
  PaymentsStartResponse,
  PaymentsSubscribeRequest,
  PaymentsSubscribeResponse,
  TenderApplyRequest,
  TenderApplyResponse,
  TenderBridgeAPI,
  TenderReadRequest,
  TenderReadResponse,
  TenderReverseRequest,
  TenderReverseResponse,
  VouchersBridgeAPI,
  VouchersValidateRequest,
  VouchersValidateResponse,
} from './payments/types.js';
export type {
  RecentSaleRow,
  SaleListItem,
  SaleSummary,
  SalesBridgeAPI,
  SalesFindByNumberRequest,
  SalesFindByNumberResponse,
  SalesListRecentRequest,
  SalesListRecentResponse,
  SalesListRequest,
  SalesListResponse,
  SalesReadForHandoffRequest,
  SalesReadForHandoffResponse,
  SalesReadRequest,
  SalesReadResponse,
  SalesSubscribeRequest,
  SalesSubscribeResponse,
  SalesUnsubscribeRequest,
  SalesUnsubscribeResponse,
} from './sales/types.js';
export type {
  ReceiptsBridgeAPI,
  ReceiptsManualOverrideRequest,
  ReceiptsManualOverrideResponse,
  ReceiptsPreviewRequest,
  ReceiptsPreviewResponse,
  ReceiptsReprintRequest,
  ReceiptsReprintResponse,
  ReceiptsRetryPrintRequest,
  ReceiptsRetryPrintResponse,
} from './receipts/types.js';
export type { CartBridgeAPI } from './cart/bridge-types.js';
export type {
  CatalogueBridgeAPI,
  CatalogueCountsRequest,
  CatalogueCountsResponse,
  CatalogueFreshnessRequest,
  CatalogueFreshnessResponse,
  CatalogueLookupBarcodeRequest,
  CatalogueLookupResponse,
  CatalogueLookupSkuRequest,
  CatalogueRefreshRequest,
  CatalogueRefreshResponse,
  CatalogueRefusalReason,
  CatalogueResolveRequest,
  CatalogueResolveResponse,
  CatalogueSearchRequest,
  CatalogueSearchResponse,
} from './catalogue/types.js';
export type {
  BranchRosterCashier,
  CancelTakeoverRequest,
  CancelTakeoverResponse,
  CashierPinState,
  CashierPinStatus,
  CashierSignInRequest,
  ConfirmTakeoverRequest,
  ConfirmTakeoverResponse,
  EmitAuditEventRequest,
  EmitAuditEventResponse,
  ForceCloseShiftRequest,
  ForceCloseShiftResponse,
  ListBranchRosterResponse,
  ListCashierPinStatusRefusalCategory,
  ListCashierPinStatusResponse,
  ListStuckShiftsResponse,
  LockStateSummary,
  LockStateView,
  ManagerAdminSignInRequest,
  OperatorBridgeAPI,
  OperatorSessionBridgeView,
  ProvisionCashierPinRequest,
  ProvisionCashierPinResponse,
  ReauthenticateRequest,
  ReauthenticateResponse,
  ResetCashierPinRequest,
  ResetCashierPinResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
  ResumeStateView,
  SessionLockCause,
  SessionStateEvent,
  SignInRequest,
  SignInResponse,
  SignInSuccessResponse,
  SignOutResponse,
  StuckShiftSummary,
  TakeoverRequiredResponse,
  UnlockCashierRequest,
  UnlockCashierResponse,
  UnlockSessionRequest,
  UnlockSessionResponse,
} from './operator/types.js';

export interface PreloadBridgeAPI {
  ping(): Promise<'pong'>;
  appVersion(): Promise<string>;
  /**
   * Phase 8 / US6: ship a structured log record to the main-process
   * logger. Sandboxed renderers cannot write files directly; this is
   * the only path from renderer code to the on-disk log stream.
   * Resolves on successful enqueue; never rejects with a value the
   * caller is expected to surface — logging must not crash the app.
   */
  log(record: LogRecord): Promise<void>;
  /**
   * Phase 9 / US7: pull renderer-relevant runtime configuration from
   * main (the feature flags). Sandboxed renderers cannot read
   * `process.env`, and `import.meta.env.VITE_*` would inline values into
   * the bundle at build time, so config crosses the typed bridge (D3).
   * RT-634: the Sentry DSN no longer crosses it at all.
   */
  appConfig(): Promise<AppConfig>;
  /**
   * RT-634 (OBS-5): report an uncaught renderer error or unhandled
   * rejection to main (`app:report-error`). Main validates, caps,
   * rate-limits and scrubs it (OBS-1 allowlist) before Sentry, or drops it
   * when Sentry is not configured. Fire-and-forget: always resolves.
   */
  reportError(report: RendererErrorReport): Promise<void>;
  /**
   * 002-terminal-pairing: terminal-pairing namespace. Interface-only at
   * the foundational layer; the preload stub throws "not implemented"
   * until US1 / US2 wire the real handlers.
   */
  pairing: PairingBridgeAPI;
  /**
   * 004-operator-session: operator-session namespace. S1 wires the
   * manager/admin Clerk path; cashier-PIN, takeover-confirm, roster,
   * audit-event-emit, and PIN management are §A1-gated and land
   * later.
   */
  operator: OperatorBridgeAPI;
  /**
   * 005-sales-cart: cart namespace. Phase 2 provides typed stubs only;
   * all handlers return refused/not_implemented until S1 wires real
   * main-process logic.
   */
  cart: CartBridgeAPI;
  /**
   * 006-payments-tender Slice 3: `payments.*` (attempt-level) +
   * `tender.*` (per-line) namespaces. `vouchers.*` is Wave 4 (voucher validate
   * path). RT-1232: `payments.forceFail` is not on the bridge.
   *
   * Marked optional in S3b — the namespace types are declared but the
   * preload (`src/preload/index.ts`) is wired in S3c (T142). Once S3c
   * lands, callers that need a guarantee can narrow with the
   * non-null-assertion operator or a runtime presence check. The
   * Slice-3 renderer wiring (T150–T154) is the only consumer and lands
   * in S3d after S3c is GREEN.
   */
  payments?: PaymentsBridgeAPI;
  tender?: TenderBridgeAPI;
  /** 006 Wave 4 — voucher validate (per §A4-B authorisation 2026-05-25). */
  vouchers?: VouchersBridgeAPI;
  /**
   * 008-sale-finalization-and-receipts Slice 1: `sales.*` (read-only)
   * namespace. Slice 2+ adds `receipts.*` (mutating).
   *
   * Marked optional in S1b — the namespace types are declared here but
   * the preload (`src/preload/index.ts`) is wired in S1d (T100/T101).
   * Once S1d lands, callers that need a guarantee can narrow with the
   * non-null-assertion operator or a runtime presence check. The
   * Slice-1 renderer is read-only (no UI mounted by Slice 1 itself;
   * S1 surfaces are consumed by Slice 2 onwards).
   */
  sales?: SalesBridgeAPI;
  /**
   * 008-sale-finalization-and-receipts Slice 2: `receipts.*` (mutating)
   * namespace. S2 exposes `receipts.preview` only (read-only render); the
   * genuinely-mutating members join in Slices 3 / 5 / 6. Optional for the
   * same staged-wiring reason as `sales` above.
   */
  receipts?: ReceiptsBridgeAPI;
  /**
   * 009-product-search-and-barcode-lookup Slice S1: read-only `catalogue.*`
   * namespace (lookupBarcode / lookupSku / search / resolve). Wired into the
   * preload in S1 (T016); session-gated main-side (NFR-6a). Optional for the
   * same staged-wiring reason as `sales`/`receipts` — S1 ships a gated skeleton
   * (handlers return `catalogue_unavailable` until the read model lands in S2).
   */
  catalogue?: CatalogueBridgeAPI;
  /**
   * RT-1578 (RT-1511 S3, spec 013): read-only `availability.*` namespace (status / bands / refresh).
   * Band and freshness only; never a number, never a stock write. Session-gated main-side.
   */
  availability?: AvailabilityBridgeAPI;

  /**
   * 011-sale-sync-capture-up: READ-ONLY sale-sync status namespace. A single
   * channel (`sales:syncStatus`) exposing pending / dead-letter counts + the
   * last-success timestamp. The renderer can OBSERVE sync health but can never
   * trigger or mutate the drain (the engine runs in the main process; §A4 / P8 /
   * WR-1). Optional for the same staged-wiring reason as the namespaces above.
   */
  salesSync?: SalesSyncBridgeAPI;

  /**
   * RT-15 S2: the cashier return flow (`returns.*`). Main-process gated on
   * `POS_PULSE_FEATURE_RETURNS` (default on since RT-1180), an operator session and the
   * manager/admin role; refused while the session is locked. Optional for the
   * same staged-wiring reason as the namespaces above (the renderer flow is S3).
   */
  returns?: ReturnsBridgeAPI;

  /**
   * RT-17 slice 4: the shift cash-up (`shiftCashup.*`). Registered in main only
   * with `POS_PULSE_FEATURE_SHIFT_CASHUP` on (default off); gated there on the
   * flag and an unlocked operator session; refused while the session is
   * locked. Nothing that reveals the expected cash crosses it (blind count).
   * Optional for the same staged-wiring reason as the namespaces above.
   */
  shiftCashup?: ShiftCashupBridgeAPI;

  /**
   * RT-443 (MA-2): credential-backed manager approvals (`approval.*`). The
   * renderer names an approver by the opaque handle from `listApprovers` and
   * carries that manager's PIN inward; main answers an opaque single-use
   * `approval_id` that the action then carries. No approver identity crosses
   * back. Refused while the session is locked.
   */
  approval?: ManagerApprovalBridgeAPI;
  /**
   * RT-441 (RT-116 §5): manager recovery (`recovery.*`) — clear this
   * terminal's stuck payment or another operator's held sale. Manager / admin
   * only, each action with its own approval; totals and opaque ids only.
   */
  recovery?: RecoveryBridgeAPI;
  /**
   * RT-530: manager-approved sale void (`saleVoid.*`) — find a finalized sale,
   * void it with a bound manager approval, and see the queued voids (and any
   * Backend-Core refused). Totals, ids and closed codes only.
   */
  saleVoid?: SaleVoidBridgeAPI;
  /**
   * RT-542: the store-wide sales history, sale detail and reprint through
   * Backend-Core (`saleHistory.*`). OD-534-1/2 enforced in main.
   */
  saleHistory?: SaleHistoryBridgeAPI;

  /**
   * RT-603 (VN-S6 S6-2): the terminal's connection and sale-sync status
   * (`terminalStatus:get` + the `terminalStatus:changed` push). Read-only;
   * closed-set codes, counts and ISO times only. Answered while unpaired, not
   * session-gated, refused while the session is locked (D-6-10).
   */
  terminalStatus?: TerminalStatusBridgeAPI;

  /**
   * RT-322 (S-B): the updater's status (`updateStatus:get` + the
   * `updateStatus:changed` push). Read-only; a closed-set state, a plain
   * version, closed-set blockers and a short machine code only. No install
   * trigger and no channel or origin setter.
   */
  updateStatus?: UpdateStatusBridgeAPI;

  /**
   * RT-886 (RT-839 S1): the receipt printer choice (`printer.*`): list the
   * installed Windows printers, read and save the choice, send a test page.
   * Any signed-in role; main checks for a live, unlocked session on every call.
   * Printer names and closed codes only.
   */
  printer?: PrinterBridgeAPI;

  /**
   * RT-475: the tenant branding for the boot, pairing, sign-in and lock slots
   * (`branding:get` + the `branding:changed` push). Read-only; from the local
   * cache; PNG data URIs, a bounded name and sizes only. Answered with no
   * session and while locked.
   */
  branding?: BrandingBridgeAPI;
}

/**
 * RT-475: typed read-only `branding.*` namespace. No write channel exists.
 * Both members deliver only a preload-validated snapshot.
 */
export interface BrandingBridgeAPI {
  /** Rejects (`branding_unavailable`) on a refusal or malformed answer. */
  get(): Promise<BrandingSnapshot>;
  /** Subscribe to the push; returns the unsubscribe. */
  onChanged(cb: (snapshot: BrandingSnapshot) => void): () => void;
}

/**
 * RT-322 (S-B): typed read-only `updateStatus.*` namespace. No write channel
 * exists. Both members deliver only a preload-validated snapshot.
 */
export interface UpdateStatusBridgeAPI {
  /** Rejects (`update_status_unavailable`) on a refusal or malformed answer. */
  get(): Promise<UpdateStatusSnapshot>;
  /** Subscribe to the push; returns the unsubscribe. */
  onChanged(cb: (snapshot: UpdateStatusSnapshot) => void): () => void;
}

/**
 * RT-603 (VN-S6 S6-2): typed read-only `terminalStatus.*` namespace. No write
 * channel exists. Both members deliver only a preload-validated snapshot.
 */
export interface TerminalStatusBridgeAPI {
  /** Rejects (`terminal_status_unavailable`) on a refusal or malformed answer. */
  get(): Promise<TerminalStatusSnapshot>;
  /** Subscribe to the coalesced push (≤ 1/s); returns the unsubscribe. */
  onChanged(cb: (snapshot: TerminalStatusSnapshot) => void): () => void;
}

/**
 * 011-sale-sync-capture-up: typed read-only `salesSync.*` namespace. No write
 * channel exists. The response carries counts + one timestamp + one closed-set
 * paused code only — no token, PII, or raw error (P7).
 */
export interface SalesSyncBridgeAPI {
  syncStatus(): Promise<SaleSyncStatusResponse>;
}

/** The read-only sync-status payload (mirrors main `SaleSyncStatusSnapshot`). */
export interface SaleSyncStatusResponse {
  /** Unsent sales of the current terminal (RT-221). */
  pending: number;
  /**
   * RT-221: unsent sales queued under an earlier pairing of this terminal (a
   * different `terminal_id`). Held — never sent under the new device identity.
   */
  heldPreviousPairing: number;
  /** Every dead-lettered sale, payload divergences included. */
  deadLetter: number;
  /** RT-190: dead-lettered sales whose capture answered 409 (payload divergence). */
  payloadDivergence: number;
  lastSuccessAt: string | null;
  /**
   * RT-224: why the sale-sync drain cannot send right now, as a closed-set code;
   * null when it can. `no_operator_credential` = the current session holds no sale
   * credential (no session, or a cashier session — RT-224), so sales stay pending.
   * Additive: the fields above keep their meaning.
   */
  paused: 'no_operator_credential' | null;
  /**
   * RT-856: the pending sales held from sync, with a closed-set reason; null when
   * none is held. `discount_capture_unavailable` = a manually discounted sale,
   * held (still pending, never dead-lettered) until the capture path can send it.
   * Since RT-858 that is only a discount with no recorded approver role, which
   * `sales.yaml` requires. A subset of `pending`. Additive: the fields above keep
   * their meaning.
   */
  held: { reason: 'discount_capture_unavailable'; count: number } | null;
}

declare global {
  interface Window {
    api: PreloadBridgeAPI;
  }
}
