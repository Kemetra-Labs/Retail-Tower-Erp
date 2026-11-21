/**
 * RT-530 — the sale-void bridge contract (`window.api.saleVoid`).
 *
 * A finalized sale is voided only with a bound RT-114 manager approval from a
 * different, store_manager-or-above person (never the requester, never the
 * sale's selling operator), on the sale's own business day (owner decisions,
 * Jira RT-530 comment 11988). The renderer asks main for an approval of the
 * exact sale (`approval.request`, action `sale.void`, subject = the local
 * `sale_id`), then spends the opaque `approval_id` here. Main binds it into a
 * durable journal row in one transaction and sends it later, under the
 * REQUESTER's own operator envelope only, when the sale has synced and that
 * operator is signed in online.
 *
 * The bridge carries totals, ids and closed codes only: no approver identity,
 * no `users.id`, no envelope, no PIN.
 */

export const SALE_VOID_IPC_CHANNELS = {
  LOOKUP: 'sale-void:lookup',
  REQUEST: 'sale-void:request',
  LIST: 'sale-void:list',
  ACKNOWLEDGE: 'sale-void:acknowledge',
  /** RT-1403 S2: hand the cash of a CONFIRMED void out of the drawer, once. */
  PAY_OUT: 'sale-void:pay-out',
  /** RT-1403 S2: record cash that left the drawer outside the gate (manager-attested, once). */
  CASH_EXCEPTION: 'sale-void:cash-exception',
} as const;

/** The journal states (migration 0054). `refused` and `confirmed` are final. */
export const SALE_VOID_STATES = ['pending', 'unknown', 'confirmed', 'refused'] as const;
export type SaleVoidState = (typeof SALE_VOID_STATES)[number];

/**
 * Why a void was refused BY BACKEND-CORE (the closed set of the contract's
 * `void_*` codes plus the generic statuses). Terminal: the void is not
 * retried.
 */
export const SERVER_VOID_REFUSALS = [
  'void_approval_required',
  'void_approval_invalid',
  'void_outside_business_day',
  'void_requester_mismatch',
  'void_requester_not_eligible',
  'void_self_approval',
  'void_approver_not_eligible',
  'already_reversed',
  'sale_not_found',
  'conflict',
  'validation_error',
] as const;
export type ServerVoidRefusal = (typeof SERVER_VOID_REFUSALS)[number];

/** Why main refused to take a void request or a lookup (nothing journaled). */
export const LOCAL_VOID_REFUSALS = [
  'feature_disabled',
  'no_session',
  'session_locked',
  'invalid_input',
  /** No sale of this terminal has that number. */
  'sale_not_found',
  /**
   * RT-741: a cashier asked for another operator's sale (the shared RT-546
   * gate), or the session's role is not allowed. Nothing else is answered.
   */
  'role_denied',
  /** The sale's business day has passed: use a return. */
  'not_same_day',
  /** The sale already has a live void (requested, sent or confirmed). */
  'already_voided',
  /** The sale has a return (any state but a refused one). */
  'has_return',
  /** This session holds no operator envelope, so it could never send the void. */
  'no_operator_envelope',
  /** The approval did not hold (used, expired, another sale, or the sale changed). */
  'approval_invalid',
  'approval_stale',
  'void_unavailable',
  /**
   * RT-1403 S2 (RT-530 c12022, c12028): why the cash of a void is NOT paid out. No cash leaves on
   * a request alone: the void must be confirmed by Backend-Core, inside an open shift, on the
   * void's business day and in the shift that was already open when it was requested.
   */
  'payout_void_not_confirmed',
  'payout_void_refused',
  'payout_no_cash',
  'payout_no_open_shift',
  'payout_wrong_day',
  'payout_other_shift',
  /** The cash of this sale already has its record (a payout or an exception): never twice. */
  'payout_already_recorded',
  /**
   * The drawer was kicked but the payout is not recorded (it did not open, or answered unknown):
   * the payout stays claimed; only a retry (a kick that provably never left) or a manager's manual
   * completion remains.
   */
  'payout_drawer_failed',
  'payout_in_progress',
  /** RT-1403 S2 (H1): the payout was already started for this void; complete it, never start again. */
  'payout_started',
  'payout_not_started',
  /** The last kick may have opened the drawer: only the manager's manual completion remains. */
  'payout_drawer_retry_unsafe',
  /** A kick is still in flight: wait for it. */
  'payout_drawer_in_progress',
  /** RT-1403 S2 (M1): another payout (a return's or a void's) holds the terminal's one drawer. */
  'another_payout_in_progress',
] as const;
export type LocalVoidRefusal = (typeof LOCAL_VOID_REFUSALS)[number];

