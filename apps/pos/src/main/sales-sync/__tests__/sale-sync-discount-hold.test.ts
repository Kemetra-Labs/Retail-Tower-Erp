/**
 * RT-856 (RT-699 I3, doc 28 §6 DEP-1 guard) — a discounted sale is HELD from
 * sync until the capture path can send it (RT-858 / I4).
 *
 * The capability switch `discountCaptureSupported` defaults to off. While it is
 * off, the drain skips every sale whose `lines_json` carries a line `discount`:
 * no POST, no state row, no attempt count, never dead-lettered. The sale stays
 * pending, so turning the switch on drains it with no requeue step. The sync
 * status names the hold (`discount_capture_unavailable`) and counts it. An
 * undiscounted sale is sent exactly as before, in the same tick.
 *
 * RT-858 turns the switch on: the held sale drains once, with its discount.
 * A discount with no recorded approver role cannot be sent (`sales.yaml`
 * requires `approverRole`), so that sale alone stays held, under the same
 * reason, in the drain and in both status reads.
 *
 * RT-906: such a line is sendable once `sale_discount_role_resolutions` holds a
 * role for its placeholder (migration 0058). The frozen role always wins; the
 * resolution counts only when none is frozen. The drain predicate, its SQL twin
 * and the payload builder agree on every shape.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import { createSaleSyncStatusReader } from '../sale-sync-status-reader.js';
import {
  SALE_DISCOUNT_CAPTURE_SUPPORTED,
  isSaleHeldFromSync,
  saleHasLineDiscount,
} from '../discount-hold.js';
import { readResolvedRoles } from '../discount-role-resolutions.js';
import { buildCapturePayload, DiscountNotSendableError } from '../capture-payload.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };

const DISCOUNTED_LINES = JSON.stringify([
  {
    line_id: 'l-1',
    item_ref: 'p-1',
    display_name: 'Panadol',
    quantity: 2,
    unit_price_minor: 4500,
    line_subtotal_minor: 9000,
    note: null,
    discount: {
      kind: 'percent',
      value: 10,
      amount_minor: 900,
      placeholder_id: 'dp-1',
      reason_code: 'promotion',
      authority_source: 'cashier_approval',
      approver_role: 'manager',
      approver_operator_id: 'mgr-1',
    },
  },
]);

/** The same sale frozen with no `approver_role` (a PIN record with no role yet, RT-861). */
const ROLELESS_LINES = DISCOUNTED_LINES.replace('"approver_role":"manager",', '');

function harness(over: Partial<SaleSyncEngineDeps> = {}, discountedLines = DISCOUNTED_LINES) {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient([
    { kind: 'ok', saleRef: null },
    { kind: 'ok', saleRef: null },
  ]);
  const deadLetters: string[] = [];
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    getOperatorToken: () => 'tok-1',
    now: () => '2026-10-24T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    onDeadLetter: (saleId) => deadLetters.push(saleId),
    ...over,
  };
  seedSale(db, { sale_id: 'sale-disc', subtotal_minor: 8100, lines_json: discountedLines });
  seedOutbox(db, { sale_id: 'sale-disc', enqueued_at: '2026-10-24T10:00:00.000Z' });
  seedSale(db, { sale_id: 'sale-plain' });
  seedOutbox(db, { sale_id: 'sale-plain', enqueued_at: '2026-10-24T10:01:00.000Z' });
  return { db, deps, stateRepo, client, deadLetters };
}

/** The `sales:syncStatus` snapshot for SCOPE, in the given capture mode. */
function statusOf(
  stateRepo: ReturnType<typeof createSaleSyncStateRepo>,
  discountCaptureSupported?: boolean,
) {
  return createSaleSyncStatusReader({
    stateRepo,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    pausedReason: () => null,
    ...(discountCaptureSupported === undefined ? {} : { discountCaptureSupported }),
  })();
}

