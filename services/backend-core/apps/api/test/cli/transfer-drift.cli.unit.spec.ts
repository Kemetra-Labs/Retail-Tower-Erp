/**
 * Jira RT-1517 — the legacy transfer drift report CLI (`runTransferDriftCli`), without a database. The query itself is
 * covered over real Postgres by `test/inventory/shipment-transfers/shipment-transfers.db.spec.ts`.
 */
import type { LegacyTransferDriftRow } from '../../src/inventory';
import { connectFromEnv } from '../../src/cli/transfer-drift';
import { EXIT, parseArgs, runTransferDriftCli, type DriftCliIo } from '../../src/cli/transfer-drift/cli';

const TENANT = '0198b000-0000-7000-8000-0000000000aa';
const STORE_X = '0198b000-0000-7000-8000-0000000000b1';
const STORE_Y = '0198b000-0000-7000-8000-0000000000b2';
const GROUP = '0198b000-0000-7000-8000-0000000000c1';
const ITEM = '0198b000-0000-7000-8000-0000000000d1';

const row = (over: Partial<LegacyTransferDriftRow>): LegacyTransferDriftRow => ({
  movementId: '0198b000-0000-7000-8000-0000000000e1',
  transferGroupId: GROUP,
  movementType: 'transfer_out',
  storeId: STORE_X,
  tenantProductRef: ITEM,
  quantity: '-4.0000',
  stockingUnit: 'each',
  occurredAt: '2026-11-01T09:00:00.000Z',
  ...over,
});

const ROWS = [
  row({}),
  row({ movementId: '0198b000-0000-7000-8000-0000000000e2', movementType: 'transfer_in', storeId: STORE_Y, quantity: '4.0000' }),
];

function io(rows: readonly LegacyTransferDriftRow[] = ROWS) {
  const lines: string[] = [];
  const calls: string[] = [];
  let closed = 0;
  const value: DriftCliIo = {
    out: (line) => lines.push(line),
    connect: async (tenantId) => {
      calls.push(tenantId);
      return {
        list: async () => rows,
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  return { value, lines, calls, closed: () => closed };
}

describe('parseArgs', () => {
  it('accepts report --tenant <uuid> with an optional --json', () => {
    expect(parseArgs(['report', '--tenant', TENANT])).toEqual({ tenantId: TENANT, json: false });
    expect(parseArgs(['report', '--tenant', TENANT, '--json'])).toEqual({ tenantId: TENANT, json: true });
    expect(parseArgs(['report', '--json', '--tenant', TENANT])).toEqual({ tenantId: TENANT, json: true });
  });

  it.each([
    [[]],
    [['report']],
    [['post', '--tenant', TENANT]],
    [['report', '--tenant']],
    [['report', '--tenant', 'not-a-uuid']],
    [['report', '--tenant', TENANT, '--tenant', TENANT]],
    [['report', '--tenant', TENANT, '--store', STORE_X]],
    [['report', '--tenant', TENANT, '--json', '--json']],
  ])('refuses %j', (argv) => {
    expect(parseArgs(argv)).toBeNull();
  });
});

describe('runTransferDriftCli', () => {
  it('prints usage and exits 2 on bad arguments, without connecting', async () => {
    const t = io();
    expect(await runTransferDriftCli(['report'], t.value)).toBe(EXIT.usage);
    expect(t.calls).toEqual([]);
    expect(t.lines.join('\n')).toContain('usage: transfer-drift report --tenant <uuid> [--json]');
  });

  it('lists the legs grouped by store, with item, quantity, unit and date, and a total', async () => {
    const t = io();
    expect(await runTransferDriftCli(['report', '--tenant', TENANT], t.value)).toBe(EXIT.ok);
    expect(t.calls).toEqual([TENANT]);
    const text = t.lines.join('\n');
    expect(text).toContain(`tenant ${TENANT}: 2 legacy transfer leg(s) not posted to ERPNext, in 2 store(s)`);
    expect(text).toContain(`store ${STORE_X}: 1 leg(s)`);
    expect(text).toContain(`store ${STORE_Y}: 1 leg(s)`);
    expect(text).toContain(`2026-11-01T09:00:00.000Z  transfer_out  ${ITEM}  -4.0000 each  group ${GROUP}`);
    expect(text).toContain('None of these legs is posted to ERPNext by this report');
    expect(t.lines.findIndex((l) => l.includes(STORE_X))).toBeLessThan(t.lines.findIndex((l) => l.includes(STORE_Y)));
    expect(t.closed()).toBe(1);
  });

  it('says so when there is no drift', async () => {
    const t = io([]);
    expect(await runTransferDriftCli(['report', '--tenant', TENANT], t.value)).toBe(EXIT.ok);
    expect(t.lines.join('\n')).toContain(`tenant ${TENANT}: 0 legacy transfer leg(s) not posted to ERPNext, in 0 store(s)`);
  });

  it('prints one JSON document with --json', async () => {
    const t = io();
    expect(await runTransferDriftCli(['report', '--tenant', TENANT, '--json'], t.value)).toBe(EXIT.ok);
    expect(t.lines).toHaveLength(1);
    expect(JSON.parse(t.lines[0]!)).toEqual({
      tenantId: TENANT,
      legCount: 2,
      stores: [
        { storeId: STORE_X, legs: [ROWS[0]] },
        { storeId: STORE_Y, legs: [ROWS[1]] },
      ],
    });
  });

  it('closes the connection even when the query fails, and lets the error through', async () => {
    let closed = 0;
    const failing: DriftCliIo = {
      out: () => undefined,
      connect: async () => ({
        list: async () => {
          throw new Error('boom');
        },
        close: async () => {
          closed += 1;
        },
      }),
    };
    await expect(runTransferDriftCli(['report', '--tenant', TENANT], failing)).rejects.toThrow('boom');
    expect(closed).toBe(1);
  });
});

describe('connectFromEnv', () => {
  it.each([[{}], [{ DATABASE_URL: '' }], [{ DATABASE_URL: '   ' }]])(
    'fails closed without a DATABASE_URL (%j), before opening any connection',
    async (env) => {
      await expect(connectFromEnv(env as NodeJS.ProcessEnv)(TENANT)).rejects.toThrow('DATABASE_URL is required');
    },
  );
});
