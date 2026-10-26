/**
 * RT-886 — the printer service: the live-session gate (any role), the choice,
 * the audit of each change and test page (AC1, AC5), and the test page's honest
 * outcome (accepted ≠ printed; a missing printer is never printed elsewhere).
 */
import { describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { InstalledPrinter, PrinterChoice } from '../../../shared/printer/types.js';
import type { PrintAdapterResult, RenderedReceipt } from '../../receipts/print-pipeline.js';
import { createPrinterService, type PrinterOperatorScope } from '../printer-service.js';
import type { PrinterSettingRepository } from '../printer-setting-repository.js';

const CASHIER: PrinterOperatorScope = {
  operator_id: 'user_cashier',
  operator_session_id: 'sess-1',
  tenant_id: 't-1',
  branch_id: 'b-1',
  terminal_id: 'term-1',
};

const PRINTERS: InstalledPrinter[] = [{ name: 'HP LaserJet' }, { name: 'BIXOLON SRP-330II' }];

function memoryRepo(initial: PrinterChoice | null = null): PrinterSettingRepository & {
  writes: { choice: PrinterChoice; operatorId: string }[];
} {
  let current = initial;
  const writes: { choice: PrinterChoice; operatorId: string }[] = [];
  return {
    writes,
    get: () => current,
    set: (choice, meta) => {
      current = choice;
      writes.push({ choice, operatorId: meta.operatorId });
    },
  };
}

function setup(
  over: {
    session?: PrinterOperatorScope | null;
    getSession?: () => PrinterOperatorScope | null;
    locked?: boolean;
    isLocked?: () => boolean;
    choice?: PrinterChoice | null;
    printers?: () => Promise<InstalledPrinter[]>;
    print?: (r: RenderedReceipt) => Promise<PrintAdapterResult>;
    emit?: (e: AuditEvent) => void;
  } = {},
) {
  const events: AuditEvent[] = [];
  const repo = memoryRepo(over.choice ?? null);
  const print = vi.fn(
    over.print ??
      ((): Promise<PrintAdapterResult> => Promise.resolve({ ok: true, render_path: 'os_print' })),
  );
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = createPrinterService({
    getSession: over.getSession ?? (() => (over.session === undefined ? CASHIER : over.session)),
    isSessionLocked: over.isLocked ?? (() => over.locked ?? false),
    repo,
    listPrinters: over.printers ?? (() => Promise.resolve(PRINTERS)),
    printer: { printRendered: print },
    audit: {
      emit:
        over.emit ??
        ((e) => {
          events.push(e);
        }),
    },
    transaction: (fn) => {
      fn();
    },
    now: () => '2026-10-26T10:00:00.000Z',
    newEventId: () => 'evt-1',
    logger,
  });
  return { service, repo, events, print, logger };
}

describe('printer service — session gate (any role)', () => {
  it('refuses every call without a session, before touching anything', async () => {
    const { service, print, repo, events } = setup({ session: null });
    expect(await service.list()).toEqual({ kind: 'refused', reason: 'not_signed_in' });
    expect(await service.get()).toEqual({ kind: 'refused', reason: 'not_signed_in' });
    expect(await service.set({ choice: { source: 'os_default' } })).toEqual({
      kind: 'refused',
      reason: 'not_signed_in',
    });
    expect(await service.testPrint()).toEqual({ kind: 'refused', reason: 'not_signed_in' });
    expect(print).not.toHaveBeenCalled();
    expect(repo.writes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses a locked session', async () => {
    const { service } = setup({ locked: true });
    expect(await service.get()).toEqual({ kind: 'refused', reason: 'session_locked' });
    expect(await service.testPrint()).toEqual({ kind: 'refused', reason: 'session_locked' });
  });

  it('serves a cashier (AC1: list, choose, test)', async () => {
    const { service } = setup();
    expect(await service.list()).toEqual({ kind: 'ok', printers: PRINTERS });
    expect(await service.get()).toEqual({ kind: 'ok', choice: null });
    const chosen = { source: 'chosen', printer_name: 'BIXOLON SRP-330II' } as const;
    expect(await service.set({ choice: chosen })).toEqual({ kind: 'ok', choice: chosen });
    expect(await service.testPrint()).toEqual({ kind: 'accepted', choice: chosen });
  });
});

describe('printer service — list', () => {
  it('drops empty and duplicate names, and answers [] when discovery fails', async () => {
    const dup = setup({
      printers: () => Promise.resolve([{ name: 'A' }, { name: '' }, { name: 'A' }, { name: 'B' }]),
    });
    expect(await dup.service.list()).toEqual({
      kind: 'ok',
      printers: [{ name: 'A' }, { name: 'B' }],
    });
    const broken = setup({ printers: () => Promise.reject(new Error('no window')) });
    expect(await broken.service.list()).toEqual({ kind: 'ok', printers: [] });
  });
});

describe('printer service — set (AC5: each change audited with the operator)', () => {
  it('saves and audits a change with the old and new printer', async () => {
    const { service, repo, events } = setup({ choice: { source: 'os_default' } });
    await service.set({ choice: { source: 'chosen', printer_name: 'BIXOLON SRP-330II' } });
    expect(repo.writes).toEqual([
      {
        choice: { source: 'chosen', printer_name: 'BIXOLON SRP-330II' },
        operatorId: 'user_cashier',
      },
    ]);
    expect(events).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: 't-1',
        branch_id: 'b-1',
        originating_terminal_id: 'term-1',
        acting_operator_id: 'user_cashier',
        session_id: 'sess-1',
        shift_id: null,
        action_category: 'terminal.printer.selected',
        created_at: '2026-10-26T10:00:00.000Z',
        approving_supervisor_id: null,
        payload: {
          previous_source: 'os_default',
          previous_printer_name: null,
          printer_source: 'chosen',
          printer_name: 'BIXOLON SRP-330II',
        },
      },
    ]);
  });

  it('records a first choice with no previous printer', async () => {
    const { service, events } = setup();
    await service.set({ choice: { source: 'os_default' } });
    expect(events[0]?.payload).toEqual({
      previous_source: null,
      previous_printer_name: null,
      printer_source: 'os_default',
      printer_name: null,
    });
  });

  it('writes nothing for an unchanged choice', async () => {
    const chosen = { source: 'chosen', printer_name: 'HP LaserJet' } as const;
    const same = setup({ choice: chosen });
    expect(await same.service.set({ choice: chosen })).toEqual({ kind: 'ok', choice: chosen });
    expect(same.repo.writes).toEqual([]);
    expect(same.events).toEqual([]);
    const os = setup({ choice: { source: 'os_default' } });
    await os.service.set({ choice: { source: 'os_default' } });
    expect(os.events).toEqual([]);
  });

  it('refuses a printer that is not installed now, and saves nothing', async () => {
    const { service, repo, events } = setup();
    expect(await service.set({ choice: { source: 'chosen', printer_name: 'Gone' } })).toEqual({
      kind: 'refused',
      reason: 'printer_not_found',
    });
    expect(repo.writes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('re-checks the session after the printer list was read', async () => {
    let session: PrinterOperatorScope | null = CASHIER;
    const { service, repo } = setup({
      getSession: () => session,
      printers: () => {
        session = null;
        return Promise.resolve(PRINTERS);
      },
    });
    expect(
      await service.set({ choice: { source: 'chosen', printer_name: 'HP LaserJet' } }),
    ).toEqual({
      kind: 'refused',
      reason: 'not_signed_in',
    });
    expect(repo.writes).toEqual([]);
  });

  it('never saves a choice without its audit (one transaction)', async () => {
    const { service } = setup({
      emit: () => {
        throw new Error('audit store down');
      },
    });
    await expect(service.set({ choice: { source: 'os_default' } })).rejects.toThrow(
      'audit store down',
    );
  });

  it('logs the source only, never the printer name', async () => {
    const { service, logger } = setup();
    await service.set({ choice: { source: 'chosen', printer_name: 'BIXOLON SRP-330II' } });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('BIXOLON');
  });
});

describe('printer service — test page: the asking session is re-checked after discovery', () => {
  const chosen = { source: 'chosen', printer_name: 'BIXOLON SRP-330II' } as const;

  /** A session that becomes `after` while the printer list is read. */
  function changingDuring(after: PrinterOperatorScope | null, lockAfter = false) {
    let session: PrinterOperatorScope | null = CASHIER;
    let locked = false;
    return setup({
      choice: chosen,
      getSession: () => session,
      isLocked: () => locked,
      printers: () => {
        session = after;
        locked = lockAfter;
        return Promise.resolve(PRINTERS);
      },
    });
  }

  it('refuses, prints nothing and audits nothing when the session ended', async () => {
    const { service, print, events } = changingDuring(null);
    expect(await service.testPrint()).toEqual({ kind: 'refused', reason: 'not_signed_in' });
    expect(print).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refuses when the session locked meanwhile', async () => {
    const { service, print, events } = changingDuring(CASHIER, true);
    expect(await service.testPrint()).toEqual({ kind: 'refused', reason: 'session_locked' });
    expect(print).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refuses when another session took its place (sign-out / sign-in, takeover)', async () => {
    const other = { ...CASHIER, operator_id: 'user_manager', operator_session_id: 'sess-2' };
    const { service, print, events } = changingDuring(other);
    expect(await service.testPrint()).toEqual({ kind: 'refused', reason: 'not_signed_in' });
    expect(print).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('a printer_missing outcome is not audited for a session that changed', async () => {
    const other = { ...CASHIER, operator_session_id: 'sess-2' };
    let session: PrinterOperatorScope | null = CASHIER;
    const { service, events } = setup({
      choice: { source: 'chosen', printer_name: 'Gone' },
      getSession: () => session,
      printers: () => {
        session = other;
        return Promise.resolve(PRINTERS);
      },
    });
    expect(await service.testPrint()).toEqual({ kind: 'refused', reason: 'not_signed_in' });
    expect(events).toEqual([]);
  });

  it('set refuses too when another session took its place', async () => {
    const other = { ...CASHIER, operator_session_id: 'sess-2' };
    let session: PrinterOperatorScope | null = CASHIER;
    const { service, repo, events } = setup({
      getSession: () => session,
      printers: () => {
        session = other;
        return Promise.resolve(PRINTERS);
      },
    });
    expect(await service.set({ choice: chosen })).toEqual({
      kind: 'refused',
      reason: 'not_signed_in',
    });
    expect(repo.writes).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('printer service — test page (AC5, honest outcome)', () => {
  it('sends a test page through printRendered and audits an accepted job', async () => {
    const chosen = { source: 'chosen', printer_name: 'BIXOLON SRP-330II' } as const;
    const { service, print, events, logger } = setup({ choice: chosen });
    expect(await service.testPrint()).toEqual({ kind: 'accepted', choice: chosen });
    expect(print).toHaveBeenCalledTimes(1);
    const rendered = print.mock.calls[0]?.[0];
    expect(rendered?.html).toContain('صفحة اختبار الطابعة');
    expect(rendered?.html).toContain('BIXOLON SRP-330II');
    expect(events).toHaveLength(1);
    expect(events[0]?.action_category).toBe('terminal.printer.test_printed');
    expect(events[0]?.acting_operator_id).toBe('user_cashier');
    expect(events[0]?.payload).toEqual({
      printer_source: 'chosen',
      printer_name: 'BIXOLON SRP-330II',
      outcome: 'accepted',
      failure_reason: null,
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('BIXOLON');
  });

  it('prints to the Windows default when nothing was chosen', async () => {
    const { service, print, events } = setup();
    expect(await service.testPrint()).toEqual({ kind: 'accepted', choice: null });
    expect(print.mock.calls[0]?.[0].html).toContain('طابعة Windows الافتراضية');
    expect(events[0]?.payload).toMatchObject({ printer_source: null, printer_name: null });
  });

  it('a missing chosen printer fails without printing anywhere', async () => {
    const chosen = { source: 'chosen', printer_name: 'Gone' } as const;
    const { service, print, events } = setup({ choice: chosen });
    expect(await service.testPrint()).toEqual({
      kind: 'failed',
      reason: 'printer_missing',
      choice: chosen,
    });
    expect(print).not.toHaveBeenCalled();
    expect(events[0]?.payload).toMatchObject({
      outcome: 'failed',
      failure_reason: 'printer_missing',
    });
  });

  it('an unknown printer list still sends the job (Electron refuses an unknown device)', async () => {
    const chosen = { source: 'chosen', printer_name: 'XP-80C' } as const;
    const { service, print } = setup({
      choice: chosen,
      printers: () => Promise.reject(new Error('no window')),
    });
    await service.testPrint();
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('a refused or thrown print is a closed print_failed', async () => {
    const refused = setup({
      print: () =>
        Promise.resolve({ ok: false, render_path: 'os_print', failure_reason: 'os_print_error' }),
    });
    expect(await refused.service.testPrint()).toEqual({
      kind: 'failed',
      reason: 'print_failed',
      choice: null,
    });
    expect(refused.events[0]?.payload).toMatchObject({ failure_reason: 'print_failed' });
    const thrown = setup({ print: () => Promise.reject(new Error('boom')) });
    expect(await thrown.service.testPrint()).toMatchObject({ reason: 'print_failed' });
  });

  it('a failed audit does not hide the outcome of a page already sent', async () => {
    const { service, logger } = setup({
      emit: () => {
        throw new TypeError('audit');
      },
    });
    expect(await service.testPrint()).toEqual({ kind: 'accepted', choice: null });
    expect(logger.warn).toHaveBeenCalledWith(
      { event: 'printer.test_print.audit_failed', err_name: 'TypeError' },
      expect.any(String),
    );
  });
});