async function tick(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

function postedIds(client: ReturnType<typeof createFakeSaleSyncClient>): string[] {
  return client.calls.map((call) => call.externalId);
}

describe('RT-856 — the capability switch', () => {
  it('is on since RT-858', () => {
    expect(SALE_DISCOUNT_CAPTURE_SUPPORTED).toBe(true);
  });

  it('a sale is discounted when any line carries a discount', () => {
    expect(saleHasLineDiscount({ lines_json: DISCOUNTED_LINES })).toBe(true);
    expect(saleHasLineDiscount({ lines_json: '[{"line_id":"l-1"}]' })).toBe(false);
    expect(saleHasLineDiscount({ lines_json: '[{"line_id":"l-1","discount":null}]' })).toBe(false);
    expect(saleHasLineDiscount({ lines_json: '[]' })).toBe(false);
    // An unreadable snapshot is held, never sent as a guess.
    expect(saleHasLineDiscount({ lines_json: 'not json' })).toBe(true);
  });
});

describe('RT-856 — switch off (default): the discounted sale is held', () => {
  it('is never sent, never touched, never dead-lettered; the undiscounted sale syncs', async () => {
    const h = harness({ discountCaptureSupported: false });
    await tick(h.deps);
    await tick({ ...h.deps, now: () => '2027-01-01T00:00:00.000Z' });
    expect(h.client.calls).toHaveLength(1);
    expect(postedIds(h.client)[0]).not.toContain('sale-disc');
    expect(nn(h.stateRepo.read('sale-plain')).sync_status).toBe('synced');
    // Untouched: no state row (so no attempt count), still eligible, still pending.
    expect(h.stateRepo.read('sale-disc')).toBeNull();
    expect(h.stateRepo.eligible(SCOPE, '2027-01-01T00:00:00.000Z').map((r) => r.sale_id)).toEqual([
      'sale-disc',
    ]);
    expect(h.stateRepo.readSyncStatus(SCOPE)).toMatchObject({ pending: 1, deadLetter: 0 });
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('a held sale does not keep the drain paused', async () => {
    const h = harness();
    const engine = createSaleSyncEngine(h.deps);
    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;
    await expect(engine.pausedReason()).resolves.toBeNull();
    h.db.close();
  });

  it('the status names the hold and counts it; pending still includes it', async () => {
    const h = harness();
    await tick(h.deps);
    const status = await statusOf(h.stateRepo);
    expect(status.pending).toBe(1);
    expect(status.held).toEqual({ reason: 'discount_capture_unavailable', count: 1 });
    h.db.close();
  });
});

describe('RT-856 — switch on (RT-858): the same stored sale drains with no requeue', () => {
  it('sends the held sale on the next tick', async () => {
    const h = harness();
    await tick(h.deps);
    await tick({ ...h.deps, discountCaptureSupported: true });
    expect(h.client.calls).toHaveLength(2);
    expect(nn(h.stateRepo.read('sale-disc')).sync_status).toBe('synced');
    h.db.close();
  });

  it('RT-858: sends it exactly once, at its net, with the discount and attribution', async () => {
    const h = harness();
    const on = { ...h.deps, discountCaptureSupported: SALE_DISCOUNT_CAPTURE_SUPPORTED };
    await tick(h.deps);
    await tick(on);
    await tick({ ...on, now: () => '2027-01-01T00:00:00.000Z' });
    const sent = h.client.calls.filter((call) => call.externalId === 'pos-pulse:handoff-sale-disc');
    expect(sent).toHaveLength(1);
    expect(nn(sent[0]).totalMinor).toBe(8100);
    expect(nn(sent[0]).lines).toEqual([
      expect.objectContaining({
        unitPriceMinor: 4500,
        lineAmountMinor: 8100,
        discount: {
          kind: 'percent',
          value: 10,
          amountMinor: 900,
          reasonCode: 'promotion',
          authoritySource: 'cashier_approval',
          approverRole: 'manager',
        },
      }),
    ]);
    expect(h.stateRepo.eligible(SCOPE, '2027-01-01T00:00:00.000Z')).toEqual([]);
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('RT-858: a transient answer re-sends the same body under the same key (replay-safe)', async () => {
    const h = harness();
    const client = createFakeSaleSyncClient([{ kind: 'transient' }, { kind: 'ok', saleRef: null }]);
    const deps = { ...h.deps, client, discountCaptureSupported: true };
    await tick(deps);
    await tick({ ...deps, now: () => '2027-01-01T00:00:00.000Z' });
    const sent = client.calls.filter((call) => call.externalId === 'pos-pulse:handoff-sale-disc');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(nn(h.stateRepo.read('sale-disc')).sync_status).toBe('synced');
    h.db.close();
  });

  it('the status reports no hold', async () => {
    const h = harness();
    const status = await statusOf(h.stateRepo, true);
    expect(status.held).toBeNull();
    h.db.close();
  });
});

describe('RT-858 — switch on: a discount with no recorded approver role stays held', () => {
  it('is never sent or dead-lettered; the other sales drain', async () => {
    const h = harness({ discountCaptureSupported: true }, ROLELESS_LINES);
    await tick(h.deps);
    await tick({ ...h.deps, now: () => '2027-01-01T00:00:00.000Z' });
    expect(postedIds(h.client)).toEqual(['pos-pulse:handoff-sale-plain']);
    expect(h.stateRepo.read('sale-disc')).toBeNull();
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('the status names and counts it, as the drain holds it', async () => {
    const h = harness({}, ROLELESS_LINES);
    const status = await statusOf(h.stateRepo, true);
    expect(status.held).toEqual({ reason: 'discount_capture_unavailable', count: 1 });
    h.db.close();
  });

  it('the drain predicate and the SQL count agree, line shape by line shape', () => {
    const shapes: Record<string, string> = {
      sendable: DISCOUNTED_LINES,
      roleless: ROLELESS_LINES,
      unknownRole: DISCOUNTED_LINES.replace('"manager"', '"cashier"'),
      scalarDiscount: '[{"line_id":"l-1","discount":7}]',
      nullDiscount: '[{"line_id":"l-1","discount":null}]',
      plain: '[{"line_id":"l-1"}]',
      scalarLines: '["corrupt", 7, null]',
      unreadable: 'not json',
      notAList: '{"line_id":"l-1"}',
    };
    const db = freshSalesSyncDb();
    const stateRepo = createSaleSyncStateRepo(handleFor(db));
    for (const [id, lines_json] of Object.entries(shapes)) {
      seedSale(db, { sale_id: id, lines_json });
      seedOutbox(db, { sale_id: id });
    }
    const held = Object.entries(shapes).filter(([, lines_json]) =>
      isSaleHeldFromSync({ lines_json }, true),
    );
    expect(held.map(([id]) => id)).toEqual([
      'roleless',
      'unknownRole',
      'scalarDiscount',
      'unreadable',
      'notAList',
    ]);
    expect(stateRepo.countDiscountHeld(SCOPE, true)).toBe(held.length);
    const heldOff = Object.values(shapes).filter((lines_json) =>
      isSaleHeldFromSync({ lines_json }, false),
    );
    expect(stateRepo.countDiscountHeld(SCOPE)).toBe(heldOff.length);
    db.close();
  });
});

describe('RT-906 — the resolved role: predicate, SQL and payload agree', () => {
  const APPROVAL = '0190f5a2-3b4c-7d8e-9f01-000000000001';
  const NULL_ROLE = DISCOUNTED_LINES.replace('"approver_role":"manager"', '"approver_role":null');
  const SECOND_LINE = JSON.stringify([
    ...(JSON.parse(ROLELESS_LINES) as unknown[]),
    {
      ...(JSON.parse(ROLELESS_LINES) as Record<string, Record<string, unknown>>[])[0],
      line_id: 'l-2',
      discount: {
        ...(JSON.parse(ROLELESS_LINES) as Record<string, Record<string, unknown>>[])[0]?.[
          'discount'
        ],
        placeholder_id: 'dp-2',
      },
    },
  ]);
  /** Each shape, and the placeholders resolved for it (role `admin`). */
  const shapes: Record<string, [string, string[]]> = {
    resolved: [ROLELESS_LINES, ['dp-1']],
    otherPlaceholder: [ROLELESS_LINES, ['dp-9']],
    neither: [ROLELESS_LINES, []],
    frozenWins: [DISCOUNTED_LINES, ['dp-1']],
    nullRoleResolved: [NULL_ROLE, ['dp-1']],
    unknownRoleResolved: [DISCOUNTED_LINES.replace('"manager"', '"cashier"'), ['dp-1']],
    numericPlaceholder: [
      ROLELESS_LINES.replace('"placeholder_id":"dp-1"', '"placeholder_id":5'),
      ['5'],
    ],
    oneOfTwoResolved: [SECOND_LINE, ['dp-1']],
    bothResolved: [SECOND_LINE, ['dp-1', 'dp-2']],
    unreadableResolved: ['not json', ['dp-1']],
    plain: ['[{"line_id":"l-1"}]', ['dp-1']],
  };

  function seeded() {
    const db = freshSalesSyncDb();
    const handle = handleFor(db);
    for (const [id, [lines_json, placeholders]] of Object.entries(shapes)) {
      seedSale(db, { sale_id: id, subtotal_minor: 8100, lines_json });
      seedOutbox(db, { sale_id: id });
      for (const placeholder of placeholders) {
        db.run(
          `INSERT INTO sale_discount_role_resolutions
             (sale_id, placeholder_id, approval_id, approver_role, source, resolved_at)
           VALUES (?, ?, ?, 'admin', 'pin_record_refresh', '2026-10-27T10:00:00.000Z')`,
          [id, placeholder, APPROVAL],
        );
      }
    }
    return { db, handle, stateRepo: createSaleSyncStateRepo(handle) };
  }

  it('the drain predicate and the SQL count agree, shape by shape', () => {
    const { db, handle, stateRepo } = seeded();
    const held = Object.entries(shapes)
      .filter(([id, [lines_json]]) =>
        isSaleHeldFromSync({ lines_json }, true, readResolvedRoles(handle, id)),
      )
      .map(([id]) => id);
    expect(held).toEqual([
      'otherPlaceholder',
      'neither',
      'nullRoleResolved',
      'unknownRoleResolved',
      'numericPlaceholder',
      'oneOfTwoResolved',
      'unreadableResolved',
    ]);
    expect(stateRepo.countDiscountHeld(SCOPE, true)).toBe(held.length);
    // With capture off, a resolution releases nothing.
    expect(stateRepo.countDiscountHeld(SCOPE)).toBe(
      Object.values(shapes).filter(([lines_json]) => isSaleHeldFromSync({ lines_json }, false))
        .length,
    );
    db.close();
  });

  it('the payload takes the frozen role first, the resolved one only when none is frozen', () => {
    const { db, handle } = seeded();
    const sale = (id: string) => nn(bindSalesRepository(handle).readById(id));
    const roleOf = (id: string, resolved = readResolvedRoles(handle, id)) =>
      buildCapturePayload(sale(id), { resolvedRoles: resolved }).lines.map(
        (line) => line.discount?.approverRole,
      );
    expect(roleOf('resolved')).toEqual(['admin']);
    expect(roleOf('frozenWins')).toEqual(['manager']);
    expect(roleOf('bothResolved')).toEqual(['admin', 'admin']);
    // No resolution passed: only the frozen role counts, so a role-less line cannot be built.
    expect(() => buildCapturePayload(sale('resolved'))).toThrow(DiscountNotSendableError);
    expect(() => roleOf('otherPlaceholder')).toThrow(DiscountNotSendableError);
    db.close();
  });
});

describe('RT-856 — countDiscountHeld', () => {
  it('counts only the current terminal’s unsent discounted sales', () => {
    const h = harness();
    seedSale(h.db, {
      sale_id: 'sale-other',
      terminal_id: 'term-old',
      lines_json: DISCOUNTED_LINES,
    });
    seedOutbox(h.db, { sale_id: 'sale-other', terminal_id: 'term-old' });
    seedSale(h.db, { sale_id: 'sale-done', lines_json: DISCOUNTED_LINES });
    seedOutbox(h.db, { sale_id: 'sale-done' });
    h.stateRepo.markSynced({ saleId: 'sale-done', ...SCOPE, now: '2026-10-24T10:00:00.000Z' });
    expect(h.stateRepo.countDiscountHeld(SCOPE)).toBe(1);
    expect(h.stateRepo.countDiscountHeld({ ...SCOPE, terminalId: null })).toBe(0);
    h.db.close();
  });

  it('a scalar line element is not a discount and never breaks the count', () => {
    const h = harness();
    seedSale(h.db, { sale_id: 'sale-scalar', lines_json: '["corrupt", 7, null]' });
    seedOutbox(h.db, { sale_id: 'sale-scalar' });
    expect(h.stateRepo.countDiscountHeld(SCOPE)).toBe(1);
    expect(saleHasLineDiscount({ lines_json: '["corrupt", 7, null]' })).toBe(false);
    h.db.close();
  });

  it('no discounted sale → no hold in the status', async () => {
    const db = freshSalesSyncDb();
    const stateRepo = createSaleSyncStateRepo(handleFor(db));
    seedSale(db, { sale_id: 'sale-plain' });
    seedOutbox(db, { sale_id: 'sale-plain' });
    const status = await statusOf(stateRepo);
    expect(status.held).toBeNull();
    db.close();
  });
});
