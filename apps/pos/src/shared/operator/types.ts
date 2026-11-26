// RT-1222: the `operator.*` bridge types, moved verbatim out of bridge-api.ts.
import type { OperatorRefusal } from '../audit/event-shape.js';
import type { ForcedCloseReason } from '../audit/payload-schemas.js';
import type { Role } from './role.js';

/**
 * T048 — `operator.emitAuditEvent` bridge surface.
 *
 * The renderer supplies only the fields it owns. Trusted enrichment
 * (acting_operator_id, tenant_id, branch_id, originating_terminal_id,
 * session_id, created_at) is applied by the main-process handler
 * from SessionManager and PairingStore — these MUST NOT cross the
 * renderer→main direction (FR-013 / Constitution VII).
 *
 * `action_category` is typed as `string` here (not `ActionCategory`)
 * so the preload layer remains forward-compatible if new categories
 * are added to the server contract before a client rebuild. The
 * main-process handler validates it at the AuditEmitter boundary.
 */
export interface EmitAuditEventRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Closed-set action category (validated main-side). */
  action_category: string;
  /** Shift id; omit for non-shift-scoped categories. */
  shift_id?: string;
  /** Optional second identity for supervisor-approved actions. */
  approving_supervisor_id?: string;
  /** Per-category structured payload. Forbidden keys refused main-side. */
  payload: Record<string, unknown>;
}

export interface EmitAuditEventResponse {
  kind: 'emitted';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  event_id: string;
}

/**
 * 004-operator-session T014 — `operator.*` namespace skeleton.
 *
 * Per `specs/004-operator-session/contracts/bridge-api.md`. S1 wires
 * only the manager/admin Clerk path; cashier-PIN, takeover-confirm,
 * roster, audit-event-emit, and PIN management are §A1-gated and land
 * in S3/S4. Their typed signatures are intentionally absent here —
 * a future task adds them rather than adding stubs that throw
 * "not implemented" (a stub is a contract claim that the call exists,
 * which is misleading when the gate is closed).
 */

export interface OperatorSessionBridgeView {
  /** Operator session id (UUID v4). */
  id: string;
  /** Clerk user id of the operator. */
  operator_id: string;
  /** Display name as held by Clerk. */
  display_name: string;
  /** Closed-set role from Clerk metadata. */
  role: Role;
  /** Opaque tenant identifier from the device-token scope. */
  tenant_id: string;
  /** Opaque branch identifier from the device-token scope. */
  branch_id: string;
  /** ISO 8601 UTC timestamp the session was issued. */
  started_at: string;
}

/**
 * RT-117 (RT-116 §2.4) — same-operator unlock of the CURRENT locked session.
 * Cashier sessions use `pin`; manager/admin sessions use the interim online
 * credential re-auth (owner decision Z3; replaced by the RT-114 credential).
 * Secrets in these requests are consumed by main and never logged (P11).
 */
export type UnlockSessionRequest =
  | { method: 'pin'; pin: string }
  | { method: 'online_credential'; identifier: string; password: string };

export type UnlockSessionResponse = { kind: 'unlocked' } | OperatorRefusal;

/**
 * RT-358 (RT-247 D-A1) — the signed-in manager proves their credentials again
 * after a `reauth_required` refusal. The fresh JWT stays in main; the renderer
 * only learns that it worked.
 */
export interface ReauthenticateRequest {
  identifier: string;
  password: string;
}

export type ReauthenticateResponse = { kind: 'reauthenticated' } | OperatorRefusal;

/**
 * RT-117 (RT-116 §7.2) — the only read served while locked. Totals only:
 * no line items, no names, no credentials. `summary` is null when the
 * session has no open cart.
 */
export interface LockStateSummary {
  line_count: number;
  total_minor: number;
  tender_applied_minor: number;
  has_live_tender: boolean;
}

export interface LockStateView {
  state: 'active' | 'locked' | 'signed_out';
  locked_at: string | null;
  /** Role of the locked session, so the lock screen offers the right unlock form. */
  role: Role | null;
  display_name: string | null;
  summary: LockStateSummary | null;
}

