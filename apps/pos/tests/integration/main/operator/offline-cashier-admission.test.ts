import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import pino from 'pino';

import { registerOperatorHandlers } from '../../../../src/main/ipc/operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../../src/shared/operator/channels.js';
import { createBackendClient } from '../../../../src/main/operator/backend-client.js';
import { createCashierAdmissionClient } from '../../../../src/main/operator/cashier-admission-client.js';
import type { CashierAdmissionDeps } from '../../../../src/main/operator/cashier-admission.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import {
  CashierSignInHandler,
  SignInHandler,
} from '../../../../src/main/operator/sign-in-handler.js';
import { SignOutHandler } from '../../../../src/main/operator/sign-out-handler.js';
import { RosterHandler } from '../../../../src/main/operator/roster-handler.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import {
  ProtoSessionStore,
  TakeoverHandler,
} from '../../../../src/main/operator/takeover-handler.js';
import { hashPin } from '../../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../../src/main/operator/pin-seal.js';
import {
  OFFLINE_GRANT_MAX_USES,
  createOfflineGrantStore,
  type OfflineGrantStore,
} from '../../../../src/main/operator/offline-grant-store.js';
import {
  createOfflineGrantWiring,
  type OfflineGrantWiring,
} from '../../../../src/main/operator/offline-grant-wiring.js';
import { offlineAuthorityExpired } from '../../../../src/main/operator/offline-authority.js';
import type {
  ClerkExchanger,
  ClerkExchangeResult,
} from '../../../../src/main/operator/clerk-client.js';
import type { InactivityMonitor } from '../../../../src/main/operator/inactivity-monitor.js';
import type { PinManagementHandler } from '../../../../src/main/operator/pin-management.js';
import type { ForcedCloseHandler } from '../../../../src/main/operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../../../../src/main/operator/stuck-shifts-handler.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type { SessionAdmission } from '../../../../src/main/operator/session-admission.js';
import {
  aeadSafeStorage,
  grantBlob,
  grantDb,
  initGrantSql,
  setGrantBlob,
  type GrantDb,
} from '../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';

/**
 * RT-308 (RT-113 P3) — offline cashier admission through the REAL operator IPC,
 * cashier sign-in handler, admission client, grant wiring and sealed grant
 * store (full migration stack), with Backend-Core stubbed at `fetch`.
 *
 * Acceptance (Jira RT-308): admit the cashier only from a valid sealed grant
 * on the same paired terminal, same identity, through `sessionManager.create`;
 * PIN still required; the use persisted before admission; fail closed on an
 * expired, missing, tampered or unsealable grant, scope mismatch, the 8-use
 * budget, a clock rollback > 5 min, a failed counter write and a storage
 * failure; 24 h default / 72 h ceiling; restart consumes another admission;
 * offline roster; managers get no offline start; Backend-Core never bypassed.
 */

// Every sign-in verifies an Argon2id PIN; several per test. Generous under CI load.
vi.setConfig({ testTimeout: 20_000 });

const BASE = 'https://bc.example.test';
const DEVICE_TOKEN = 'dev-tok-0a1b2c3d4e5f-SECRET';
const PIN = '739182';
const USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
const OTHER_USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789def';
const CLERK_ID = 'user_clerk_cashier_1';
const OTHER_CLERK_ID = 'user_clerk_cashier_2';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const TTL_S = 600;
const T0 = new Date('2026-10-26T08:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const SCOPE = {
  tenant_id: 't1',
  branch_id: 'b1',
  terminal_id: 'term-1',
  pairing_epoch: 1_790_000_000,
};

const PREFIX = Buffer.from('SEALED:', 'utf8');
const pinSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => buf.subarray(PREFIX.length).toString('utf8'),
};

let pinRow: Record<string, unknown>;

