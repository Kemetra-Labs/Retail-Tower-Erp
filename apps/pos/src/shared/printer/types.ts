/**
 * RT-886 (RT-839 S1+S2) — the receipt printer choice bridge contract
 * (`window.api.printer`).
 *
 * The terminal prints through the Windows OS print path. Without a choice,
 * Windows sends the job to its default printer, which is often a paper printer
 * rather than the thermal one. Any signed-in operator (cashier, manager or
 * admin) may pick an installed printer or «Windows default» here (owner
 * decision, RT-839 comment 13968); main checks for a live session on every call.
 *
 * The choice is local to this computer (migration 0057, one row). It has no
 * Backend-Core contract: an OS print-queue name means nothing off this machine.
 *
 * The bridge carries printer names (the operator picks one) and closed codes
 * only: no slip content, no operator identity, no credential.
 */

export const PRINTER_IPC_CHANNELS = {
  LIST: 'printer:list',
  GET: 'printer:get',
  SET: 'printer:set',
  TEST_PRINT: 'printer:testPrint',
} as const;

/** Which printer a print goes to: the chosen queue, or Windows' default. */
export const PRINTER_SOURCES = ['chosen', 'os_default'] as const;
export type PrinterSource = (typeof PRINTER_SOURCES)[number];

/** Longest printer name accepted. Windows queue names are far shorter. */
export const PRINTER_NAME_MAX_LENGTH = 256;

/** The terminal's printer choice. «Windows default» is a choice too. */
export type PrinterChoice = { source: 'os_default' } | { source: 'chosen'; printer_name: string };

/** One installed OS printer, by its exact system name. */
export interface InstalledPrinter {
  name: string;
}

/** Why main refused a printer call (nothing was changed or printed). */
export const PRINTER_REFUSALS = [
  /**
   * No operator session (any role is enough), or the session that asked ended
   * or was replaced by another one while the call was running.
   */
  'not_signed_in',
  /** The session is locked (also when it locked while the call was running). */
  'session_locked',
  /** The request does not have the closed shape. */
  'invalid_input',
  /** The chosen printer is not installed on this computer now. */
  'printer_not_found',
  /** Main could not answer (logged by name only). */
  'printer_unavailable',
] as const;
export type PrinterRefusalReason = (typeof PRINTER_REFUSALS)[number];

export interface PrinterRefused {
  kind: 'refused';
  reason: PrinterRefusalReason;
}

export type PrinterListResponse = { kind: 'ok'; printers: InstalledPrinter[] } | PrinterRefused;

/** `choice: null` — no printer has been chosen on this computer yet. */
export type PrinterGetResponse = { kind: 'ok'; choice: PrinterChoice | null } | PrinterRefused;

export interface PrinterSetRequest {
  choice: PrinterChoice;
}

export type PrinterSetResponse = { kind: 'ok'; choice: PrinterChoice } | PrinterRefused;

/**
 * Why a test page did not reach Windows, as a closed code:
 *   - `printer_missing` — the chosen printer is not installed now; nothing was sent;
 *   - `print_failed` — Windows refused the job, or it timed out.
 */
export const TEST_PRINT_FAILURES = ['printer_missing', 'print_failed'] as const;
export type TestPrintFailure = (typeof TEST_PRINT_FAILURES)[number];

/**
 * `accepted` means only that Windows accepted the job. It never proves that
 * paper came out of the right printer (os-print-transport.ts), so the copy
 * asks the operator to check.
 */
export type PrinterTestPrintResponse =
  | { kind: 'accepted'; choice: PrinterChoice | null }
  | { kind: 'failed'; reason: TestPrintFailure; choice: PrinterChoice | null }
  | PrinterRefused;

/** The `printer.*` namespace. Every call needs a live, unlocked session. */
export interface PrinterBridgeAPI {
  list(): Promise<PrinterListResponse>;
  get(): Promise<PrinterGetResponse>;
  set(request: PrinterSetRequest): Promise<PrinterSetResponse>;
  testPrint(): Promise<PrinterTestPrintResponse>;
}
