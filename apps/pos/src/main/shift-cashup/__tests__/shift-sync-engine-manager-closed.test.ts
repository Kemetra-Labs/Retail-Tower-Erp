/**
 * RT-1442 — the shift sync engine on a shift a manager closed on the server
 * (RT-742 "Late facts"), over the real repository on the full migration stack
 * (0063 included, sql.js).
 *
 * Backend-Core answers 409 `shift_force_closed` to a `closeShift` or an
 * `openShift` re-delivery, and 409 `shift_closed` to a NEW movement. The POS
 * treats it as final for that shift:
 *   • the answered fact is dead-lettered `shift_force_closed` and the shift gets
 *     one `shift_manager_closures` row; no retry, no backoff;
 *   • the shift's other facts are never sent again, but stay in the outbox
 *     (nothing is deleted), and do not block the terminal;
 *   • the terminal's latest shift reads as closed by a manager, no shift is
 *     open, and a new shift can be opened and synced;
 *   • any other refusal keeps its old handling (a dead letter that blocks).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createShiftCashupRepo, type ShiftCashupRepo } from '../shift-cashup-repo.js';
import { createShiftCashupStatusReader } from '../shift-cashup-status.js';
import type { ShiftSyncClient, ShiftSyncResult } from '../shift-sync-client.js';
import { createShiftSyncEngine, type ShiftSyncEngine } from '../shift-sync-engine.js';
import type { ShiftFactKind } from '../shift-wire.js';
import {
  CLOSE,
  NOW,
  OPEN,
  OTHER_TERMINAL,
  PAY_IN,
  S1,
  S2,
  SCOPE,
  recordWholeShift,
  stateRows,
} from './__helpers__/shift-sync-fixture.js';

const OK: ShiftSyncResult = { kind: 'ok' };
const FORCE_CLOSED: ShiftSyncResult = { kind: 'rejected', reason: 'shift_force_closed' };
const CLOSED: ShiftSyncResult = { kind: 'rejected', reason: 'shift_closed' };

type Answers = Partial<Record<ShiftFactKind, ShiftSyncResult>>;

/** A client answering by fact kind (default `ok`), recording what it was asked to send. */
function scriptedClient(answers: Answers): ShiftSyncClient & { sent: string[] } {
  const sent: string[] = [];
  const answer = (kind: ShiftFactKind) => (input: { fact: { shiftId: string } }) => {
    sent.push(`${kind}:${input.fact.shiftId}`);
    return Promise.resolve(answers[kind] ?? OK);
  };
  return {
    sent,
    openShift: answer('open'),
    recordCashMovement: answer('movement'),
    closeShift: answer('close'),
  };
}

let db: SqlJsDatabase;
let repo: ShiftCashupRepo;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  repo = createShiftCashupRepo(handleFor(db));
});

afterEach(() => {
  db.close();
});

function engineWith(
  client: ShiftSyncClient,
  extra: {
    onManagerClosed?: (info: { seq: number; factKind: ShiftFactKind }) => void;
    terminalId?: string;
  } = {},
): ShiftSyncEngine {
  return createShiftSyncEngine({
    client,
    repo,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => extra.terminalId ?? SCOPE.terminalId,
    now: () => NOW,
    ...(extra.onManagerClosed === undefined ? {} : { onManagerClosed: extra.onManagerClosed }),
  });
}

async function tick(engine: ShiftSyncEngine) {
  const admission = engine.runTickOnce();
  if (admission.kind !== 'started') throw new Error('tick was not admitted');
  return admission.completed;
}

const statuses = (): unknown[] => stateRows(db).map((r) => r['sync_status']);
const closures = (): unknown[][] =>
  db.exec('SELECT shift_id, source_fact_kind FROM shift_manager_closures')[0]?.values ?? [];

function readStatus() {
  return createShiftCashupStatusReader(handleFor(db)).read({ scope: SCOPE, now: NOW });
}

describe('409 shift_force_closed on the close', () => {
  it('is final: dead-lettered once, the shift is marked, nothing is retried', async () => {
    recordWholeShift({ repo });
    const onManagerClosed = vi.fn();
    const client = scriptedClient({ close: FORCE_CLOSED });
    const engine = engineWith(client, { onManagerClosed });

    const first = await tick(engine);
    expect(first).toEqual({ sent: 3, stop: { kind: 'idle' } });
    expect(client.sent).toEqual([`open:${S1}`, `movement:${S1}`, `close:${S1}`]);
    expect(statuses()).toEqual(['synced', 'synced', 'dead_letter']);
    expect(stateRows(db)[2]).toMatchObject({
      dead_letter_reason: 'shift_force_closed',
      attempt_count: 1,
      last_error_category: null,
    });
    expect(closures()).toEqual([[S1, 'close']]);
    expect(onManagerClosed).toHaveBeenCalledExactlyOnceWith({ seq: 3, factKind: 'close' });

    await expect(tick(engine)).resolves.toEqual({ sent: 0, stop: { kind: 'idle' } });
    expect(client.sent).toHaveLength(3);
  });

  it('keeps the cashier’s own close row and lets the till open a new shift', async () => {
    recordWholeShift({ repo });
    await tick(engineWith(scriptedClient({ close: FORCE_CLOSED })));

    expect(readStatus()).toMatchObject({ openShift: null, managerClosed: true });
    expect(db.exec('SELECT shift_id FROM shift_cashup_closes')[0]?.values).toEqual([[S1]]);

    repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, shiftId: S2 }, now: NOW });
    expect(readStatus()).toMatchObject({ openShift: { shiftId: S2 }, managerClosed: false });
  });
});