beforeAll(async () => {
  await initGrantSql();
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, pinSafeStorage);
  pinRow = {
    tenant_id: SCOPE.tenant_id,
    branch_id: SCOPE.branch_id,
    terminal_id: SCOPE.terminal_id,
    cashier_clerk_user_id: CLERK_ID,
    user_id: USER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ADMISSIONS = '/api/pos/v1/cashier-admissions';
const ROSTER = '/api/pos/v1/cashier-admissions/roster';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorJson(status: number): Response {
  return json(status, { error: { code: 'x', message: 'x', request_id: 'r' } });
}

function admittedBody(offline_grace_seconds = 86_400): Record<string, unknown> {
  return {
    kind: 'admitted',
    admission_id: ADMISSION_ID,
    offline_grace_seconds,
    admission_ttl_seconds: TTL_S,
    server_time: '2026-10-26T08:00:00.000Z',
    display_name: 'Mona',
    admission_generation: 'gen-default-0000',
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The stubbed network: `online` false makes every request fail at the transport. */
interface Net {
  online: boolean;
  /** The next admission answers, in order; then `admitted`. */
  answers: (() => Response)[];
  admissionPosts: number;
  ends: number;
  rosterCalls: number;
  grace: number;
  /** Runs as each request goes out (before the transport fails or answers). */
  onSend?: () => void;
}

interface Wired {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  sessions: SessionManager;
  keeper: CashierAdmissionKeeper;
  grants: OfflineGrantWiring;
  audits: AuditEvent[];
  logLines: string[];
  creates: string[];
}

let g: GrantDb;
let store: OfflineGrantStore;
let net: Net;
let mono: number;
/** Make the next sealed write fail (a failed counter write). */
let failSeal: boolean;
/** The pairing epoch the sign-in handler reads (RT-215). */
let pairingEpoch: string;
/** The RT-444 sign-in admission guard, when a test installs one. */
let guard: SessionAdmission | undefined;

const managerClerk: { result: ClerkExchangeResult } = { result: { kind: 'no_connection' } };

function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  net.onSend?.();
  if (!net.online) return Promise.reject(new TypeError('fetch failed'));
  const path = urlOf(input).slice(BASE.length);
  if (init?.method === 'POST' && path === ADMISSIONS) {
    net.admissionPosts += 1;
    return Promise.resolve((net.answers.shift() ?? (() => json(200, admittedBody(net.grace))))());
  }
  if (path.endsWith('/end')) {
    net.ends += 1;
    return Promise.resolve(json(200, { kind: 'ended' }));
  }
  if (path === ROSTER) {
    net.rosterCalls += 1;
    return Promise.resolve(
      json(200, {
        cashiers: [
          { user_id: USER_ID, operator_id: CLERK_ID, display_name: 'Mona' },
          { user_id: OTHER_USER_ID, operator_id: OTHER_CLERK_ID, display_name: 'Other' },
        ],
      }),
    );
  }
  return Promise.resolve(errorJson(401));
}

/** One app process: a restart is a new `wire()` on the same database. */
function wire(): Wired {
  const logLines: string[] = [];
  const logger = pino({ level: 'trace' }, { write: (s: string) => void logLines.push(s) });
  const audits: AuditEvent[] = [];
  let seq = 0;
  const grants = createOfflineGrantWiring({
    store,
    audit: { emit: (e) => void audits.push(e) },
    uuid: () => `evt-g-${String(++seq)}`,
    now: () => new Date(),
    logger,
  });
  grants.setScope(SCOPE);
  const sessions = new SessionManager();
  const creates: string[] = [];
  const create = sessions.create.bind(sessions);
  sessions.create = (input) => {
    creates.push(input.offline_admission === undefined ? 'online' : 'offline');
    return create(input);
  };
  const protoStore = new ProtoSessionStore();
  const backend = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
  const admissionClient = createCashierAdmissionClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    getDeviceToken: () => Promise.resolve(DEVICE_TOKEN),
  });
  const admission: CashierAdmissionDeps = { client: admissionClient, grantSeam: grants.seam };
  const keeper = new CashierAdmissionKeeper({
    sessionManager: sessions,
    admission,
    isAtSafePoint: () => true,
    logger,
  });
  const pairingStore: PairingStore = {
    getStatus: () =>
      Promise.resolve({
        kind: 'paired',
        tenant_id: SCOPE.tenant_id,
        branch_id: SCOPE.branch_id,
        terminal_id: SCOPE.terminal_id,
        terminal_label: 'T1',
        paired_at: SCOPE.pairing_epoch,
      }),
    getCurrentTerminalId: () => SCOPE.terminal_id,
    persist: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
  const db = {
    prepare: (sql: string) =>
      /^\s*SELECT\s+c\.closed_at/i.test(sql)
        ? { get: () => undefined }
        : /^\s*SELECT/i.test(sql)
          ? { get: () => pinRow }
          : { run: () => undefined },
  } as unknown as DatabaseHandle;
  const auditEmitter = { emit: vi.fn() } as unknown as AuditEmitter;
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  const clerk: ClerkExchanger = { exchange: () => Promise.resolve(managerClerk.result) };
  registerOperatorHandlers(ipcMain, {
    signInHandler: new SignInHandler({
      clerk,
      backend,
      sessionManager: sessions,
      deviceTokenAttestation: () => DEVICE_TOKEN,
      protoStore,
      logger,
    }),
    cashierSignInHandler: new CashierSignInHandler({
      db,
      safeStorage: pinSafeStorage,
      sessionManager: sessions,
      admission,
      pairingStore,
      protoStore,
      pairingEpoch: () => pairingEpoch,
      sessionAdmission: {
        check: (c) => guard?.check(c) ?? { kind: 'admitted' },
        admit: (c) => guard?.admit(c) ?? { kind: 'admitted' },
      },
      offline: {
        grants,
        audit: { emit: (e) => void audits.push(e) },
        uuid: () => `evt-o-${String(++seq)}`,
        now: () => new Date(),
        monotonicNow: () => mono,
        logger,
      },
      logger,
    }),
    signOutHandler: new SignOutHandler({ backend, sessionManager: sessions, jwtFor: () => null }),
    rosterHandler: new RosterHandler({
      cashierAdmissions: admissionClient,
      offlineCashiers: () => grants.listAdmissible(new Date()),
      logger,
    }),
    sessionManager: sessions,
    inactivityMonitor: { reportActivity: vi.fn() } as unknown as InactivityMonitor,
    auditEmitter,
    pairingStore,
    takeoverHandler: new TakeoverHandler({
      protoStore,
      sessionManager: sessions,
      backend,
      jwtHolder: { set: vi.fn(), get: vi.fn(() => null), clear: vi.fn() },
      auditEmitter,
      pairingStore,
      deviceTokenAttestation: () => DEVICE_TOKEN,
      cashierAdmission: admission,
      logger,
    }),
    pinManagementHandler: {} as PinManagementHandler,
    forcedCloseHandler: {} as ForcedCloseHandler,
    stuckShiftsHandler: {} as StuckShiftsHandler,
  });
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (fn === undefined) throw new Error(`no handler for ${channel}`);
    return await fn({} as IpcMainInvokeEvent, ...args);
  };
  return { invoke, sessions, keeper, grants, audits, logLines, creates };
}

function signIn(w: Wired, pin = PIN): Promise<unknown> {
  return w.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, {
    kind: 'cashier',
    cashier_clerk_user_id: CLERK_ID,
    pin,
    display_name: 'picker-name',
  });
}

