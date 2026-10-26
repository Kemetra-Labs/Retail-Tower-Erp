/**
 * RT-886 (RT-839 S1) — the receipt printer choice, for any signed-in operator.
 *
 * Every call first checks for a live, unlocked operator session of ANY role
 * (cashier, manager or admin: owner decision, RT-839 comment 13968). The
 * Settings page stays manager-only and is not used for this.
 *
 *   list       the installed Windows printers, by exact queue name;
 *   get        the saved choice, or null when none was ever saved;
 *   set        save a choice. A named printer must be installed now. The row
 *              and its `terminal.printer.selected` audit are written in ONE
 *              transaction, so a choice is never saved unaudited;
 *   testPrint  send a test page through the receipt print pipeline
 *              (`printRendered`), audited as `terminal.printer.test_printed`.
 *              It writes no `print_events` row (that table belongs to sales).
 *              `accepted` only means Windows accepted the job.
 *
 * Logs carry the event, the source and the outcome only: never a printer name
 * and never slip content.
 */
import type { Logger } from 'pino';

import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type {
  TerminalPrinterSelectedPayload,
  TerminalPrinterTestPrintedPayload,
} from '../../shared/audit/payload-schemas.js';
import type {
  InstalledPrinter,
  PrinterChoice,
  PrinterGetResponse,
  PrinterListResponse,
  PrinterRefused,
  PrinterSetRequest,
  PrinterSetResponse,
  PrinterTestPrintResponse,
  TestPrintFailure,
} from '../../shared/printer/types.js';
import type { PrintPipeline } from '../receipts/print-pipeline.js';
import { isNamedPrinterMissing } from '../receipts/os-print-transport.js';
import type { PrinterSettingRepository } from './printer-setting-repository.js';
import { renderTestPrintSlip } from './test-print-slip.js';