export type SaleVoidRefusalReason = ServerVoidRefusal | LocalVoidRefusal;

export interface SaleVoidRefused {
  kind: 'refused';
  reason: LocalVoidRefusal;
}

/** What a queued void is waiting for (derived live; never stored). */
export const SALE_VOID_WAITING_FOR = [
  /** The sale has not synced to Backend-Core yet, so it has no server reference. */
  'sale_sync',
  /** Only the requester's own envelope may send it: they are not signed in online. */
  'requester_sign_in',
] as const;
export type SaleVoidWaitingFor = (typeof SALE_VOID_WAITING_FOR)[number];

export interface SaleVoidLookupRequest {
  /** The local sale number printed on the receipt (`<terminal>-<day>-<seq>`). */
  sale_number: string;
}

/** The sale found by number, and whether (and why not) it can be voided now. */
export interface SaleVoidSaleView {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
  total_minor: number;
  /** Net cash taken in this sale (what a void takes back out of the drawer). */
  cash_minor: number;
  selling_operator_display_name: string;
  /** Null when the sale can be voided now. */
  ineligible: Extract<LocalVoidRefusal, 'not_same_day' | 'already_voided' | 'has_return'> | null;
}

export type SaleVoidLookupResponse = { kind: 'sale'; sale: SaleVoidSaleView } | SaleVoidRefused;

export interface SaleVoidRequest {
  sale_id: string;
  /** The opaque single-use `approval_id` from `approval.request` (action `sale.void`). */
  approval_id: string;
}

export type SaleVoidRequestResponse =
  | { kind: 'requested'; void: SaleVoidJournalView }
  | SaleVoidRefused;

export interface SaleVoidAcknowledgeRequest {
  void_id: string;
}

export type SaleVoidAcknowledgeResponse = { kind: 'acknowledged' } | SaleVoidRefused;

/** Why a CONFIRMED void's cash cannot be paid out right now (the live payout gate). */
export type SaleVoidPayoutBlock = Extract<
  LocalVoidRefusal,
  'payout_no_open_shift' | 'payout_wrong_day' | 'payout_other_shift' | 'payout_already_recorded'
>;

/**
 * Why a recorded cash exception is flagged for manager reconciliation: the cash and the
 * accounting status disagree (RT-530 c12022 item 6).
 */
export const SALE_VOID_MISMATCH_REASONS = [
  /** Cash left although Backend-Core refused the void. */
  'void_refused',
  /** Cash left although Backend-Core has not answered (pending or unknown). */
  'void_unconfirmed',
  /** The void is confirmed, but the cash left outside its day or shift window. */
  'payout_window_closed',
] as const;
export type SaleVoidMismatchReason = (typeof SALE_VOID_MISMATCH_REASONS)[number];

/** What a manager may still do to a claimed payout (RT-15's pattern). */
const SALE_VOID_CLAIM_ACTIONS = ['retry_drawer', 'manual'] as const;
export type SaleVoidClaimAction = (typeof SALE_VOID_CLAIM_ACTIONS)[number];

/** The payout step a request asks for: the first one, or a step of a claimed payout. */
export const SALE_VOID_PAYOUT_ACTIONS = ['start', ...SALE_VOID_CLAIM_ACTIONS] as const;
export type SaleVoidPayoutAction = (typeof SALE_VOID_PAYOUT_ACTIONS)[number];