function signOut(w: Wired): Promise<unknown> {
  return w.invoke(OPERATOR_IPC_CHANNELS.SIGN_OUT);
}

function roster(w: Wired): Promise<unknown> {
  return w.invoke(OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER);
}

/** The grant's offline uses spent so far (store read; -1 when not admissible). */
function usesSpent(): number {
  const e = store.evaluate(SCOPE, USER_ID, new Date());
  return e.admissible ? e.grant.offline_admissions_used : -1;
}

function offlineAudits(w: Wired): unknown[] {
  return w.audits
    .filter((a) => a.action_category.startsWith('operator.signin.offline_'))
    .map((a) => [a.action_category, a.payload]);
}

const REFUSED_OFFLINE = { kind: 'refused', category: 'no_connection' };

/** Online sign-in (writes the grant), sign out, then the network goes down. */
async function grantThenGoOffline(w: Wired): Promise<void> {
  expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
  await signOut(w);
  net.online = false;
}

const live: Wired[] = [];
function track(w: Wired): Wired {
  live.push(w);
  return w;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(T0);
  mono = 1_000;
  failSeal = false;
  pairingEpoch = 'epoch-1';
  guard = undefined;
  net = { online: true, answers: [], admissionPosts: 0, ends: 0, rosterCalls: 0, grace: 86_400 };
  managerClerk.result = { kind: 'no_connection' };
  g = grantDb();
  const aead = aeadSafeStorage();
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      if (failSeal) throw new Error('DPAPI write failed');
      return aead.encryptString(plain);
    },
    decryptString: (buf) => aead.decryptString(buf),
  };
  store = createOfflineGrantStore({ db: g.handle, safeStorage, now: () => new Date() });
});

afterEach(() => {
  for (const w of live.splice(0)) {
    w.keeper.stop();
    w.grants.stop();
  }
  vi.useRealTimers();
  g.raw.close();
});