/** RT-117 — main → renderer push payload on `operator:session-state`. */
export interface SessionStateEvent {
  state: 'active' | 'locked' | 'ended';
}

/**
 * RT-352 (RT-116 §7.2) — what the signed-in operator resumes. Ids and a count
 * only: no line items, names or amounts.
 */
export interface ResumeStateView {
  /**
   * The cart re-attached to the current session at sign-in, if any: a draft,
   * or (RT-442) a handed-off cart whose sale is still open.
   */
  cart_id: string | null;
  /**
   * RT-442 (RT-116 S5) — the started payment attempt bound to this session:
   * the stuck attempt re-attached at sign-in. Checkout resumes it; an opaque
   * id, nothing about its tender.
   */
  payment_attempt_id: string | null;
  /** Further held carts this operator has on this terminal that were not re-attached. */
  other_held_cart_count: number;
}

export interface SignInSuccessResponse {
  kind: 'signed_in';
  session: OperatorSessionBridgeView;
  /** T091 — present when the cashier's most recent shift was force-closed and the notice was not yet dismissed. */
  forced_close_notice?: { closed_at: string };
}

export interface TakeoverRequiredResponse {
  kind: 'takeover_required';
  // No identification of the prior terminal/operator/timestamp (FR-013).
  /**
   * Capability token for the pending takeover. Must be supplied to
   * `confirmTakeover` or `cancelTakeover`. Expires after 60 seconds.
   * Opaque to the renderer — do not inspect or log its value (PR-1).
   */
  pending_takeover_id: string;
}

/**
 * T070 — request to confirm a pending takeover.
 * The renderer supplies only the capability token; all session material
 * comes from the main-process proto-session store (FR-013 / PR-1).
 */
export interface ConfirmTakeoverRequest {
  pending_takeover_id: string;
}

export type ConfirmTakeoverResponse = SignInSuccessResponse;

/**
 * T071 — request to cancel a pending takeover.
 */
export interface CancelTakeoverRequest {
  pending_takeover_id: string;
}

export interface CancelTakeoverResponse {
  kind: 'cancelled';
}

/**
 * T072 — manager/admin PIN reset for a cashier on this terminal (§A1-gated).
 *
 * `new_pin` crosses the bridge ONCE on input and is consumed by the
 * main-process handler. It MUST NOT be persisted, logged, snapshotted,
 * or surfaced in any thrown error (PR-1). 4–6 digit constraint is
 * validated main-side; invalid shape returns `invalid_input` refusal.
 */
export interface ResetCashierPinRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Clerk user id of the cashier whose PIN is being reset. */
  target_cashier_id: string;
  /** Plaintext 4–6 digit PIN — consumed by the main-process verifier, never persisted or logged. */
  new_pin: string;
}

export interface ResetCashierPinResponse {
  kind: 'pin_reset';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * 019-cashier-pin-provisioning — manager/admin FIRST-PIN provisioning for a
 * cashier on this terminal. Distinct from reset (which changes an existing
 * PIN): provisioning CREATES the row where none exists, born keyed on the
 * provider-neutral `user_id` (028 §16), never the Clerk subject. The renderer
 * names the cashier by the roster `id` it already holds (RT-235); main resolves
 * the neutral `user_id` from the manager roster and it never crosses the
 * bridge (Constitution VII). Create-only:
 * refuses (`state_invalid`) if any row already exists (incl. a legacy
 * clerk-keyed one). Refuses `not_ready` when the roster carries no `user_id`
 * yet (FR-11) — never falls back to a provider-coupled key. Validated
 * main-side; invalid shape returns `invalid_input`.
 */
export interface ProvisionCashierPinRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /**
   * The cashier to provision, by the roster `id` the renderer already holds
   * (the provider subject / session `operator_id`, as in reset and unlock).
   * Main maps it to the PROVIDER-NEUTRAL `user_id` (028 §16 = DP-2 `users.id`)
   * delivered on the manager roster entry; that key never crosses the bridge.
   */
  target_cashier_id: string;
  /** Plaintext 4–6 digit PIN — consumed by the main-process verifier, never persisted or logged. */
  initial_pin: string;
}

