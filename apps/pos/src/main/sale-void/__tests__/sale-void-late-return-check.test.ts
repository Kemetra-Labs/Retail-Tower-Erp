/**
 * RT-1553 — `saleVoid.lookup` runs the returns domain's late-commit check of the sale (best effort)
 * before it answers whether the sale can be voided:
 *   • the check runs with the found sale's id, after the access gate, before the view is built, so a
 *     late commit it raises shows as `has_return` in the same answer;
 *   • the gate runs again after the await (a lock meanwhile refuses);
 *   • no check runs for a sale that is not found or not this operator's;
 *   • without the hook the lookup is unchanged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { composeSaleVoid, type ComposedSaleVoid } from '../compose-sale-void.js';

const TERMINAL = 'term-1';
const T0 = '2026-06-07T10:30:00.000Z';
const TENDERS = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 1500 }]);
const SALE = 'sale-own';

const manager: OperatorSessionRecord = {
  id: 'sess-op-lead',
  operator_id: 'op-lead',
  display_name: 'Operator op-lead',
  role: 'manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  started_at: T0,
  backend_session_id: 'b-op-lead',
  last_activity_at: T0,
  lock_state: 'active',
  locked_at: null,
  manager_user_id: '0190f5a2-3b4c-7d8e-9f01-0000000000a1',
};

let raw: SqlJsDatabase;
let locked: boolean;
let checked: string[];
let onCheck: () => void;

beforeAll(async () => {
  await initGrantSql();
});

function compose(checkLateReturns?: (saleId: string) => Promise<void>): ComposedSaleVoid {
  return composeSaleVoid({
    db: handleFor(raw),
    http: {
      baseUrl: 'https://api.example.test',
      fetch: (() => undefined) as unknown as typeof fetch,
    },
    drawer: { kick: () => Promise.resolve({ ok: true }) },
    getOperatorEnvelope: () => 'envelope',
    getSession: () => manager,
    getTerminalId: () => TERMINAL,
    isSessionLocked: () => locked,
    isEnabled: () => true,
    approvals: { consume: () => undefined, evidence: () => undefined } as never,
    auditSink: { emit: () => undefined },
    accessAudit: { emitRaw: () => undefined },
    logger: { warn: () => undefined, error: () => undefined },
    now: () => T0,
    localDayOf: (iso) => iso.slice(0, 10),
    ...(checkLateReturns === undefined ? {} : { checkLateReturns }),
  });
}

const hook = (saleId: string): Promise<void> => {
  checked.push(saleId);
  onCheck();
  return Promise.resolve();
};

beforeEach(() => {
  raw = freshGrantDb();
  locked = false;
  checked = [];
  onCheck = () => undefined;
  seedSale(raw, {
    sale_id: SALE,
    selling_operator_id: 'op-cashier',
    finalized_at: T0,
    tender_lines_summary_json: TENDERS,
  });
});

afterEach(() => {
  raw.close();
});

describe('RT-1553 — the void lookup checks the sale for a late commit first', () => {
  it('runs the check with the sale id and answers with the sale', async () => {
    const domain = compose(hook);
    await expect(domain.service.lookup({ sale_number: `SN-${SALE}` })).resolves.toMatchObject({
      kind: 'sale',
      sale: { sale_id: SALE, ineligible: null },
    });
    expect(checked).toEqual([SALE]);
  });

  it('builds the view after the check, so a return it makes live shows as has_return', async () => {
    const domain = compose(hook);
    onCheck = () => {
      // What a raised late commit looks like to the void guard: a live return of the sale.
      raw.run(
        `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
           sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
           currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
         VALUES ('r1', 'tenant-1', 'branch-1', ?, ?, 'SN-1', ?, ?, 'op', 'sess', 'EGP',
           1500, '{}', 'pending', ?, ?)`,
        [
          TERMINAL,
          SALE,
          '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6',
          'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
          T0,
          T0,
        ],
      );
    };
    await expect(domain.service.lookup({ sale_number: `SN-${SALE}` })).resolves.toMatchObject({
      kind: 'sale',
      sale: { sale_id: SALE, ineligible: 'has_return' },
    });
  });

  it('re-runs the gate after the check: a lock meanwhile refuses', async () => {
    const domain = compose(hook);
    onCheck = () => {
      locked = true;
    };
    await expect(domain.service.lookup({ sale_number: `SN-${SALE}` })).resolves.toEqual({
      kind: 'refused',
      reason: 'session_locked',
    });
  });

  it('runs no check for a sale that is not found', async () => {
    const domain = compose(hook);
    await expect(domain.service.lookup({ sale_number: 'SN-nope' })).resolves.toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
    expect(checked).toEqual([]);
  });

  it('without the hook the lookup is unchanged', async () => {
    const domain = compose();
    await expect(domain.service.lookup({ sale_number: `SN-${SALE}` })).resolves.toMatchObject({
      kind: 'sale',
      sale: { sale_id: SALE },
    });
  });
});