describe('RT-308 — admission from a valid sealed grant', () => {
  it('admits the SAME cashier offline, with the server name and the offline bound', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    const res = (await signIn(w)) as { kind: string; session: Record<string, unknown> };
    expect(res.kind).toBe('signed_in');
    expect(res.session).toMatchObject({
      operator_id: CLERK_ID,
      display_name: 'Mona',
      role: 'cashier',
      tenant_id: SCOPE.tenant_id,
      branch_id: SCOPE.branch_id,
    });
    const s = w.sessions.getCurrent();
    expect(s).toMatchObject({
      operator_id: CLERK_ID,
      user_id: USER_ID,
      role: 'cashier',
      authority: 'offline_grant',
      backend_session_id: '',
      authority_valid_until_ms: T0.getTime() + 24 * HOUR,
      authority_deadline_mono_ms: mono + 24 * HOUR,
    });
    // No server admission is held: nothing to heartbeat or end.
    expect(s?.admission_id).toBeUndefined();
    expect(s?.admission_generation).toBeUndefined();
    expect(offlineAudits(w)).toEqual([['operator.signin.offline_admitted', {}]]);
    expect(w.audits.at(-1)?.session_id).toBe(s?.id);
  });

  it('persists the use BEFORE the session exists', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    const seen: number[] = [];
    w.sessions.onStarted(() => seen.push(usesSpent()));
    await signIn(w);
    expect(seen).toEqual([1]);
  });

  it('online and offline admission both go through sessionManager.create (OD12)', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    await signIn(w);
    expect(w.creates).toEqual(['online', 'offline']);
  });

  it('an offline session never heartbeats, never ends a server admission', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    await signIn(w);
    const before = { posts: net.admissionPosts, ends: net.ends };
    net.online = true; // even if the network came back, nothing is sent for it
    await vi.advanceTimersByTimeAsync(TTL_S * 1000 * 2);
    await signOut(w);
    expect({ posts: net.admissionPosts, ends: net.ends }).toEqual(before);
  });

  it('a 5xx from Backend-Core counts as unreachable', async () => {
    const w = track(wire());
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
    await signOut(w);
    net.answers.push(() => errorJson(503));
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
    expect(w.sessions.getCurrent()?.authority).toBe('offline_grant');
  });

  it('never logs a grant field, PIN or token', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    await signIn(w);
    await signIn(w, '000000');
    const logs = w.logLines.join('\n');
    for (const v of [USER_ID, ADMISSION_ID, 'Mona', PIN, DEVICE_TOKEN]) {
      expect(logs).not.toContain(v);
    }
  });
});