export interface ProvisionCashierPinResponse {
  kind: 'pin_provisioned';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * T073 — manager/admin unlock of a locked-out cashier on this terminal (§A1-gated).
 *
 * This call MUST NOT accept any PIN field — it only clears lockout state.
 */
export interface UnlockCashierRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Clerk user id of the locked-out cashier. */
  target_cashier_id: string;
}

export interface UnlockCashierResponse {
  kind: 'unlocked';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * T089 — manager/admin forced-close of a stuck cashier shift.
 *
 * `event_id` is the caller-generated UUID v4 idempotency key.
 * `declared_count` is intentionally absent — forced-close always leaves it
 * NULL (FR-024(a) blind-close / absent state).
 */
export interface ForceCloseShiftRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Local shift id to force-close. */
  shift_id: string;
  /** Structured reason; must be one of the FORCED_CLOSE_REASONS enum members. */
  reason: ForcedCloseReason;
  /** Optional free-text annotation for support context (PR-1: no PIN/PII). */
  annotation?: string;
  /**
   * RT-554 (b): the manager's blind count of the drawer, in integer minor units
   * (>= 0). The cash-up (expected cash, variance) is computed in main from local
   * truth and never returned.
   */
  counted_cash_minor: number;
}

export interface ForceCloseShiftResponse {
  kind: 'forced_closed';
  /** Echoes the caller-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
  /**
   * RT-554 (b): `sent` - Backend-Core has the forced close; `queued` - recorded
   * on this terminal and waiting to be sent (offline, or no manager envelope
   * right now). Never an amount.
   */
  delivery: 'sent' | 'queued';
}

/**
 * T090 — one stuck shift summary visible to the renderer.
 *
 * FR-013 minimum-disclosure: only display-safe fields. No Clerk user ids,
 * branch_id, tenant_id, device ids, or financial counts.
 */
export interface StuckShiftSummary {
  shift_id: string;
  /** Display label only — never email or Clerk user id (FR-032). */
  cashier_display_name: string;
  terminal_label: string;
  /** ISO 8601 UTC timestamp. */
  opened_at: string;
  duration_minutes: number;
}

export type ListStuckShiftsResponse =
  | { kind: 'stuck_shifts'; shifts: StuckShiftSummary[] }
  | OperatorRefusal;

/**
 * Manager/admin sign-in request shape.
 */
export interface ManagerAdminSignInRequest {
  kind: 'manager_admin';
  /** Identifier (email or username) the operator typed. */
  identifier: string;
  /** Cleartext password — crosses the bridge ONCE on input (PR-1). */
  password: string;
}

/**
 * S4 / T075 — cashier sign-in request shape.
 *
 * AD-2: PIN verified locally via Argon2id. The plaintext PIN NEVER
 * reaches the backend, any logger, or the renderer response (PR-1).
 * Crosses the bridge ONCE on input; consumed by CashierSignInHandler.
 */
export interface CashierSignInRequest {
  kind: 'cashier';
  /** Clerk user id of the cashier (from the branch roster). */
  cashier_clerk_user_id: string;
  /** Plaintext PIN — consumed by the verifier, never persisted or logged. */
  pin: string;
  /** Display name used to populate the local session record. */
  display_name: string;
}

export type SignInRequest = ManagerAdminSignInRequest | CashierSignInRequest;

export type SignInResponse = SignInSuccessResponse | TakeoverRequiredResponse | OperatorRefusal;

/**
 * RT-444 (RT-116 §3.4) — sign-out is refused `payment_in_progress` while the
 * session holds a started payment with live tender. The session stays.
 */
export type SignOutResponse = { kind: 'signed_out' } | OperatorRefusal;

/**
 * T070b — bridge view of a single cashier on the branch roster.
 *
 * Strict minimum-disclosure: only `{id, display_name, role}` cross the
 * bridge (FR-006, FR-031). Email, phone, password hash, PIN material,
 * and audit history MUST NOT appear here.
 */
