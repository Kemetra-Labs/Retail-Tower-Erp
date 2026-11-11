/**
 * RT-1326 (RT-1125 R-17) — the cashier PIN lockout holds under concurrent
 * attempts.
 *
 * Every attempt reads the row, awaits Argon2, then writes the failure count it
 * computed from that read. Without serialisation, N parallel wrong PINs all
 * read the same count and each write count + 1, so more than five guesses fit
 * in one lockout, and a late failure can overwrite a concurrent success's
 * reset. Sign-in and the same-operator unlock (`verifyPin`) share the row, so
 * they must share the serialisation too.
 *
 * Real migrated schema (sql.js), real Argon2id, real sign-in handler; only the
 * Backend-Core admission is faked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { CashierSignInHandler } from '../sign-in-handler.js';
import { SessionManager } from '../session-manager.js';
import { ProtoSessionStore } from '../takeover-handler.js';
import { hashPin } from '../pin-credential.js';
import { PinManagementHandler, type PinManagementHandlerDeps } from '../pin-management.js';
import type { AuditEmitter } from '../../audit/audit-emitter.js';
import { sealPinMaterial } from '../pin-seal.js';
import { FAKE_USER_ID, fakeCashierAdmission } from './__helpers__/fake-cashier-admission.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { SafeStorageLike } from '../../secrets/safe-storage.js';
import type { PairingStore } from '../../pairing/store.js';

const TENANT = 'tenant-1326';
const BRANCH = 'branch-1326';
const TERMINAL = 'term-1326';
const CASHIER = 'op-cashier-1326';
const PIN = '4321';
const WRONG = '9999';

const PREFIX = Buffer.from('SEALED:', 'utf8');
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => Buffer.from(buf).subarray(PREFIX.length).toString('utf8'),
};

const pairingStore = {
  getStatus: () =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      terminal_label: 'T',
      paired_at: 0,
    }),
  persist: () => Promise.resolve(),
  clear: () => Promise.resolve(),
} as unknown as PairingStore;

let raw: SqlJsDatabase;
let handler: CashierSignInHandler;
let sealed: { pin_hash: Buffer; pin_salt: Buffer };

beforeAll(async () => {
  await initSalesSyncSql();
  const { pin_hash, pin_salt } = await hashPin(PIN);
  sealed = sealPinMaterial({ pin_hash, pin_salt }, safeStorage);
}, 20_000);

beforeEach(() => {
  raw = freshSalesSyncDb();
  handler = new CashierSignInHandler({
    db: handleFor(raw),
    safeStorage,
    sessionManager: new SessionManager(),
    admission: fakeCashierAdmission().deps,
    pairingStore,
    protoStore: new ProtoSessionStore(),
  });
});

afterEach(() => {
  raw.close();
});

function provision(failedCount: number): void {
  raw.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, user_id, cashier_clerk_user_id,
        pin_hash, pin_salt, failed_attempt_count, lockout_until, created_at, created_by_operator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '2026-11-01T00:00:00.000Z', 'op-manager-1')`,
    [
      TENANT,
      BRANCH,
      TERMINAL,
      FAKE_USER_ID,
      CASHIER,
      sealed.pin_hash,
      sealed.pin_salt,
      failedCount,
    ],
  );
}

function lockoutState(): { count: number; until: string | null } {
  const res = raw.exec(
    `SELECT failed_attempt_count, lockout_until FROM cashier_pin_records
      WHERE cashier_clerk_user_id = ?`,
    [CASHIER],
  );
  const row = res[0]?.values[0];
  if (row === undefined) throw new Error('pin row missing');
  return { count: Number(row[0]), until: (row[1] as string | null) ?? null };
}

function categoryOf(res: unknown): string | null {
  if (res === null) return null;
  const r = res as { kind?: string; category?: string };
  return r.category ?? r.kind ?? null;
}

describe('RT-1326 cashier PIN lockout under concurrent attempts', () => {
  it('counts at most five failures per lockout when ten wrong PINs arrive at once', async () => {
    provision(0);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        handler.signIn({
          kind: 'cashier',
          cashier_clerk_user_id: CASHIER,
          pin: WRONG,
          display_name: 'Cashier',
        }),
      ),
    );
    const state = lockoutState();
    expect(state.count).toBe(5);
    expect(state.until).not.toBeNull();
    const categories = results.map(categoryOf);
    expect(categories.filter((c) => c === 'invalid_input')).toHaveLength(5);
    expect(categories.filter((c) => c === 'rate_limited')).toHaveLength(5);
  }, 60_000);

  it('serialises sign-in with the same-operator unlock on one PIN row', async () => {
    provision(0);
    await Promise.all([
      ...Array.from({ length: 3 }, () =>
        handler.signIn({
          kind: 'cashier',
          cashier_clerk_user_id: CASHIER,
          pin: WRONG,
          display_name: 'Cashier',
        }),
      ),
      ...Array.from({ length: 3 }, () => handler.verifyPin(CASHIER, WRONG)),
    ]);
    const state = lockoutState();
    expect(state.count).toBe(5);
    expect(state.until).not.toBeNull();
  }, 60_000);

  it('never lets a concurrent failure overwrite a success that ran before it', async () => {
    provision(3);
    const [match, miss] = await Promise.all([
      handler.verifyPin(CASHIER, PIN),
      handler.verifyPin(CASHIER, WRONG),
    ]);
    expect(match).toBeNull();
    expect(categoryOf(miss)).toBe('invalid_input');
    // The success reset the count to 0; the later failure counts from there.
    expect(lockoutState()).toEqual({ count: 1, until: null });
  }, 60_000);

  it('does not let an in-flight wrong attempt undo a manager unlock that lands during it', async () => {
    provision(4);
    const manager = {
      id: 'sess-manager',
      operator_id: 'op-manager-1',
      display_name: 'Manager',
      role: 'manager' as const,
      tenant_id: TENANT,
      branch_id: BRANCH,
      backend_session_id: 'be-1',
      started_at: '2026-11-11T09:00:00.000Z',
      last_activity_at: '2026-11-11T09:00:00.000Z',
    };
    const pins = new PinManagementHandler({
      db: handleFor(raw),
      safeStorage,
      sessionManager: { getCurrent: () => manager } as unknown as SessionManager,
      pairingStore,
      auditEmitter: { emit: () => undefined } as unknown as AuditEmitter,
    } as unknown as PinManagementHandlerDeps);
    // The fifth wrong PIN locks the cashier; the manager unlock, asked while
    // that attempt is still verifying, must apply after it, not under it.
    const attempt = handler.signIn({
      kind: 'cashier',
      cashier_clerk_user_id: CASHIER,
      pin: WRONG,
      display_name: 'Cashier',
    });
    const unlock = pins.unlockCashier({ event_id: 'evt-1326', target_cashier_id: CASHIER });
    expect(categoryOf(await attempt)).toBe('invalid_input');
    expect((await unlock).kind).toBe('unlocked');
    expect(lockoutState()).toEqual({ count: 0, until: null });
  }, 60_000);
});
