/**
 * RT-1490 — the scan side: queue one `posCaptureItem` report for a barcode the
 * local catalogue answered `not_found`.
 *
 * Called by the catalogue bridge after an exact barcode lookup returned
 * `not_found` (never for `one`, `ambiguous`, `catalogue_unavailable` or a
 * refusal). It queues nothing:
 *   • for a code the local catalogue has on an inactive product: the lookup
 *     reports that as `not_found`, but it is a disabled product, not an
 *     unknown item;
 *   • for an empty code or one over the contract's 200 characters;
 *   • while the terminal is unpaired.
 *
 * The row's day is the store business day of the scan (`businessDayOf`,
 * Africa/Cairo), so the one-per-barcode-per-store-per-day cap follows the
 * store's day, not UTC. It never throws into the scan: any failure goes to
 * `onError` and is swallowed. The cashier sees nothing of it.
 */
import { businessDayOf } from '../../shared/time/business-day.js';
import type { UnknownItemCaptureStore } from './capture-store.js';

/** The contract's `identifier_value` bound. */
const MAX_BARCODE_LENGTH = 200;

interface UnknownBarcodeSession {
  readonly tenant_id: string;
  readonly branch_id: string;
}

export type UnknownBarcodeReporter = (barcode: string, session: UnknownBarcodeSession) => void;

export interface UnknownBarcodeReporterDeps {
  readonly store: UnknownItemCaptureStore;
  /** The paired terminal id, or null when unpaired. */
  readonly terminalId: () => string | null;
  readonly now: () => Date;
  /** Mints the row key (UUIDv7 in production). */
  readonly mintId: () => string;
  readonly onError: (err: unknown) => void;
}

export function createUnknownBarcodeReporter(
  deps: UnknownBarcodeReporterDeps,
): UnknownBarcodeReporter {
  return (rawBarcode, session) => {
    try {
      const barcode = rawBarcode.trim();
      if (barcode.length === 0 || barcode.length > MAX_BARCODE_LENGTH) return;
      const terminalId = deps.terminalId();
      if (terminalId === null) return;
      if (deps.store.isKnownBarcode(session.tenant_id, barcode)) return;
      const at = deps.now().toISOString();
      deps.store.enqueue({
        captureId: deps.mintId(),
        scope: { tenantId: session.tenant_id, branchId: session.branch_id, terminalId },
        barcode,
        day: businessDayOf(at),
        at,
      });
    } catch (err: unknown) {
      deps.onError(err);
    }
  };
}