export interface BranchRosterCashier {
  id: string;
  display_name: string;
  role: 'cashier';
}

export interface ListBranchRosterSuccess {
  kind: 'roster';
  /**
   * RT-113 (10763 §3) — where the roster came from: `online` = the
   * device-authenticated Backend-Core roster (P2); `offline` = the cashiers
   * with a valid offline grant on this terminal (P1/P3). Main always sets it;
   * optional only so existing renderer fixtures stay valid.
   */
  source?: 'online' | 'offline';
  cashiers: BranchRosterCashier[];
}

export type ListBranchRosterResponse = ListBranchRosterSuccess | OperatorRefusal;

/**
 * RT-424 (RT-251 doc 19 §2) — a cashier's PIN state on THIS terminal.
 *
 *   - `no_pin`: no PIN row matches the cashier (the sign-in match).
 *   - `ready`: a row matches and is not locked out. It does not promise that
 *     sign-in succeeds (admission, unsealing and the pairing epoch can refuse).
 *   - `locked`: a row matches and `lockout_until > now`. The lock ends on its own.
 */
export type CashierPinState = 'no_pin' | 'ready' | 'locked';

/**
 * RT-424 — one roster cashier with their PIN state. Fixed enums plus the
 * roster `display_name`; the PIN hash and salt, the failure count, `user_id`
 * and the tenant, branch and terminal ids never cross the bridge.
 */
export interface CashierPinStatus {
  /** The roster id (`operator_id`), as `listBranchRoster` gives it. */
  id: string;
  display_name: string;
  pin: CashierPinState;
  /** ISO 8601, present only when `pin === 'locked'` (doc 19 §7 D3). */
  locked_until?: string;
}

export type ListCashierPinStatusRefusalCategory =
  | 'not_signed_in'
  | 'role_mismatch'
  | 'no_connection'
  | 'invalid_input';

export type ListCashierPinStatusResponse =
  | { kind: 'cashiers'; cashiers: CashierPinStatus[] }
  | { kind: 'refused'; category: ListCashierPinStatusRefusalCategory };

/**
 * `operator.*` namespace. Manager/admin paths only at S1; cashier,
 * takeover-confirm, roster, audit-event-emit, and PIN management land
 * in later slices behind their gates.
 */
export interface OperatorBridgeAPI {
  /**
   * Authenticate an operator and create an operator session. S1 wires
   * the manager/admin variant only. Resolves with one of:
   *   - { kind: 'signed_in', session }
   *   - { kind: 'takeover_required' }                    // S4 wires the prompt UX
   *   - { kind: 'refused', category: RefusalCategory }   // single generic family
   *
   * The bridge handler MUST refuse generically (NFR-003 / PR-2): every
   * factor-distinguishable cause maps to `invalid_input` except the
   * cashier-PIN-only `rate_limited` case (S4) and the network-only
   * `no_connection` case.
   *
   * Redaction: the `password` field is consumed by the verifier and
   * MUST NOT be persisted, logged, snapshotted, or surfaced in any
   * thrown error (PR-1).
   */
  signIn(req: SignInRequest): Promise<SignInResponse>;

  /**
   * End the current operator session. Best-effort backend call; the
   * local session is torn down within 1 s regardless of backend
   * reachability (FR-008 / NFR-007).
   */
  signOut(): Promise<SignOutResponse>;

  /**
   * Read-only inquiry for the current session. Returns the session if
   * one is active, otherwise `null`.
   */
  getCurrentSession(): Promise<OperatorSessionBridgeView | null>;

  /**
   * Notify-only: the renderer reports genuine user input (mousemove,
   * keypress, touch) to the inactivity monitor (T028b / FR-009). Fire-
   * and-forget — the caller MUST NOT await or use the return value. No
   * new IPC channel: reuses `operator:_report-activity` registered in S1.
   * Wired by F-01 (s1-review finding — was registered main-side but
   * missing from the bridge surface).
   */
  _reportActivity(): void;

