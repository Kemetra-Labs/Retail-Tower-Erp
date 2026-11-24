/**
 * RT-441 (RT-116 S6, §5) — manager recovery end to end over every migration
 * (sql.js): the real manager PIN store (MA-1), the real approval service
 * (MA-2), the real payment FSMs and handlers, and the recovery service.
 *
 * A cashier took 5,000 of a 15,000 sale in cash, then their session ended:
 * the attempt is this terminal's stuck attempt (RT-442). A manager signed in
 * (in recovery mode) clears it, each action with its own approval.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  initGrantSql,
} from '../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';
// Nested transactions (a savepoint), as better-sqlite3 does in production.
import { makeSqlJsHandle as handleFor } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';
import {
  createManagerPinStore,
  type ManagerPinStore,
} from '../../../../src/main/operator/manager-pin-store.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../../../src/main/operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { realSettlementDeps } from '../../../unit/main/payments/__fixtures__/real-settlement-deps.js';
import { createPaymentsCancelHandler } from '../../../../src/main/payments/handlers/payments-cancel.js';
import { createPaymentAuditEmitter } from '../../../../src/main/payments/audit-emitter.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import {
  createManagerRecovery,
  createRecoveryPaymentPort,
  type ManagerRecovery,
  type ManagerRecoveryDeps,
} from '../../../../src/main/recovery/manager-recovery.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { ManagerActionKind } from '../../../../src/shared/operator/manager-action-kinds.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const OTHER_MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b', pin: '13579135' };
const CASHIER_OP = 'op-cashier';
const DEAD_SESSION = 'sess-cashier-dead';
const NOW = '2026-10-13T09:00:00.000Z';
const TOTAL = 15_000;
const PAID = 5_000;

function manager(over: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'sess-mgr',
    operator_id: 'op-mgr',
    display_name: 'Mona Manager',
    role: 'manager',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: NOW,
    backend_session_id: 'b-mgr',
    last_activity_at: NOW,
    lock_state: 'active',
    locked_at: null,
    manager_user_id: MANAGER.userId,
    recovery_of: 'pending',
    ...over,
  };
}

/** A manager session with one optional field truly absent (not set to `undefined`). */
function managerWithout(
  field: 'manager_user_id' | 'recovery_of',
  over: Partial<OperatorSessionRecord> = {},
): OperatorSessionRecord {
  const record = manager(over);
  if (field === 'manager_user_id') delete record.manager_user_id;
  else delete record.recovery_of;
  return record;
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let approvals: ManagerApprovalService;
let recovery: ManagerRecovery;
let current: OperatorSessionRecord | null;
/** The approval service's clock; a test moves it past the TTL. */
let approvalClock = NOW;
let audit: AuditEvent[];
let endRecoverySession: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let attemptId: string;
let cashierScope: OperatorSessionForPayments;
let stack: ReturnType<typeof paymentStack>;

function paymentStack(db: ReturnType<typeof handleFor>) {
  const attempts = bindPaymentAttemptsRepository(db);
  const lines = bindPaymentTenderLinesRepository(db);
  const outbox = bindPaymentActionOutboxRepository(db);
  const tenderLineFsm = createTenderLineFsm({ db, attempts, lines, outbox });
  const paymentAttemptFsm = createPaymentAttemptFsm({ db, attempts, lines, outbox });
  const shared = {
    attemptsRepo: attempts,
    linesRepo: lines,
    idempotency: createIdempotencyHelper({ outbox }),
    auditEmitter: createPaymentAuditEmitter({ sink: { write: () => undefined } }),
    clock: () => new Date(NOW),
  };
  const uuid = (): string => crypto.randomUUID();
  const build = (getCurrentSession: () => OperatorSessionForPayments | null) => ({
    start: createPaymentsStartHandler({
      ...shared,
      getCurrentSession,
      paymentAttemptFsm,
      uuid,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: () => false,
    }),
    // RT-700: card tender flag on — the card-live cases apply a card line.
    apply: createTenderApplyHandler({
      ...shared,
      getCurrentSession,
      tenderLineFsm,
      uuid,
      isCardTenderEnabled: () => true,
    }),
    confirm: createPaymentsConfirmHandler({
      ...shared,
      ...realSettlementDeps({
        db,
        paymentAttemptFsm,
        attempts,
        lines,
        auditEmitter: shared.auditEmitter,
      }),
      getCurrentSession,
      paymentAttemptFsm,
    }),
    cancel: createPaymentsCancelHandler({ ...shared, getCurrentSession, paymentAttemptFsm }),
  });
  return { build };
}

function insertCart(
  cart_id: string,
  state: string,
  session_id = DEAD_SESSION,
  owner = CASHIER_OP,
): void {
  raw.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, handoff_envelope_json, last_action_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cart_id,
      SCOPE.tenantId,
      SCOPE.branchId,
      TERMINAL,
      owner,
      session_id,
      state,
      TOTAL,
      state === 'frozen_handed_off'
        ? JSON.stringify({
            handoff_action_id: `h-${cart_id}`,
            lines: [],
            discount_placeholders: [],
          })
        : null,
      `a-${cart_id}`,
      NOW,
      NOW,
    ],
  );
}

beforeAll(async () => {
  await initGrantSql();
});