describe('RT-308 — refusals fail closed', () => {
  it('the PIN is still required: a wrong PIN spends nothing and admits nobody', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    expect(await signIn(w, '000000')).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(w.sessions.getCurrent()).toBeNull();
    expect(usesSpent()).toBe(0);
  });

  it('a first login (no grant) is refused', async () => {
    const w = track(wire());
    net.online = false;
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(w.sessions.getCurrent()).toBeNull();
    expect(offlineAudits(w)).toEqual([
      ['operator.signin.offline_refused', { category: 'grant_missing' }],
    ]);
  });

  it('8 offline admissions per grant, each restart consuming one; the 9th is refused', async () => {
    await grantThenGoOffline(track(wire()));
    for (let i = 1; i <= OFFLINE_GRANT_MAX_USES; i += 1) {
      const w = track(wire()); // an app restart while offline: the session is gone
      expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
      expect(usesSpent()).toBe(i === OFFLINE_GRANT_MAX_USES ? -1 : i);
    }
    const w = track(wire());
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(offlineAudits(w)).toEqual([
      ['operator.signin.offline_refused', { category: 'count_exhausted' }],
    ]);
  }, 60_000);

  it('a sign-out and sign-in in the same process consumes another admission', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    await signIn(w);
    await signOut(w);
    await signIn(w);
    expect(usesSpent()).toBe(2);
  });

  it('expires at the 24 h default', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    vi.setSystemTime(T0.getTime() + 24 * HOUR - MIN);
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
    await signOut(w);
    vi.setSystemTime(T0.getTime() + 24 * HOUR);
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(offlineAudits(w).at(-1)).toEqual([
      'operator.signin.offline_refused',
      { category: 'grant_expired' },
    ]);
  });

  it('clamps a longer server grace to the 72 h hard cap', async () => {
    net.grace = 30 * 24 * 3600;
    const w = track(wire());
    await grantThenGoOffline(w);
    vi.setSystemTime(T0.getTime() + 72 * HOUR - MIN);
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
    expect(w.sessions.getCurrent()?.authority_valid_until_ms).toBe(T0.getTime() + 72 * HOUR);
    await signOut(w);
    vi.setSystemTime(T0.getTime() + 72 * HOUR);
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
  });

  it('a server grace of 0 disables offline admission', async () => {
    net.grace = 0;
    const w = track(wire());
    await grantThenGoOffline(w);
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
  });

  it('a clock set back more than 5 minutes is refused; within 5 minutes is not', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    vi.setSystemTime(T0.getTime() - 6 * MIN);
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(offlineAudits(w).at(-1)).toEqual([
      'operator.signin.offline_refused',
      { category: 'clock_suspect' },
    ]);
    vi.setSystemTime(T0.getTime() - 4 * MIN);
    expect(await signIn(w)).toMatchObject({ kind: 'signed_in' });
  });

  it('a tampered grant is refused', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    const blob = grantBlob(g.raw, USER_ID);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    setGrantBlob(g.raw, blob, USER_ID);
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(w.sessions.getCurrent()).toBeNull();
  });

  it('a grant of another pairing (scope mismatch) is refused', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    w.grants.setScope({ ...SCOPE, pairing_epoch: SCOPE.pairing_epoch + 1 });
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(offlineAudits(w).at(-1)).toEqual([
      'operator.signin.offline_refused',
      { category: 'scope_mismatch' },
    ]);
  });

  it('an unpaired terminal (no grant scope) admits nobody', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    w.grants.setScope(null);
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
  });

  it('a failed counter write admits nobody and spends nothing', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    failSeal = true;
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(w.sessions.getCurrent()).toBeNull();
    failSeal = false;
    expect(usesSpent()).toBe(0);
    expect(offlineAudits(w)).toEqual([
      ['operator.signin.offline_refused', { category: 'storage' }],
    ]);
  });

  it('a storage failure admits nobody', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    g.raw.run('DROP TABLE cashier_offline_grants');
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(w.sessions.getCurrent()).toBeNull();
  });

  it('a grant invalidated by a 403 is refused offline', async () => {
    const w = track(wire());
    await signIn(w);
    await signOut(w);
    net.answers.push(() => errorJson(403));
    expect(await signIn(w)).toEqual({ kind: 'refused', category: 'invalid_input' });
    net.online = false;
    expect(await signIn(w)).toEqual(REFUSED_OFFLINE);
    expect(offlineAudits(w).at(-1)).toEqual([
      'operator.signin.offline_refused',
      { category: 'grant_invalidated' },
    ]);
  });
});

describe('RT-308 — the sign-in guards still hold offline', () => {
  const UNRESOLVED = {
    kind: 'refused',
    refusal: { kind: 'refused', category: 'terminal_has_unresolved_payment' },
  } as const;

  it('a re-pair or revocation while the admission call was in flight admits nobody, spends nothing', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    net.onSend = () => {
      pairingEpoch = 'epoch-2';
    };
    expect(await signIn(w)).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(w.sessions.getCurrent()).toBeNull();
    expect(usesSpent()).toBe(0);
  });

  it('the RT-444 guard before the network call refuses without spending a use', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    guard = { check: () => UNRESOLVED, admit: () => UNRESOLVED };
    expect(await signIn(w)).toEqual(UNRESOLVED.refusal);
    expect(usesSpent()).toBe(0);
  });

  it('the RT-444 re-check right before create() still refuses; the spent use stays spent', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    guard = { check: () => ({ kind: 'admitted' }), admit: () => UNRESOLVED };
    expect(await signIn(w)).toEqual(UNRESOLVED.refusal);
    expect(w.sessions.getCurrent()).toBeNull();
    expect(w.creates).toEqual(['online']);
    expect(usesSpent()).toBe(1);
  });
});