/** The cash of a void, as the renderer sees it. */
export interface SaleVoidPayoutView {
  /**
   * `none`: no cash has left; `claimed`: the payout was started and the drawer may be open (no
   * record yet); `paid_out`: the gated payout; `exception`: manager-attested.
   */
  state: 'none' | 'claimed' | 'paid_out' | 'exception';
  /** Set only on a `claimed` payout: the steps a manager may still take. */
  claim_actions: readonly SaleVoidClaimAction[];
  /**
   * A confirmed void with cash that was never paid out and whose payout window (day or shift) has
   * passed: flagged for the manager (audit only; no stored flag).
   */
  overdue: boolean;
  paid_at: string | null;
  /** Set only on an exception that disagrees with the accounting status. */
  mismatch_reason: SaleVoidMismatchReason | null;
  /**
   * Set only while `state` is `none` on a confirmed void with cash: why it cannot be paid out
   * now. Null on such a void means the payout is available.
   */
  blocked_reason: SaleVoidPayoutBlock | null;
}

/** One journal row as the renderer sees it. */
export interface SaleVoidJournalView {
  void_id: string;
  sale_number: string;
  total_minor: number;
  requested_at: string;
  state: SaleVoidState;
  /** Display name of the operator who requested it (the only one who can send it). */
  requester_display_name: string;
  /** Set only on a `pending` / `unknown` row that cannot be sent right now. */
  waiting_for: SaleVoidWaitingFor | null;
  /** Set only on a `refused` row. */
  refusal_reason: ServerVoidRefusal | null;
  /** A refused row staff have not acknowledged yet (drives the banner). */
  needs_attention: boolean;
  confirmed_at: string | null;
  /** The net cash of the voided sale: what a payout hands back (0: nothing to pay out). */
  cash_minor: number;
  payout: SaleVoidPayoutView;
}

export interface SaleVoidListView {
  kind: 'list';
  voids: SaleVoidJournalView[];
}

export type SaleVoidListResponse = SaleVoidListView | SaleVoidRefused;

/**
 * RT-1403 S2: pay out the cash of a confirmed void (the amount is the journal's, never sent). A
 * manager or admin acts; `start` claims the payout and kicks the drawer, `retry_drawer` and `manual`
 * complete a claimed one (RT-15's pattern).
 */
export interface SaleVoidPayOutRequest {
  void_id: string;
  action: SaleVoidPayoutAction;
}

/** A refused payout; `drawer_may_be_open` when the drawer was kicked first (never hand the cash over). */
type SaleVoidPayOutRefused = SaleVoidRefused & { drawer_may_be_open?: true };

export type SaleVoidPayOutResponse = { kind: 'paid_out' } | SaleVoidPayOutRefused;

/**
 * RT-1403 S2: record cash that left the drawer outside the payout gate. `approval_id` is the
 * single-use RT-114 approval (action `sale.void_cash_exception`, subject = the void) of a
 * manager other than the requester.
 */
export interface SaleVoidCashExceptionRequest {
  void_id: string;
  approval_id: string;
}

export type SaleVoidCashExceptionResponse =
  | { kind: 'exception_recorded'; mismatch_reason: SaleVoidMismatchReason | null }
  | SaleVoidRefused;

export interface SaleVoidBridgeAPI {
  lookup(req: SaleVoidLookupRequest): Promise<SaleVoidLookupResponse>;
  request(req: SaleVoidRequest): Promise<SaleVoidRequestResponse>;
  list(): Promise<SaleVoidListResponse>;
  acknowledge(req: SaleVoidAcknowledgeRequest): Promise<SaleVoidAcknowledgeResponse>;
  payOut(req: SaleVoidPayOutRequest): Promise<SaleVoidPayOutResponse>;
  recordCashException(req: SaleVoidCashExceptionRequest): Promise<SaleVoidCashExceptionResponse>;
}
