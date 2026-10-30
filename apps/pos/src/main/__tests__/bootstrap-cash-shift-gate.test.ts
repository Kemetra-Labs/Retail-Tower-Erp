import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-998 — the composition root wires the cash shift gate into every
 * `tender.apply` and `payments.confirm` handler it builds, the cashier's and the
 * manager-recovery ones. Both handlers treat an absent gate as "no gate", so a
 * missing wire would silently let cash through; this guard keeps the refusal
 * reachable. (Importing `index.ts` needs the Electron globals, so this is a
 * source check, like `bootstrap-card-tender-flag.test.ts`.)
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');

describe('main/index.ts wires the cash shift gate (RT-998)', () => {
  const source = readFileSync(INDEX_PATH, 'utf-8');

  it('binds the gate to the open database in the shared write deps', () => {
    const block = /const paymentsWriteDeps = \{[^}]*\};/.exec(source)?.[0] ?? '';
    expect(block).toMatch(/\bcashShiftGate: bindCashShiftGate\(db\)/);
  });

  it.each(['createTenderApplyHandler', 'createPaymentsConfirmHandler'])(
    'every %s (cashier and manager recovery) spreads the write deps that carry the gate',
    (factory) => {
      const builds = source.match(new RegExp(`${factory}\\(\\{[^}]*\\}\\)`, 'g')) ?? [];
      expect(builds).toHaveLength(2);
      for (const build of builds) {
        expect(build).toMatch(/\.\.\.(paymentsWriteDeps|scoped)\b/);
      }
    },
  );

  it('the recovery-scoped deps are built from the write deps', () => {
    expect(source).toMatch(/const scoped = \{ \.\.\.paymentsWriteDeps, getCurrentSession \};/);
  });
});
