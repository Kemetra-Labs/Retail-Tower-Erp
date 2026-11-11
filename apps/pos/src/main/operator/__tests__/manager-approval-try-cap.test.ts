/**
 * RT-1326 (RT-1125 R-37) — a cashier's approval request has a bounded number of
 * approver PIN tries, the disable-after-three-lockouts guard still holds, and
 * every failed approver PIN is attributed to the requesting cashier.
 *
 * Owner decision 2026-11-11 (RT-1326): cap PIN tries per approval request,
 * keep the disable guard, record which cashier caused it. Decided under the
 * owner's delegation (2026-11-11): the request is keyed by the cashier session,
 * the action kind and the subject; three wrong approver PINs refuse that
 * request with `approval_attempts_exhausted` for five minutes, without
 * consulting the PIN store; a granted approval or a new session starts afresh.
 *
 * Full migration stack (sql.js), real manager PIN store (Argon2id) and real
 * approval service. The subject resolver is a fixed stand-in so that switching
 * cashier sessions does not change the subject.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from './__helpers__/offline-grant-fixture.js';
import { createManagerPinStore, type ManagerPinStore } from '../manager-pin-store.js';
import { createManagerCredentialAudit } from '../manager-credential-audit.js';
import {
  APPROVAL_TRY_CAP,
  APPROVAL_TRY_WINDOW_MS,
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../manager-approval-service.js';
import type { OperatorSessionRecord } from '../session-manager.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { ManagerApprovalRequest } from '../../../shared/operator/manager-approval.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const WRONG = '135799';
const T0 = '2026-11-11T09:00:00.000Z';

function cashierSession(id: string): OperatorSessionRecord {
  return {
    id,
    operator_id: 'op-cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: T0,
    backend_session_id: `b-${id}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    user_id: CASHIER_USER,
  };
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let service: ManagerApprovalService;
let current: OperatorSessionRecord | null;
let clockMs: number;
let audit: AuditEvent[];
const SUBJECT = 'cart-1326';
let verifySpy: Mock<ManagerPinStore['verify']>;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clockMs = Date.parse(T0);
  vi.setSystemTime(clockMs);
  raw = freshGrantDb();
  const db = handleFor(raw);
  audit = [];
  current = cashierSession('sess-1');
  const emitter = { emit: (e: AuditEvent) => audit.push(e) };
  pins = createManagerPinStore({
    db,
    safeStorage: aeadSafeStorage(),
    onEvent: createManagerCredentialAudit({ auditEmitter: emitter }),
  });
  await pins.enrol({
    scope: SCOPE,
    userId: MANAGER.userId,
    displayName: 'Mona Manager',
    sealed: await pins.seal(MANAGER.pin),
    now: T0,
    onlineAt: T0,
    guard: () => undefined,
  });
  verifySpy = vi.fn<ManagerPinStore['verify']>((input) => pins.verify(input));
  service = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: { verify: verifySpy, list: (input) => pins.list(input) },
    resolvers: {
      'cart.cancel_post_handoff': ({ subjectRef }) =>
        subjectRef === SUBJECT ? { version: 'v1', amountMinor: 12500 } : null,
    },
    auditEmitter: emitter,
    now: () => new Date(clockMs).toISOString(),
  });
}, 20_000);

afterEach(() => {
  raw.close();
  vi.useRealTimers();
});

function managerRef(): string {
  return pins.list({ scope: SCOPE, now: T0 })[0]?.managerRef ?? '';
}

function ask(pin: string, over: Partial<ManagerApprovalRequest> = {}) {
  return service.request({
    action_kind: 'cart.cancel_post_handoff',
    subject_ref: SUBJECT,
    reason_code: 'customer_left',
    approver_ref: managerRef(),
    pin,
    ...over,
  });
}

function advance(ms: number): void {
  clockMs += ms;
  vi.setSystemTime(clockMs);
}

function refusedEvents(): AuditEvent[] {
  return audit.filter((e) => e.action_category === 'manager_approval.refused');
}

describe('RT-1326 approval request PIN try cap', () => {
  it('caps a request at three wrong approver PINs, then refuses without checking the PIN', async () => {
    expect(APPROVAL_TRY_CAP).toBe(3);
    for (let i = 0; i < APPROVAL_TRY_CAP; i++) {
      expect(await ask(WRONG)).toEqual({ kind: 'refused', reason: 'approval_unavailable' });
    }
    const callsBefore = verifySpy.mock.calls.length;
    expect(await ask(MANAGER.pin)).toEqual({
      kind: 'refused',
      reason: 'approval_attempts_exhausted',
    });
    expect(verifySpy.mock.calls.length).toBe(callsBefore);
  }, 60_000);

  it('lets the same request be raised again after the window', async () => {
    for (let i = 0; i < APPROVAL_TRY_CAP; i++) await ask(WRONG);
    advance(APPROVAL_TRY_WINDOW_MS + 1);
    const outcome = await ask(MANAGER.pin);
    expect(outcome.kind).toBe('approved');
  }, 60_000);

  it('counts per cashier session: a new session starts afresh', async () => {
    for (let i = 0; i < APPROVAL_TRY_CAP; i++) await ask(WRONG);
    current = cashierSession('sess-2');
    expect((await ask(MANAGER.pin)).kind).toBe('approved');
  }, 60_000);

  it('clears the count when the request is granted', async () => {
    await ask(WRONG);
    await ask(WRONG);
    expect((await ask(MANAGER.pin)).kind).toBe('approved');
    for (let i = 0; i < APPROVAL_TRY_CAP; i++) {
      expect(await ask(WRONG)).toEqual({ kind: 'refused', reason: 'approval_unavailable' });
    }
  }, 60_000);

  it('attributes every failed approver PIN, and the cap, to the requesting cashier', async () => {
    for (let i = 0; i < APPROVAL_TRY_CAP + 1; i++) await ask(WRONG);
    const events = refusedEvents();
    expect(events).toHaveLength(APPROVAL_TRY_CAP + 1);
    for (const e of events) {
      expect(e.acting_operator_id).toBe('op-cashier-1');
      expect(e.session_id).toBe('sess-1');
      expect(e.payload).toMatchObject({
        action_kind: 'cart.cancel_post_handoff',
        subject_ref: SUBJECT,
        approver_ref: managerRef(),
        requester_user_id: CASHIER_USER,
      });
    }
    expect(events.map((e) => (e.payload as { failed_tries: number }).failed_tries)).toEqual([
      1, 2, 3, 3,
    ]);
    expect((events[3]?.payload as { outcome: string }).outcome).toBe('attempts_exhausted');
    expect(JSON.stringify(events)).not.toContain(WRONG);
  }, 60_000);

  it('keeps the disable-after-three-lockouts guard and names the cashier who triggered it', async () => {
    let n = 0;
    for (let lockout = 0; lockout < 3; lockout++) {
      for (let tries = 0; tries < 5; tries++) {
        current = cashierSession(`sess-${String(n++)}`);
        await ask(WRONG);
      }
      advance(6 * 60 * 1000);
    }
    expect(pins.list({ scope: SCOPE, now: new Date(clockMs).toISOString() })).toEqual([]);
    const disabled = audit.filter((e) => e.action_category === 'manager_credential.disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.acting_operator_id).toBe('op-cashier-1');
  }, 120_000);
});