/** The session facts the service needs. Any role passes the gate. */
export interface PrinterOperatorScope {
  operator_id: string;
  operator_session_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

export interface PrinterServiceDeps {
  /** The live operator session on this paired terminal, or null. */
  getSession: () => PrinterOperatorScope | null;
  isSessionLocked: () => boolean;
  repo: PrinterSettingRepository;
  /** The installed OS printers. Rejects or answers [] when discovery fails. */
  listPrinters: () => Promise<InstalledPrinter[]>;
  printer: Pick<PrintPipeline, 'printRendered'>;
  audit: { emit(event: AuditEvent): void };
  /** Runs `fn` atomically (the SQLite transaction in production). */
  transaction: (fn: () => void) => void;
  now: () => string;
  newEventId: () => string;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface PrinterService {
  list(): Promise<PrinterListResponse>;
  get(): Promise<PrinterGetResponse>;
  set(request: PrinterSetRequest): Promise<PrinterSetResponse>;
  testPrint(): Promise<PrinterTestPrintResponse>;
}

const refused = (reason: PrinterRefused['reason']): PrinterRefused => ({ kind: 'refused', reason });

function sameChoice(a: PrinterChoice | null, b: PrinterChoice): boolean {
  if (a === null || a.source !== b.source) return false;
  return a.source === 'os_default' || (b.source === 'chosen' && a.printer_name === b.printer_name);
}

const nameOf = (choice: PrinterChoice | null): string | null =>
  choice?.source === 'chosen' ? choice.printer_name : null;

/** Unique, non-empty names in discovery order. */
function cleanList(printers: readonly InstalledPrinter[]): InstalledPrinter[] {
  const seen = new Set<string>();
  const out: InstalledPrinter[] = [];
  for (const p of printers) {
    if (typeof p.name !== 'string' || p.name === '' || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name });
  }
  return out;
}

export function createPrinterService(deps: PrinterServiceDeps): PrinterService {
  const gate = (): PrinterOperatorScope | PrinterRefused => {
    const session = deps.getSession();
    if (session === null) return refused('not_signed_in');
    if (deps.isSessionLocked()) return refused('session_locked');
    return session;
  };
  const isRefused = (value: PrinterOperatorScope | PrinterRefused): value is PrinterRefused =>
    'kind' in value;

  const installed = async (): Promise<InstalledPrinter[]> =>
    cleanList(await deps.listPrinters().catch(() => []));

  const auditEvent = (
    scope: PrinterOperatorScope,
    category: 'terminal.printer.selected' | 'terminal.printer.test_printed',
    payload: TerminalPrinterSelectedPayload | TerminalPrinterTestPrintedPayload,
  ): AuditEvent => ({
    event_id: deps.newEventId(),
    tenant_id: scope.tenant_id,
    branch_id: scope.branch_id,
    originating_terminal_id: scope.terminal_id,
    acting_operator_id: scope.operator_id,
    session_id: scope.operator_session_id,
    shift_id: null,
    action_category: category,
    created_at: deps.now(),
    approving_supervisor_id: null,
    payload: { ...payload },
  });

  /** Where the test page is going, or why it cannot go there. */
  const testTarget = async (choice: PrinterChoice | null): Promise<TestPrintFailure | null> => {
    if (choice?.source !== 'chosen') return null;
    const printers = await deps.listPrinters().catch(() => []);
    return isNamedPrinterMissing(
      printers.map((p) => ({ name: p.name, isDefault: false })),
      choice.printer_name,
    )
      ? 'printer_missing'
      : null;
  };

  const sendTestPage = async (choice: PrinterChoice | null): Promise<TestPrintFailure | null> => {
    const missing = await testTarget(choice);
    if (missing !== null) return missing;
    try {
      const result = await deps.printer.printRendered(renderTestPrintSlip(choice, deps.now()));
      return result.ok ? null : 'print_failed';
    } catch {
      return 'print_failed';
    }
  };

  return {
    async list() {
      const scope = gate();
      if (isRefused(scope)) return scope;
      return { kind: 'ok', printers: await installed() };
    },

    get() {
      const scope = gate();
      if (isRefused(scope)) return Promise.resolve(scope);
      return Promise.resolve({ kind: 'ok', choice: deps.repo.get() });
    },

    async set(request) {
      const scope = gate();
      if (isRefused(scope)) return scope;
      const { choice } = request;
      if (choice.source === 'chosen') {
        const printers = await installed();
        if (!printers.some((p) => p.name === choice.printer_name)) {
          return refused('printer_not_found');
        }
      }
      // The session may have ended or locked while the list was read.
      const current = gate();
      if (isRefused(current)) return current;
      const previous = deps.repo.get();
      if (sameChoice(previous, choice)) return { kind: 'ok', choice };
      deps.transaction(() => {
        deps.repo.set(choice, { updatedAt: deps.now(), operatorId: current.operator_id });
        deps.audit.emit(
          auditEvent(current, 'terminal.printer.selected', {
            previous_source: previous?.source ?? null,
            previous_printer_name: nameOf(previous),
            printer_source: choice.source,
            printer_name: nameOf(choice),
          }),
        );
      });
      deps.logger?.info(
        { event: 'printer.selected', printer_source: choice.source },
        'printer choice saved',
      );
      return { kind: 'ok', choice };
    },

    async testPrint() {
      const scope = gate();
      if (isRefused(scope)) return scope;
      const choice = deps.repo.get();
      const failure = await sendTestPage(choice);
      try {
        deps.audit.emit(
          auditEvent(scope, 'terminal.printer.test_printed', {
            printer_source: choice?.source ?? null,
            printer_name: nameOf(choice),
            outcome: failure === null ? 'accepted' : 'failed',
            failure_reason: failure,
          }),
        );
      } catch (err) {
        // The page was already sent (or refused); the outcome still answers.
        deps.logger?.warn(
          {
            event: 'printer.test_print.audit_failed',
            err_name: err instanceof Error ? err.name : typeof err,
          },
          'printer test print audit failed',
        );
      }
      deps.logger?.info(
        { event: 'printer.test_printed', outcome: failure ?? 'accepted' },
        'printer test page sent',
      );
      return failure === null
        ? { kind: 'accepted', choice }
        : { kind: 'failed', reason: failure, choice };
    },
  };
}