async function enrolManagers(db: ReturnType<typeof handleFor>): Promise<void> {
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  for (const m of [MANAGER, OTHER_MANAGER]) {
    await pins.enrol({
      scope: SCOPE,
      userId: m.userId,
      displayName: `Manager ${m.userId.slice(-1)}`,
      sealed: await pins.seal(m.pin),
      now: NOW,
      onlineAt: NOW,
      guard: () => undefined,
    });
  }
}

/** The cashier's sale: a frozen cart, a started attempt, 5,000 in cash. */
async function seedStuckSale(): Promise<void> {
  cashierScope = {
    role: 'cashier',
    operator_id: CASHIER_OP,
    operator_session_id: DEAD_SESSION,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    terminal_id: TERMINAL,
    display_name: 'Cashier',
  };
  const asCashier = stack.build(() => cashierScope);
  insertCart('cart-stuck', 'frozen_handed_off');
  const started = await asCashier.start({
    envelope_handoff_action_id: 'h-cart-stuck',
    envelope_cart_id: 'cart-stuck',
    envelope_subtotal_minor: TOTAL,
    envelope_version: 'v1',
    idempotency_key: 'k-start',
  });
  if (started.kind !== 'ok') throw new Error('start refused');
  attemptId = started.payment_attempt_id;
  const paid = await asCashier.apply({
    payment_attempt_id: attemptId,
    tender_type: 'cash',
    amount_applied_minor: PAID,
    idempotency_key: 'k-pay',
  });
  if (paid.kind !== 'ok') throw new Error('apply refused');
}

let handle: ReturnType<typeof handleFor>;
const recoveryRef: { current: ManagerRecovery | null } = { current: null };

/** The recovery service over the real stack; a test may swap a dependency. */
function buildRecovery(
  over: Partial<ManagerRecoveryDeps> = {},
  options: { readonly defaultClock?: boolean } = {},
): ManagerRecovery {
  const deps: ManagerRecoveryDeps = {
    db: handle,
    getSession: () => current,
    resolveTerminalId: () => TERMINAL,
    approvals,
    cartStore: bindCartStore(handle),
    payments: createRecoveryPaymentPort((get) => stack.build(get)),
    auditEmitter: { emit: (e) => audit.push(e) },
    endRecoverySession,
    clock: () => new Date(NOW),
    ...over,
  };
  if (options.defaultClock === true) delete deps.clock;
  const built = createManagerRecovery(deps);
  recoveryRef.current = built;
  return built;
}

function wireApprovals(): void {
  const via =
    (
      pick: (
        r: ManagerRecovery,
      ) => ManagerRecovery['resolvers'][keyof ManagerRecovery['resolvers']],
    ) =>
    (i: Parameters<ManagerRecovery['resolvers']['completeAttempt']>[0]) =>
      recoveryRef.current === null ? null : pick(recoveryRef.current)(i);
  approvals = createManagerApprovalService({
    db: handle,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: {
      'recovery.complete_attempt': via((r) => r.resolvers.completeAttempt),
      'recovery.cancel_attempt': via((r) => r.resolvers.cancelAttempt),
      'recovery.cancel_held_cart': via((r) => r.resolvers.cancelHeldCart),
      'recovery.cancel_held_carts': via((r) => r.resolvers.cancelHeldCarts),
    },
    auditEmitter: { emit: (e) => audit.push(e) },
    now: () => approvalClock,
  });
}

beforeEach(async () => {
  approvalClock = NOW;
  raw = freshGrantDb();
  handle = handleFor(raw);
  audit = [];
  endRecoverySession = vi.fn<() => Promise<unknown>>(() => Promise.resolve());
  await enrolManagers(handle);
  stack = paymentStack(handle);
  await seedStuckSale();
  current = manager({ recovery_of: attemptId });
  wireApprovals();
  recovery = buildRecovery();
});

afterEach(() => {
  raw.close();
});

function managerRef(userId: string): string {
  return (
    pins.list({ scope: SCOPE, now: NOW }).find((m) => m.displayName.endsWith(userId.slice(-1)))
      ?.managerRef ?? ''
  );
}