  /**
   * RT-117 (RT-116 §2.4) — same-operator unlock of the CURRENT locked session.
   * Resumes the SAME session id. Generic refusal on any mismatch; the lock is
   * unchanged. Secrets in the request are never logged (P11).
   */
  unlockSession(req: UnlockSessionRequest): Promise<UnlockSessionResponse>;

  /**
   * RT-358 (RT-247 D-A1) — in-place re-auth for the signed-in manager / admin
   * after an action was refused `reauth_required`. The same operator only
   * (another person's credentials → `invalid_input`); lockout and one attempt
   * at a time are shared with the online unlock (`rate_limited`). Refused
   * while locked. On success the renderer re-runs the refused action once.
   * Optional in the type (like `getResumeState`) so existing renderer test
   * doubles stay valid; the production preload always provides it.
   */
  reauthenticate?(req: ReauthenticateRequest): Promise<ReauthenticateResponse>;

  /**
   * RT-424 (RT-251 doc 19 §2) — the device roster with each cashier's PIN
   * state on this terminal, for Manager → Cashiers. Manager and admin only
   * (cashier → `role_mismatch`); scope comes from the pairing, never the
   * renderer. Read-only: no write, no audit event. Not on the locked-session
   * allowlist: while the session is locked the promise REJECTS (the main-side
   * lock guard throws `SessionLockedError` before the handler runs), so a
   * caller must catch it; a lock that lands during the read resolves to
   * `{ kind: 'refused', category: 'not_signed_in' }`. A separate method from
   * `listBranchRoster`, which sign-in calls without a role gate.
   * Optional in the type (like `reauthenticate`) so existing renderer test
   * doubles stay valid; the production preload always provides it.
   */
  listCashierPinStatus?(): Promise<ListCashierPinStatusResponse>;

  /**
   * RT-117 (RT-116 §7.2) — lock state + preserved-sale TOTALS for the lock
   * screen. The only operator read served while locked.
   */
  getLockState(): Promise<LockStateView>;

  /**
   * RT-352 (RT-116 §7.2) — read once after an admitted sign-in: the draft cart
   * main re-attached to this session (RT-115 D3.2). Refused while locked.
   * Optional so a bridge without it degrades to "nothing to resume".
   */
  getResumeState?(): Promise<ResumeStateView>;

  /**
   * RT-117 (RT-116 §7.2) — subscribe to main → renderer session-state pushes
   * (`locked` / `active` / `ended`). The callback receives the payload only.
   * Returns an unsubscribe function.
   */
  onSessionStateChanged(cb: (event: SessionStateEvent) => void): () => void;

  /**
   * T048 — Emit one audit event to the local outbox.
   *
   * The renderer supplies only the fields it owns (`EmitAuditEventRequest`);
   * the main-process handler enriches the trusted fields from session
   * state and pairing state before delegating to `AuditEmitter.emit()`.
   *
   * Resolves with `{ kind: 'emitted', event_id }` on success.
   * Resolves with `{ kind: 'refused', category }` on any failure
   * (no session → `not_signed_in`; bad payload / forbidden key →
   * `invalid_input`). Never rejects.
   *
   * Idempotent: submitting the same `event_id` twice is a no-op (P5 /
   * INSERT OR IGNORE at the SQL layer).
   */
  emitAuditEvent(req: EmitAuditEventRequest): Promise<EmitAuditEventResponse | OperatorRefusal>;

  /**
   * T051 — Debug bridge smoke. Main generates the event_id; renderer
   * supplies nothing. Gated by `process.env.NODE_ENV !== 'production'`
   * in the main-process handler — returns `invalid_input` refusal in
   * production builds. Manager / admin roles only; cashier → `role_mismatch`.
   * Hardcoded `action_category: 'shift.open'`, `payload: { smoke: true }`.
   */
  _emitAuditEventSmoke(): Promise<EmitAuditEventResponse | OperatorRefusal>;

  /**
   * T070b — list cashiers on the terminal's paired branch.
   *
   * Manager and admin roles only (cashier → `role_mismatch`). Returns only
   * `{id, display_name, role: 'cashier'}` per entry — no email, phone,
   * PIN material, or audit history crosses the bridge (FR-006, FR-031).
   * Branch scope comes from the active operator session (trusted main-side).
   */
  listBranchRoster(): Promise<ListBranchRosterResponse>;