describe('409 shift_force_closed on an open re-delivery', () => {
  it('stops the shift’s facts without dropping any, and unblocks the next shift', async () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    repo.recordMovement({
      scope: SCOPE,
      fact: PAY_IN,
      now: NOW,
    });
    const answers: Answers = { open: FORCE_CLOSED };
    const client = scriptedClient(answers);
    const engine = engineWith(client);

    await expect(tick(engine)).resolves.toEqual({ sent: 1, stop: { kind: 'idle' } });
    expect(client.sent).toEqual([`open:${S1}`]);
    // The movement is neither sent nor deleted; only the answered row is settled.
    expect(statuses()).toEqual(['dead_letter', 'pending']);
    expect(closures()).toEqual([[S1, 'open']]);
    expect(readStatus()).toMatchObject({
      openShift: null,
      managerClosed: true,
      queue: { pending: 0, waiting: 0, blocked: 0, envelopePending: 0 },
    });
    expect(db.exec('SELECT COUNT(*) FROM shift_cashup_movements')[0]?.values).toEqual([[1]]);

    // A new shift opens (the server accepts it), its facts go out, the closed shift's
    // movement never does.
    answers.open = OK;
    repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, shiftId: S2 }, now: NOW });
    await expect(tick(engine)).resolves.toEqual({ sent: 1, stop: { kind: 'idle' } });
    expect(client.sent).toEqual([`open:${S1}`, `open:${S2}`]);
    expect(statuses()).toEqual(['dead_letter', 'pending', 'synced']);
    expect(readStatus().managerClosed).toBe(false);
  });
});

describe('409 shift_closed on a new movement', () => {
  it('is final for the shift when the movement is refused', async () => {
    recordWholeShift({ repo });
    const client = scriptedClient({ movement: CLOSED });
    const engine = engineWith(client);

    await expect(tick(engine)).resolves.toEqual({ sent: 2, stop: { kind: 'idle' } });
    // open synced, the movement answered, the close (behind it) never sent.
    expect(client.sent).toEqual([`open:${S1}`, `movement:${S1}`]);
    expect(statuses()).toEqual(['synced', 'dead_letter', 'pending']);
    expect(stateRows(db)[1]).toMatchObject({ dead_letter_reason: 'shift_force_closed' });
    expect(closures()).toEqual([[S1, 'movement']]);
    expect(readStatus()).toMatchObject({ openShift: null, managerClosed: true });
  });
});

describe('what stays as it was', () => {
  it.each(['open', 'close'] as const)(
    'a %s answered 409 shift_closed is still a dead letter that blocks the terminal',
    async (kind) => {
      recordWholeShift({ repo });
      const engine = engineWith(scriptedClient({ [kind]: CLOSED }));
      const report = await tick(engine);
      expect(report.stop).toMatchObject({ kind: 'blocked', reason: 'shift_closed' });
      expect(closures()).toEqual([]);
      expect(readStatus().managerClosed).toBe(false);
    },
  );

  it('another terminal’s facts are not affected by this terminal’s closure', async () => {
    recordWholeShift({ repo });
    repo.recordOpen({ scope: OTHER_TERMINAL, fact: { ...OPEN, shiftId: S2 }, now: NOW });
    repo.recordMovement({
      scope: OTHER_TERMINAL,
      fact: { ...PAY_IN, shiftId: S2, movementId: '0192f5a2-3b4c-7d8e-9f01-0000000000a2' },
      now: NOW,
    });
    repo.recordClose({ scope: OTHER_TERMINAL, fact: { ...CLOSE, shiftId: S2 }, now: NOW });
    await tick(engineWith(scriptedClient({ close: FORCE_CLOSED })));
    const other = createShiftCashupStatusReader(handleFor(db)).read({
      scope: OTHER_TERMINAL,
      now: NOW,
    });
    expect(other.managerClosed).toBe(false);
    expect(other.queue.pending).toBe(3);
  });

  it('a throwing hook does not stop the closure', async () => {
    recordWholeShift({ repo });
    const onManagerClosed = vi.fn(() => {
      throw new Error('sink down');
    });
    await expect(
      tick(engineWith(scriptedClient({ close: FORCE_CLOSED }), { onManagerClosed })),
    ).resolves.toEqual({ sent: 3, stop: { kind: 'idle' } });
    expect(closures()).toEqual([[S1, 'close']]);
  });
});

describe('recordManagerClosure', () => {
  it('writes nothing when the answered row is not pending', () => {
    recordWholeShift({ repo });
    repo.markSynced({ seq: 1, now: NOW });
    expect(repo.recordManagerClosure({ seq: 1, now: NOW, shiftId: S1, factKind: 'open' })).toBe(
      false,
    );
    expect(closures()).toEqual([]);
    expect(repo.latestShiftManagerClosed(SCOPE)).toBe(false);
  });

  it('records the closure once and settles only a pending answered row', () => {
    recordWholeShift({ repo });
    const input = { seq: 1, now: NOW, shiftId: S1, factKind: 'open' as const };
    expect(repo.recordManagerClosure(input)).toBe(true);
    expect(statuses()).toEqual(['dead_letter', 'pending', 'pending']);
    // A second answer for the same row changes nothing (it is no longer pending).
    expect(repo.recordManagerClosure(input)).toBe(false);
    expect(closures()).toEqual([[S1, 'open']]);
    expect(repo.latestShiftManagerClosed(SCOPE)).toBe(true);
    expect(repo.latestShiftManagerClosed(OTHER_TERMINAL)).toBe(false);
  });
});