async function approve(
  kind: ManagerActionKind,
  subject_ref: string,
  approver = MANAGER,
): Promise<string> {
  const outcome = await approvals.request({
    action_kind: kind,
    subject_ref,
    reason_code: 'manager_recovery',
    approver_ref: managerRef(approver.userId),
    pin: approver.pin,
  });
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

/** 15,000 cash for the 10,000 remainder (5,000 change), or the cash-returned confirmation. */
const PAYING = { cash_received_minor: TOTAL };
const RETURNED = { cash_returned_confirmed: true };
const ATTEMPT_KIND = {
  complete: 'recovery.complete_attempt',
  cancel: 'recovery.cancel_attempt',
} as const;

/** Approve the stuck attempt (for `kind`, default the action's own), then run the action. */
async function runAttempt(
  action: 'complete' | 'cancel',
  opts: {
    service?: ManagerRecovery;
    kind?: ManagerActionKind;
    extra?: { cash_received_minor?: number; cash_returned_confirmed?: boolean };
  } = {},
): Promise<unknown> {
  const service = opts.service ?? recovery;
  const approval_id = await approve(opts.kind ?? ATTEMPT_KIND[action], attemptId);
  const req = { payment_attempt_id: attemptId, approval_id, ...opts.extra };
  return action === 'complete' ? service.completeAttempt(req) : service.cancelAttempt(req);
}

const value = (sql: string, params: unknown[] = []): unknown =>
  raw.exec(sql, params as never)[0]?.values[0]?.[0];
const attemptState = (): unknown =>
  value('SELECT state FROM payment_attempts WHERE payment_attempt_id = ?', [attemptId]);
const categories = (): string[] => audit.map((e) => e.action_category);
const UNKNOWN_APPROVAL = '00000000-0000-4000-8000-000000000000';

describe('recovery.listHeld — totals only', () => {
  it('shows the stuck payment and the held carts as a summary, no line items', () => {
    insertCart('cart-draft', 'editing');
    const view = recovery.listHeld();
    expect(view).toEqual({
      kind: 'held',
      recovery_mode: true,
      stuck: {
        payment_attempt_id: attemptId,
        cart_id: 'cart-stuck',
        owning_operator_id: CASHIER_OP,
        line_count: 0,
        total_minor: TOTAL,
        cash_minor: PAID,
        card_minor: 0,
        voucher_minor: 0,
        remaining_minor: TOTAL - PAID,
        started_at: NOW,
      },
      held: [
        {
          cart_id: 'cart-draft',
          owning_operator_id: CASHIER_OP,
          kind: 'draft',
          parked: false,
          own: false,
          line_count: 0,
          total_minor: TOTAL,
          updated_at: NOW,
        },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/display_name|item_ref|label/);
  });

  it('is manager / admin only', () => {
    current = { ...manager(), role: 'cashier' };
    expect(recovery.listHeld()).toEqual({ kind: 'refused', reason: 'role_mismatch' });
  });
});

describe('approval.listApprovers for recovery', () => {
  it('offers only the signed-in manager’s own record', () => {
    const answer = approvals.listApprovers({ actionKind: 'recovery.complete_attempt' });
    expect(answer).toEqual({
      kind: 'approvers',
      approvers: [{ approver_ref: managerRef(MANAGER.userId), display_name: 'Manager a' }],
    });
  });

  it('offers nobody to a session without a captured manager id', () => {
    current = managerWithout('manager_user_id');
    expect(approvals.listApprovers({ actionKind: 'recovery.cancel_held_cart' })).toEqual({
      kind: 'approvers',
      approvers: [],
    });
  });
});

describe('recovery.completeAttempt', () => {
  it('needs an approval', async () => {
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: UNKNOWN_APPROVAL,
        cash_received_minor: TOTAL - PAID,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    expect(attemptState()).toBe('started');
  });

  it('an approval for another action does not complete it', async () => {
    await expect(
      runAttempt('complete', { kind: 'recovery.cancel_attempt', extra: PAYING }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('a payment that moved since the approval is stale', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    const asCashier = stack.build(() => cashierScope);
    await asCashier.apply({
      payment_attempt_id: attemptId,
      tender_type: 'cash',
      amount_applied_minor: 1_000,
      idempotency_key: 'k-more',
    });
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: TOTAL,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_stale' });
    expect(attemptState()).toBe('started');
  });

  it('the approver is the signed-in manager: another manager’s PIN is refused', async () => {
    await expect(approve('recovery.complete_attempt', attemptId, OTHER_MANAGER)).rejects.toThrow(
      'approval_unavailable',
    );
  });

  it('is requested on behalf of the original operator (requester ≠ approver)', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    expect(
      value('SELECT requester_operator_id FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBe(CASHIER_OP);
    expect(
      value('SELECT approver_user_id FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBe(MANAGER.userId);
  });

  it('refuses less cash than the remaining balance, spending nothing', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: 9_999,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'cash_insufficient' });
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
  });

  it('collects the rest, settles through the standard path, audits both, ends recovery', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    audit = [];
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: 20_000,
      }),
    ).resolves.toEqual({ kind: 'completed', change_due_minor: 10_000 });
    expect(attemptState()).toBe('settled');
    expect(audit.find((e) => e.action_category === 'payment.recovery_completed')).toMatchObject({
      acting_operator_id: CASHIER_OP,
      approving_supervisor_id: MANAGER.userId,
      payload: { payment_attempt_id: attemptId, cart_id: 'cart-stuck', approval_id: id },
    });
    expect(endRecoverySession).toHaveBeenCalledOnce();
  });
});

describe('recovery.cancelAttempt', () => {
  it('needs the cash-returned confirmation when cash is live, before any approval is spent', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    await expect(
      recovery.cancelAttempt({ payment_attempt_id: attemptId, approval_id: id }),
    ).resolves.toEqual({ kind: 'refused', reason: 'confirmation_required' });
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
    expect(attemptState()).toBe('started');
  });

  it('needs an approval bound to this attempt', async () => {
    await expect(
      runAttempt('cancel', { kind: 'recovery.complete_attempt', extra: RETURNED }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('reverses the tender explicitly, audits the recovery, ends recovery', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    audit = [];
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(attemptState()).toBe('cancelled');
    expect(
      value('SELECT state FROM payment_tender_lines WHERE payment_attempt_id = ?', [attemptId]),
    ).toBe('reversed');
    expect(audit.find((e) => e.action_category === 'payment.recovery_cancelled')).toMatchObject({
      acting_operator_id: CASHIER_OP,
      approving_supervisor_id: MANAGER.userId,
      payload: { cash_returned_confirmed: true, card_void_confirmed_on_terminal: false },
    });
    expect(endRecoverySession).toHaveBeenCalledOnce();
  });
});

describe('recovery.cancelHeldCart', () => {
  it.each([
    ['editing', 'manager_cancelled_held', 'cart.void'],
    ['frozen_handed_off', 'manager_voided_post_handoff', 'cart.cancel.post_handoff'],
  ])('cancels a held %s cart as %s, with %s', async (state, reason, kind) => {
    insertCart('cart-held', state);
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    audit = [];
    expect(recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual({
      kind: 'cancelled',
    });
    expect(value(`SELECT cancellation_reason FROM carts WHERE cart_id = 'cart-held'`)).toBe(reason);
    expect(value(`SELECT action_kind FROM cart_action_outbox WHERE cart_id = 'cart-held'`)).toBe(
      kind,
    );
    expect(categories()).toEqual(['cart.held_cancelled_by_manager']);
    expect(audit[0]).toMatchObject({
      acting_operator_id: CASHIER_OP,
      approving_supervisor_id: MANAGER.userId,
    });
    expect(endRecoverySession).not.toHaveBeenCalled();
  });

  it('needs an approval, and a stale cart rolls everything back', async () => {
    insertCart('cart-held', 'editing');
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    raw.run(`UPDATE carts SET cart_subtotal_minor = 1 WHERE cart_id = 'cart-held'`);
    expect(recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'approval_stale',
    });
    expect(value(`SELECT state FROM carts WHERE cart_id = 'cart-held'`)).toBe('editing');
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
  });

  it('never cancels the stuck payment’s cart (its payment is open)', () => {
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-stuck', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual({ kind: 'refused', reason: 'not_found' });
  });
});

/** RT-837: the manager's own held sale from an earlier session. */
const OWN_OLD_SESSION = 'sess-mgr-earlier';
const MANAGER_OP = 'op-mgr';

describe('recovery — the manager’s own held sale (RT-837)', () => {
  it('lists it as the manager’s own, not as another employee’s', () => {
    insertCart('cart-mine', 'editing', OWN_OLD_SESSION, MANAGER_OP);
    insertCart('cart-theirs', 'editing');
    const held = (recovery.listHeld() as { held: { cart_id: string; own: boolean }[] }).held;
    expect(held.map((c) => [c.cart_id, c.own]).sort()).toEqual([
      ['cart-mine', true],
      ['cart-theirs', false],
    ]);
  });

  it.each([
    ['editing', 'manager_cancelled_held', 'cart.void'],
    ['frozen_handed_off', 'manager_voided_post_handoff', 'cart.cancel.post_handoff'],
  ])(
    'cancels it with the manager’s PIN (%s), audited like a manager cancel',
    async (state, reason, kind) => {
      insertCart('cart-mine', state, OWN_OLD_SESSION, MANAGER_OP);
      const id = await approve('recovery.cancel_held_cart', 'cart-mine');
      audit = [];
      expect(recovery.cancelHeldCart({ cart_id: 'cart-mine', approval_id: id })).toEqual({
        kind: 'cancelled',
      });
      expect(value(`SELECT cancellation_reason FROM carts WHERE cart_id = 'cart-mine'`)).toBe(
        reason,
      );
      expect(value(`SELECT action_kind FROM cart_action_outbox WHERE cart_id = 'cart-mine'`)).toBe(
        kind,
      );
      expect(categories()).toEqual(['cart.held_cancelled_by_manager']);
      expect(audit[0]).toMatchObject({
        acting_operator_id: MANAGER_OP,
        approving_supervisor_id: MANAGER.userId,
      });
    },
  );

  it('never touches the cart of the live session', () => {
    insertCart('cart-live', 'editing', 'sess-mgr', MANAGER_OP);
    expect(recovery.listHeld()).toMatchObject({ held: [] });
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-live', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual({ kind: 'refused', reason: 'not_found' });
  });

  it('still refuses a wrong PIN, and spends no approval', async () => {
    insertCart('cart-mine', 'editing', OWN_OLD_SESSION, MANAGER_OP);
    const outcome = await approvals.request({
      action_kind: 'recovery.cancel_held_cart',
      subject_ref: 'cart-mine',
      reason_code: 'manager_recovery',
      approver_ref: managerRef(MANAGER.userId),
      pin: '000000',
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'approval_unavailable' });
    expect(value(`SELECT state FROM carts WHERE cart_id = 'cart-mine'`)).toBe('editing');
  });

  it('still refuses an expired approval, leaving the cart held', async () => {
    insertCart('cart-mine', 'editing', OWN_OLD_SESSION, MANAGER_OP);
    const id = await approve('recovery.cancel_held_cart', 'cart-mine');
    approvalClock = '2026-10-13T09:10:00.000Z';
    expect(recovery.cancelHeldCart({ cart_id: 'cart-mine', approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(value(`SELECT state FROM carts WHERE cart_id = 'cart-mine'`)).toBe('editing');
  });
});

const refusedWith = (reason: string) => ({ kind: 'refused', reason });

async function payByCard(amount: number): Promise<void> {
  const paid = await stack
    .build(() => cashierScope)
    .apply({
      payment_attempt_id: attemptId,
      tender_type: 'external_card_terminal',
      amount_applied_minor: amount,
      external_reference: 'A1B2C3',
      idempotency_key: 'k-card',
    });
  if (paid.kind !== 'ok') throw new Error(`card refused: ${JSON.stringify(paid)}`);
}

const realPort = () => createRecoveryPaymentPort((get) => stack.build(get));
const quietLogger = () => ({ info: vi.fn(), error: vi.fn() });

describe('recovery — who may recover', () => {
  it.each<[string, () => OperatorSessionRecord | null, string]>([
    ['signed out', () => null, 'no_session'],
    ['locked', () => manager({ lock_state: 'locked' }), 'session_locked'],
    ['a cashier', () => manager({ role: 'cashier' }), 'role_mismatch'],
  ])('refuses every action when %s', async (_label, session, reason) => {
    insertCart('cart-held', 'editing');
    current = session();
    expect(recovery.listHeld()).toEqual(refusedWith(reason));
    await expect(
      recovery.completeAttempt({ payment_attempt_id: attemptId, approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith(reason));
    await expect(
      recovery.cancelAttempt({ payment_attempt_id: attemptId, approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith(reason));
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual(refusedWith(reason));
  });

  it('serves an admin', () => {
    current = manager({ role: 'admin' });
    expect(recovery.listHeld()).toMatchObject({ kind: 'held' });
  });

  it('refuses on an unpaired terminal, and resolves no approval subject there', () => {
    insertCart('cart-held', 'editing');
    const unpaired = buildRecovery({ resolveTerminalId: () => null });
    expect(unpaired.listHeld()).toEqual(refusedWith('no_session'));
    const session = manager();
    expect(unpaired.resolvers.completeAttempt({ subjectRef: attemptId, session })).toBeNull();
    expect(unpaired.resolvers.cancelHeldCart({ subjectRef: 'cart-held', session })).toBeNull();
  });

  it('never lets an operator recover their own sale from a new session', async () => {
    insertCart('cart-held', 'editing');
    const session = managerWithout('recovery_of', { operator_id: CASHIER_OP });
    current = session;
    expect(recovery.resolvers.completeAttempt({ subjectRef: attemptId, session })).toBeNull();
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: UNKNOWN_APPROVAL,
        cash_received_minor: TOTAL,
      }),
    ).resolves.toEqual(refusedWith('not_found'));
  });
});

describe('recovery.listHeld — what it lists', () => {
  it('lists no stuck payment once it is resolved, and a handed-off cart as handed off', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    await recovery.cancelAttempt({
      payment_attempt_id: attemptId,
      approval_id: id,
      cash_returned_confirmed: true,
    });
    insertCart('cart-frozen', 'frozen_handed_off');
    const view = recovery.listHeld();
    expect(view).toMatchObject({ kind: 'held', stuck: null });
    expect(view.kind === 'held' && view.held.map((h) => [h.cart_id, h.kind])).toContainEqual([
      'cart-frozen',
      'handed_off',
    ]);
  });

  it('flags a parked cart (spec 024 §4.3; migration 0050)', () => {
    insertCart('cart-parked', 'editing');
    raw.run(`UPDATE carts SET parked_at = ? WHERE cart_id = 'cart-parked'`, [NOW]);
    const view = recovery.listHeld();
    expect(view.kind === 'held' && view.held).toEqual([
      expect.objectContaining({ cart_id: 'cart-parked', parked: true }),
    ]);
  });

  it('shows card tender as card, and uses the real clock by default', async () => {
    await payByCard(2_000);
    const unclocked = buildRecovery({}, { defaultClock: true });
    const view = unclocked.listHeld();
    expect(view.kind === 'held' && view.stuck).toMatchObject({
      cash_minor: PAID,
      card_minor: 2_000,
      remaining_minor: TOTAL - PAID - 2_000,
    });
  });
});

describe('recovery.completeAttempt — refusals and failures', () => {
  it('refuses an attempt that is not this terminal’s stuck attempt', async () => {
    await expect(
      recovery.completeAttempt({ payment_attempt_id: 'other', approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith('not_found'));
  });

  it('refuses no cash at all when something remains', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.completeAttempt({ payment_attempt_id: attemptId, approval_id: id }),
    ).resolves.toEqual(refusedWith('cash_insufficient'));
  });

  it.each([
    ['the cash apply', 'apply', 'complete', PAYING],
    ['the confirm', 'confirm', 'complete', PAYING],
    ['the cancel', 'cancel', 'cancel', RETURNED],
  ] as const)('answers payment_refused when %s is refused', async (_label, step, action, extra) => {
    const refusal = () =>
      Promise.resolve({ kind: 'refused' as const, reason: 'no_session' as const });
    const service = buildRecovery({ payments: { ...realPort(), [step]: refusal } });
    await expect(runAttempt(action, { service, extra })).resolves.toEqual(
      refusedWith('payment_refused'),
    );
    expect(attemptState()).toBe('started');
  });

  interface Fault {
    label: string;
    faulty: (logger: ReturnType<typeof quietLogger>) => Partial<ManagerRecoveryDeps>;
    answer: unknown;
    logged: unknown;
    message: string;
  }
  it.each<Fault>([
    {
      label: 'a payment call throws',
      faulty: (logger) => ({
        logger,
        payments: { ...realPort(), apply: () => Promise.reject(new Error('disk full')) },
      }),
      answer: refusedWith('recovery_unavailable'),
      logged: expect.anything(),
      message: 'recovery.failed',
    },
    {
      label: 'ending the recovery session fails',
      faulty: (logger) => ({
        logger,
        endRecoverySession: () => Promise.reject(new Error('backend down')),
      }),
      answer: { kind: 'completed', change_due_minor: 5_000 },
      logged: expect.anything(),
      message: 'recovery.end_session_failed',
    },
    {
      label: 'the audit sink throws',
      faulty: (logger) => ({
        logger,
        auditEmitter: {
          emit: () => {
            throw new Error('sink down');
          },
        },
      }),
      answer: { kind: 'completed', change_due_minor: 5_000 },
      logged: { err: expect.any(Error) as unknown, category: 'payment.recovery_completed' },
      message: 'recovery.audit_failed',
    },
  ])('logs it when $label', async ({ faulty, answer, logged, message }) => {
    const logger = quietLogger();
    const service = buildRecovery(faulty(logger));
    await expect(runAttempt('complete', { service, extra: PAYING })).resolves.toEqual(answer);
    expect(logger.error).toHaveBeenCalledWith(logged, message);
  });

  it('runs one action at a time', async () => {
    const real = realPort();
    let release: () => void = () => undefined;
    const slow = buildRecovery({
      payments: {
        ...real,
        apply: (scope, req) =>
          new Promise((resolve) => {
            release = () => {
              resolve(real.apply(scope, req));
            };
          }),
      },
    });
    const id = await approve('recovery.complete_attempt', attemptId);
    const first = slow.completeAttempt({
      payment_attempt_id: attemptId,
      approval_id: id,
      cash_received_minor: TOTAL,
    });
    await expect(
      slow.cancelAttempt({ payment_attempt_id: attemptId, approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith('recovery_unavailable'));
    release();
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
  });

  it('completes a fully tendered attempt with no cash, outside recovery mode', async () => {
    const rest = await stack
      .build(() => cashierScope)
      .apply({
        payment_attempt_id: attemptId,
        tender_type: 'cash',
        amount_applied_minor: TOTAL - PAID,
        idempotency_key: 'k-rest',
      });
    expect(rest.kind).toBe('ok');
    current = managerWithout('recovery_of');
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.completeAttempt({ payment_attempt_id: attemptId, approval_id: id }),
    ).resolves.toEqual({ kind: 'completed', change_due_minor: 0 });
    expect(attemptState()).toBe('settled');
    expect(endRecoverySession).not.toHaveBeenCalled();
  });
});

describe('recovery.cancelAttempt — confirmations and failures', () => {
  it('needs the card-void confirmation when card is live', async () => {
    await payByCard(2_000);
    const id = await approve('recovery.cancel_attempt', attemptId);
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
      }),
    ).resolves.toEqual(refusedWith('confirmation_required'));
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
        card_void_confirmed_on_terminal: true,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
  });
});

describe('recovery.cancelHeldCart — failures', () => {
  it('versions a cart with no last action by its update time', async () => {
    insertCart('cart-held', 'editing');
    raw.run(`UPDATE carts SET last_action_id = NULL WHERE cart_id = 'cart-held'`);
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    expect(recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual({
      kind: 'cancelled',
    });
  });

  it('rolls back and answers recovery_unavailable when the cart write throws', async () => {
    insertCart('cart-held', 'editing');
    const logger = quietLogger();
    const failing = buildRecovery({
      logger,
      cartStore: {
        cancelCartAndOutbox: () => {
          throw new Error('constraint');
        },
      },
    });
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    expect(failing.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual(
      refusedWith('recovery_unavailable'),
    );
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'recovery.cancel_held_cart_failed',
    );
  });
});

/**
 * RT-1563 — a manager cancels many parked drafts with ONE approval. The batch is a snapshot main
 * takes (`prepareCancelHeldCarts`); the approval is bound to that snapshot, so the renderer cannot
 * change which carts a PIN covers. One audit row and one outbox row per cancelled sale.
 */
const PARKED_COUNT_SQL = `SELECT COUNT(*) FROM carts WHERE terminal_id = '${TERMINAL}'
  AND parked_at IS NOT NULL AND state = 'editing'`;

function insertParked(cart_id: string, owner = CASHIER_OP, session_id = DEAD_SESSION): void {
  insertCart(cart_id, 'editing', session_id, owner);
  raw.run(`UPDATE carts SET parked_at = ? WHERE cart_id = ?`, [NOW, cart_id]);
}

function prepared(ids: string[]): {
  batch_id: string;
  count: number;
  total_minor: number;
  excluded_cart_ids: string[];
} {
  const out = recovery.prepareCancelHeldCarts({ cart_ids: ids });
  if (out.kind !== 'prepared') throw new Error(`not prepared: ${out.reason}`);
  return out;
}

describe('recovery.prepareCancelHeldCarts (RT-1563)', () => {
  it('snapshots only parked drafts: not unparked, handed-off, unknown or payment-bound carts', async () => {
    insertParked('p1');
    insertParked('p2', 'op-other');
    insertCart('c-unparked', 'editing');
    insertCart('c-frozen', 'frozen_handed_off');
    insertParked('p-paid');
    const asCashier = stack.build(() => cashierScope);
    const started = await asCashier.start({
      envelope_handoff_action_id: 'h-p-paid',
      envelope_cart_id: 'p-paid',
      envelope_subtotal_minor: TOTAL,
      envelope_version: 'v1',
      idempotency_key: 'k-start-paid',
    });
    expect(started.kind).toBe('ok');
    const out = prepared([
      'p1',
      'p2',
      'p1',
      'c-unparked',
      'c-frozen',
      'cart-stuck',
      'p-paid',
      'ghost',
    ]);
    expect(out.count).toBe(2);
    expect(out.total_minor).toBe(2 * TOTAL);
    expect([...out.excluded_cart_ids].sort()).toEqual([
      'c-frozen',
      'c-unparked',
      'cart-stuck',
      'ghost',
      'p-paid',
    ]);
    expect(out.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    // Preparing changes nothing.
    expect(value(PARKED_COUNT_SQL)).toBe(3);
    expect(categories()).toEqual([]);
  });

  it('refuses when nothing is eligible, and for a cashier or a locked session', () => {
    insertCart('c-unparked', 'editing');
    expect(recovery.prepareCancelHeldCarts({ cart_ids: ['c-unparked'] })).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
    insertParked('p1');
    current = manager({ role: 'cashier' });
    expect(recovery.prepareCancelHeldCarts({ cart_ids: ['p1'] })).toEqual({
      kind: 'refused',
      reason: 'role_mismatch',
    });
    current = manager({ lock_state: 'locked' });
    expect(recovery.prepareCancelHeldCarts({ cart_ids: ['p1'] })).toEqual({
      kind: 'refused',
      reason: 'session_locked',
    });
    current = null;
    expect(recovery.prepareCancelHeldCarts({ cart_ids: ['p1'] })).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
  });

  it('includes the manager’s own parked draft from an earlier session (RT-837)', () => {
    insertParked('p-own', 'op-mgr', 'sess-mgr-earlier');
    expect(prepared(['p-own']).count).toBe(1);
  });

  it('the approval service accepts a batch reference only for this session', async () => {
    insertParked('p1');
    const { batch_id } = prepared(['p1']);
    await expect(approve('recovery.cancel_held_carts', batch_id)).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
    current = manager({ id: 'sess-mgr-2' });
    await expect(approve('recovery.cancel_held_carts', batch_id)).rejects.toThrow(
      /approval_invalid/,
    );
    await expect(approve('recovery.cancel_held_carts', 'no-such-batch')).rejects.toThrow(
      /approval_invalid/,
    );
  });
});

describe('recovery.cancelHeldCarts (RT-1563)', () => {
  it('cancels every parked draft with one approval: one audit row and one outbox row per sale', async () => {
    insertParked('p1');
    insertParked('p2', 'op-other');
    insertParked('p3');
    const { batch_id } = prepared(['p1', 'p2', 'p3']);
    const id = await approve('recovery.cancel_held_carts', batch_id);
    audit = [];
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: id })).toEqual({
      kind: 'cancelled_batch',
      cancelled_cart_ids: ['p1', 'p2', 'p3'],
      skipped: [],
    });
    expect(
      value(
        `SELECT COUNT(*) FROM carts WHERE state = 'cancelled' AND cancellation_reason = 'manager_cancelled_held'`,
      ),
    ).toBe(3);
    expect(
      value(
        `SELECT COUNT(*) FROM cart_action_outbox WHERE action_kind = 'cart.void' AND attribution_operator_id = 'op-mgr'`,
      ),
    ).toBe(3);
    expect(value(`SELECT acting_operator_id FROM cart_action_outbox WHERE cart_id = 'p2'`)).toBe(
      'op-other',
    );
    expect(categories()).toEqual([
      'cart.held_cancelled_by_manager',
      'cart.held_cancelled_by_manager',
      'cart.held_cancelled_by_manager',
    ]);
    expect(audit.map((e) => e.acting_operator_id).sort()).toEqual([
      CASHIER_OP,
      CASHIER_OP,
      'op-other',
    ]);
    expect(audit.every((e) => e.approving_supervisor_id === MANAGER.userId)).toBe(true);
    expect(audit.every((e) => (e.payload as { parked?: boolean }).parked === true)).toBe(true);
    // ONE approval, consumed once; the shift-close count no longer sees these sales.
    expect(value(`SELECT COUNT(*) FROM manager_approvals WHERE consumed_at IS NOT NULL`)).toBe(1);
    expect(value(PARKED_COUNT_SQL)).toBe(0);
    expect(endRecoverySession).not.toHaveBeenCalled();
  });

  it('is single use: the same approval and batch cannot be replayed', async () => {
    insertParked('p1');
    const { batch_id } = prepared(['p1']);
    const id = await approve('recovery.cancel_held_carts', batch_id);
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: id }).kind).toBe('cancelled_batch');
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
  });

  it('needs a valid approval of ITS kind and batch; a refusal cancels nothing and spends nothing', async () => {
    insertParked('p1');
    insertParked('p2');
    const { batch_id } = prepared(['p1', 'p2']);
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: UNKNOWN_APPROVAL })).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    // A single-cart approval is for a different kind.
    const single = await approve('recovery.cancel_held_cart', 'p1');
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: single })).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    // An approval of another batch is for a different subject.
    const other = prepared(['p1']);
    const otherId = await approve('recovery.cancel_held_carts', other.batch_id);
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: otherId })).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(value(PARKED_COUNT_SQL)).toBe(2);
    expect(value(`SELECT COUNT(*) FROM manager_approvals WHERE consumed_at IS NOT NULL`)).toBe(0);
  });

  it('only the signed-in manager’s own approval is usable (RT-441 recovery rule)', async () => {
    insertParked('p1');
    const { batch_id } = prepared(['p1']);
    const id = await approve('recovery.cancel_held_carts', batch_id, OTHER_MANAGER).catch(
      () => null,
    );
    // The approver must be the signed-in manager (MANAGER): a different manager's PIN is refused at the request.
    expect(id).toBeNull();
  });

  it('skips a cart that changed or left parking since the snapshot, and cancels the rest', async () => {
    insertParked('p-ok');
    insertParked('p-edited');
    insertParked('p-resumed');
    insertParked('p-gone');
    const { batch_id } = prepared(['p-ok', 'p-edited', 'p-resumed', 'p-gone']);
    const id = await approve('recovery.cancel_held_carts', batch_id);
    raw.run(`UPDATE carts SET last_action_id = 'a-new' WHERE cart_id = 'p-edited'`);
    raw.run(`UPDATE carts SET parked_at = NULL WHERE cart_id = 'p-resumed'`);
    raw.run(`UPDATE carts SET state = 'cancelled' WHERE cart_id = 'p-gone'`);
    audit = [];
    const out = recovery.cancelHeldCarts({ batch_id, approval_id: id });
    expect(out).toEqual({
      kind: 'cancelled_batch',
      cancelled_cart_ids: ['p-ok'],
      skipped: expect.arrayContaining<{ cart_id: string; reason: string }>([
        { cart_id: 'p-edited', reason: 'changed' },
        { cart_id: 'p-resumed', reason: 'changed' },
        { cart_id: 'p-gone', reason: 'no_longer_held' },
      ]) as unknown,
    });
    expect(out.kind === 'cancelled_batch' && out.skipped).toHaveLength(3);
    expect(value(`SELECT state FROM carts WHERE cart_id = 'p-edited'`)).toBe('editing');
    expect(value(`SELECT state FROM carts WHERE cart_id = 'p-resumed'`)).toBe('editing');
    expect(categories()).toEqual(['cart.held_cancelled_by_manager']);
  });

  it('rolls everything back, approval included, when a write fails part-way', async () => {
    insertParked('p1');
    insertParked('p2');
    const real = bindCartStore(handle);
    let calls = 0;
    recovery = buildRecovery({
      cartStore: {
        cancelCartAndOutbox: (...args) => {
          calls += 1;
          if (calls === 2) throw new Error('disk full');
          real.cancelCartAndOutbox(...args);
        },
      },
    });
    const { batch_id } = prepared(['p1', 'p2']);
    const id = await approve('recovery.cancel_held_carts', batch_id);
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'recovery_unavailable',
    });
    expect(value(PARKED_COUNT_SQL)).toBe(2);
    expect(
      value(`SELECT consumed_at FROM manager_approvals WHERE approval_id = ?`, [id]),
    ).toBeNull();
    expect(categories().filter((c) => c === 'cart.held_cancelled_by_manager')).toEqual([]);
  });

  it('a batch expires: a snapshot older than ten minutes is gone', async () => {
    insertParked('p1');
    let clock = NOW;
    recovery = buildRecovery({ clock: () => new Date(clock) });
    const { batch_id } = prepared(['p1']);
    const id = await approve('recovery.cancel_held_carts', batch_id);
    clock = '2026-10-13T09:10:01.000Z';
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
    expect(value(PARKED_COUNT_SQL)).toBe(1);
  });

  it('keeps at most eight open batches: the oldest is dropped', () => {
    insertParked('p1');
    const first = prepared(['p1']);
    for (let i = 0; i < 8; i += 1) prepared(['p1']);
    expect(
      recovery.cancelHeldCarts({ batch_id: first.batch_id, approval_id: UNKNOWN_APPROVAL }),
    ).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
  });

  it('refuses for a cashier session and for an unknown batch', () => {
    insertParked('p1');
    const { batch_id } = prepared(['p1']);
    expect(
      recovery.cancelHeldCarts({
        batch_id: 'f'.repeat(8) + '-0000-4000-8000-000000000000',
        approval_id: UNKNOWN_APPROVAL,
      }),
    ).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
    current = manager({ role: 'cashier' });
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: UNKNOWN_APPROVAL })).toEqual({
      kind: 'refused',
      reason: 'role_mismatch',
    });
  });
});

