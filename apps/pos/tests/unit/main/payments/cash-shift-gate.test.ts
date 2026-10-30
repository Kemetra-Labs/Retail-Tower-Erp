/**
 * RT-998 — `bindCashShiftGate`: the main-side question "may cash be tendered on
 * this terminal now?". It reads the shift feature flag per call and, with the
 * flag on, the terminal's open shift (tenant, branch and terminal, never the
 * operator). With the flag off no shift can exist, so nothing is required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindCashShiftGate } from '../../../../src/main/payments/cash-shift-gate.js';
import {
  createShiftCashupRepo,
  type ShiftScope,
} from '../../../../src/main/shift-cashup/shift-cashup-repo.js';
import { bindRealPaymentsCore, freshMigratedDbPerTest } from './__fixtures__/real-payments-core.js';

const currentDb = freshMigratedDbPerTest();

const SCOPE: ShiftScope = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'terminal-1' };
const attemptScope = (overrides: Partial<Record<string, string>> = {}) => ({
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  ...overrides,
});

function openShift(core: ReturnType<typeof bindRealPaymentsCore>, scope: ShiftScope): void {
  createShiftCashupRepo(core.handle).recordOpen({
    scope,
    now: '2026-10-30T08:00:01.000Z',
    fact: {
      shiftId: '0192f5a2-3b4c-7d8e-9f01-000000000001',
      openedAt: '2026-10-30T08:00:00.000Z',
      openingUserId: '0190f5a2-3b4c-7d8e-9f01-23456789abcd',
      currencyCode: 'EGP',
      openingFloatMinor: 0,
    },
  });
}

describe('bindCashShiftGate', () => {
  it('flag on, no open shift: shift_required', () => {
    const core = bindRealPaymentsCore(currentDb());
    const gate = bindCashShiftGate(core.handle, () => true);
    expect(gate(attemptScope())).toBe('shift_required');
  });

  it('flag on, a shift open on the terminal: ok', () => {
    const core = bindRealPaymentsCore(currentDb());
    openShift(core, SCOPE);
    const gate = bindCashShiftGate(core.handle, () => true);
    expect(gate(attemptScope())).toBe('ok');
  });

  it.each([
    ['another terminal', { terminal_id: 'terminal-2' }],
    ['another branch', { branch_id: 'branch-2' }],
    ['another tenant', { tenant_id: 'tenant-2' }],
  ])('flag on, the open shift is on %s: shift_required', (_name, override) => {
    const core = bindRealPaymentsCore(currentDb());
    openShift(core, SCOPE);
    const gate = bindCashShiftGate(core.handle, () => true);
    expect(gate(attemptScope(override))).toBe('shift_required');
  });

  it('flag off: ok with no shift', () => {
    const core = bindRealPaymentsCore(currentDb());
    const gate = bindCashShiftGate(core.handle, () => false);
    expect(gate(attemptScope())).toBe('ok');
  });

  it('reads the flag on every call', () => {
    const core = bindRealPaymentsCore(currentDb());
    const flag = { on: false };
    const gate = bindCashShiftGate(core.handle, () => flag.on);
    expect(gate(attemptScope())).toBe('ok');
    flag.on = true;
    expect(gate(attemptScope())).toBe('shift_required');
  });

  it('reads the open shift on every call (an opened shift is seen at once)', () => {
    const core = bindRealPaymentsCore(currentDb());
    const gate = bindCashShiftGate(core.handle, () => true);
    expect(gate(attemptScope())).toBe('shift_required');
    openShift(core, SCOPE);
    expect(gate(attemptScope())).toBe('ok');
  });
});

describe('bindCashShiftGate — the default flag reader', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads POS_PULSE_FEATURE_SHIFT_CASHUP from the environment on every call', () => {
    const core = bindRealPaymentsCore(currentDb());
    const gate = bindCashShiftGate(core.handle);
    vi.stubEnv('POS_PULSE_FEATURE_SHIFT_CASHUP', '');
    expect(gate(attemptScope())).toBe('ok');
    vi.stubEnv('POS_PULSE_FEATURE_SHIFT_CASHUP', 'true');
    expect(gate(attemptScope())).toBe('shift_required');
  });
});