describe('RT-308 — Backend-Core is never bypassed', () => {
  it.each([
    ['403', () => errorJson(403), { kind: 'refused', category: 'invalid_input' }],
    ['device 401', () => errorJson(401), { kind: 'refused', category: 'invalid_input' }],
    ['429', () => errorJson(429), { kind: 'refused', category: 'rate_limited' }],
    ['400', () => errorJson(400), { kind: 'refused', category: 'invalid_input' }],
    ['409', () => errorJson(409), { kind: 'refused', category: 'invalid_input' }],
    ['active_elsewhere', () => json(200, { kind: 'active_elsewhere' }), undefined],
  ])('an answer (%s) never falls back to the grant', async (_l, answer, expected) => {
    const w = track(wire());
    await signIn(w);
    await signOut(w);
    net.answers.push(answer);
    const res = (await signIn(w)) as { kind: string };
    if (expected === undefined) expect(res.kind).toBe('takeover_required');
    else expect(res).toEqual(expected);
    expect(w.sessions.getCurrent()).toBeNull();
    expect(w.creates).toEqual(['online']);
    expect(offlineAudits(w)).toEqual([]);
  });

  it('managers and admins get no offline session start, grant or not', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    const manager = {
      kind: 'manager_admin',
      identifier: 'mgr@example.test',
      password: 'pw',
    };
    // Clerk unreachable.
    expect(await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, manager)).toEqual(REFUSED_OFFLINE);
    // Clerk reachable, Backend-Core not.
    managerClerk.result = {
      kind: 'ok',
      jwt: 'jwt-SECRET',
      operator_id: CLERK_ID,
      display_name: 'Mgr',
      role: 'manager',
    };
    expect(await w.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, manager)).toEqual(REFUSED_OFFLINE);
    expect(w.sessions.getCurrent()).toBeNull();
    expect(usesSpent()).toBe(0);
  });
});

describe('RT-308 — the offline roster (D11)', () => {
  function seedOther(w: Wired, offline_grace_seconds: number): void {
    w.grants.seam.onCashierAdmitted({
      user_id: OTHER_USER_ID,
      operator_id: OTHER_CLERK_ID,
      admission_id: '0192f6a0-aaaa-7bbb-8ccc-000000000002',
      display_name: 'Other',
      offline_grace_seconds,
      server_time: '2026-10-26T08:00:00.000Z',
      received_at: new Date().toISOString(),
      pairing_generation: w.grants.seam.pairingGeneration?.(),
      invalidation_seq: w.grants.seam.invalidationSeq?.(),
    });
  }

  it('online: the device-authenticated roster, source online', async () => {
    const w = track(wire());
    expect(await roster(w)).toMatchObject({ kind: 'roster', source: 'online' });
  });

  it('offline: only cashiers with a currently valid grant on this terminal, source offline', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    seedOther(w, 60); // a grant valid for one minute only
    expect(await roster(w)).toEqual({
      kind: 'roster',
      source: 'offline',
      cashiers: expect.arrayContaining([
        { id: CLERK_ID, display_name: 'Mona', role: 'cashier' },
        { id: OTHER_CLERK_ID, display_name: 'Other', role: 'cashier' },
      ]) as unknown,
    });
    vi.setSystemTime(T0.getTime() + 2 * MIN);
    expect(await roster(w)).toEqual({
      kind: 'roster',
      source: 'offline',
      cashiers: [{ id: CLERK_ID, display_name: 'Mona', role: 'cashier' }],
    });
  });

  it('offline with no valid grant on this terminal: no_connection', async () => {
    const w = track(wire());
    net.online = false;
    expect(await roster(w)).toEqual(REFUSED_OFFLINE);
    await signIn(w); // a refused first login changes nothing
    expect(await roster(w)).toEqual(REFUSED_OFFLINE);
  });

  it('an exhausted grant drops off the offline roster', async () => {
    await grantThenGoOffline(track(wire()));
    for (let i = 0; i < OFFLINE_GRANT_MAX_USES; i += 1) await signIn(track(wire()));
    expect(await roster(track(wire()))).toEqual(REFUSED_OFFLINE);
  }, 60_000);
});

describe('RT-308 — a running offline session past its grant (D6)', () => {
  it('is bounded on both clocks from the moment of admission', async () => {
    const w = track(wire());
    await grantThenGoOffline(w);
    vi.setSystemTime(T0.getTime() + 23 * HOUR);
    mono = 5_000;
    await signIn(w);
    const s = w.sessions.getCurrent();
    if (s === null) throw new Error('no session');
    const at = (wall: number, m: number): boolean =>
      offlineAuthorityExpired(s, { wall_ms: wall, mono_ms: m });
    expect(at(T0.getTime() + 23 * HOUR, 5_000)).toBe(false);
    // An hour later on either clock: expired (the wall clock set back cannot extend it).
    expect(at(T0.getTime() + 24 * HOUR, 5_000)).toBe(true);
    expect(at(T0.getTime(), 5_000 + HOUR)).toBe(true);
  });
});