  /**
   * T070 — confirm a pending takeover using the capability token returned
   * by `signIn`. Creates the new session and emits the
   * `operator.session.takeover` audit event.
   *
   * On success: `{ kind: 'signed_in', session }`.
   * On `no_connection`: proto-session is retained; caller may retry.
   * On any other failure: `{ kind: 'refused', category: 'invalid_input' }`.
   * Token expires after 60 seconds (NFR-003).
   */
  confirmTakeover(req: ConfirmTakeoverRequest): Promise<ConfirmTakeoverResponse | OperatorRefusal>;

  /**
   * T071 — cancel a pending takeover. Discards the proto-session;
   * returns `{ kind: 'cancelled' }` idempotently even if the token is
   * unknown or already expired. No audit event. No session change.
   */
  cancelTakeover(req: CancelTakeoverRequest): Promise<CancelTakeoverResponse>;

  /**
   * T072 — PR-5 manager/admin PIN reset for a cashier on this terminal.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * `new_pin` must be 4–6 digits; invalid shape → `invalid_input`.
   * `target_cashier_id` must have an existing pin record on this terminal;
   * unknown cashier → `invalid_input`.
   *
   * Emits `cashier.pin.reset` audit event (manager attributed, cashier
   * referenced by id only; PIN value never in payload — PR-1).
   * Resets `failed_attempt_count` to 0 and `lockout_until` to null.
   */
  resetCashierPin(req: ResetCashierPinRequest): Promise<ResetCashierPinResponse | OperatorRefusal>;

  /**
   * 019 — manager/admin FIRST-PIN provisioning (create) for a cashier on this
   * terminal. Creates the row keyed on the provider-neutral `user_id`; emits
   * `cashier.pin.provisioned` (secret-free). Create-only; refuses `state_invalid`
   * if a row exists, `not_ready` if the roster has no `user_id` (FR-11).
   */
  provisionCashierPin(
    req: ProvisionCashierPinRequest,
  ): Promise<ProvisionCashierPinResponse | OperatorRefusal>;

  /**
   * T073 — PR-3 manager/admin unlock of a locked-out cashier on this terminal.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * Resets `failed_attempt_count` to 0 and `lockout_until` to null.
   *
   * If the cashier is not currently locked out, still emits the
   * `cashier.pin.unlock` audit event and returns `state_invalid`
   * (the renderer interprets this as "already unlocked, no-op").
   *
   * This call MUST NOT accept any PIN field — it only clears lockout state.
   */
  unlockCashier(req: UnlockCashierRequest): Promise<UnlockCashierResponse | OperatorRefusal>;

  /**
   * T089 — manager/admin forced-close of a stuck cashier shift.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * Branch isolation: manager can only close shifts on their own branch
   * (P17 — mismatch returns `role_mismatch`, not `state_invalid`).
   * declared_count is left NULL (FR-024(a) blind-close / absent state).
   *
   * Idempotent: calling with the same `event_id` on an already-closed
   * shift returns `{ kind: 'forced_closed', audit_event_id }` without
   * re-emitting the audit event.
   */
  forceCloseShift(req: ForceCloseShiftRequest): Promise<ForceCloseShiftResponse | OperatorRefusal>;

  /**
   * T090 — list stuck cashier shifts on this terminal's branch.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * Returns only display-safe fields per FR-013 / FR-032. Branch scope
   * comes from the active operator session (trusted main-side).
   */
  listStuckShifts(): Promise<ListStuckShiftsResponse>;

  /**
   * T091 — cashier dismisses the forced-close return banner.
   *
   * Zero renderer args. Main process reads the current session and pairing
   * state to derive all needed IDs. Fire-and-forget; always resolves void.
   * Takeover-confirm responses do NOT populate forced_close_notice — this
   * call is a no-op in that path.
   */
  dismissShiftClosedNotice(): Promise<void>;
}