describe('recovery batch — integrity guards (RT-1563 review)', () => {
  it('a failed audit write rolls the whole batch back: no cancel without its audit rows', async () => {
    insertParked('p1');
    insertParked('p2');
    let writes = 0;
    recovery = buildRecovery({
      auditEmitter: {
        emit: (event) => {
          writes += 1;
          if (writes === 2) throw new Error('audit store unavailable');
          audit.push(event);
        },
      },
    });
    const { batch_id } = prepared(['p1', 'p2']);
    const id = await approve('recovery.cancel_held_carts', batch_id);
    writes = 0;
    audit = [];
    expect(recovery.cancelHeldCarts({ batch_id, approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'recovery_unavailable',
    });
    expect(value(PARKED_COUNT_SQL)).toBe(2);
    expect(
      value(`SELECT consumed_at FROM manager_approvals WHERE approval_id = ?`, [id]),
    ).toBeNull();
    expect(value(`SELECT COUNT(*) FROM cart_action_outbox WHERE action_kind = 'cart.void'`)).toBe(
      0,
    );
  });

  it('refuses a batch whose total is not a safe integer, and makes no batch', () => {
    insertParked('big-1');
    insertParked('big-2');
    insertParked('big-3');
    for (const id of ['big-1', 'big-2', 'big-3']) {
      raw.run(`UPDATE carts SET cart_subtotal_minor = ? WHERE cart_id = ?`, [
        id === 'big-1' ? Number.MAX_SAFE_INTEGER : 1,
        id,
      ]);
    }
    // Each amount is a safe integer, the sum is not: 2^53 - 1 + 1 + 1.
    expect(recovery.prepareCancelHeldCarts({ cart_ids: ['big-1', 'big-2', 'big-3'] })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
    // A smaller, safe selection from the same list still prepares.
    expect(prepared(['big-2', 'big-3']).total_minor).toBe(2);
  });
});
