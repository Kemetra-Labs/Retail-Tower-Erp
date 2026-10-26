/**
 * RT-856 (RT-699 I3, doc 28 §6 DEP-1 guard) — hold discounted sales from sync
 * until the capture path can send them.
 *
 * Before RT-858 the POS could not send the line `discount`. Sent anyway, a
 * discounted sale would carry gross `lineAmount`s with a net total:
 * Backend-Core answers 4xx and the drain dead-letters it, which is terminal. So
 * the drain HOLDS it instead: skipped untouched (no POST, no state row, no
 * attempt), still pending, never dead-lettered. Once the switch is on, the same
 * stored sale drains on the next tick with no requeue step.
 *
 * RT-858 (RT-699 I4) turns {@link SALE_DISCOUNT_CAPTURE_SUPPORTED} on: the
 * capture sends the RT-740 `discount` (C-A), so the held sales drain. One
 * discount still cannot be sent faithfully: `sales.yaml` requires
 * `approverRole`, and the Sale records it only when the audit row did (a
 * cashier approval from a PIN record with no role yet has none, RT-861). The
 * role is never invented, and a dead letter is terminal, so such a sale stays
 * held under the same reason. The switch is a code constant, not an
 * environment variable, on purpose: ops cannot turn the capture rule off.
 */
import type { SaleRow } from '../sales/repositories/sales.repository.js';

/** Whether the capture path can send a discounted sale. On since RT-858. */
export const SALE_DISCOUNT_CAPTURE_SUPPORTED = true;

/** The closed set of reasons a pending sale is held from sync. */
export const SALE_SYNC_HELD_REASONS = ['discount_capture_unavailable'] as const;
export type SaleSyncHeldReason = (typeof SALE_SYNC_HELD_REASONS)[number];

/** The held subset of the pending sales, with its named reason. Counts only (P7). */
export interface SaleSyncHold {
  reason: SaleSyncHeldReason;
  count: number;
}

/** The approver roles the capture contract accepts (`CaptureSaleLineDiscount.approverRole`). */
export const CAPTURE_APPROVER_ROLES: ReadonlySet<unknown> = new Set(['manager', 'admin']);

function discountOf(line: unknown): unknown {
  if (line === null || typeof line !== 'object') return undefined;
  return (line as Record<string, unknown>)['discount'];
}

function hasDiscount(line: unknown): boolean {
  const discount = discountOf(line);
  return discount !== undefined && discount !== null;
}

/** A discount the capture cannot send: no recorded approver role the contract accepts. */
function hasUnsendableDiscount(line: unknown): boolean {
  if (!hasDiscount(line)) return false;
  const discount = discountOf(line);
  const role =
    typeof discount === 'object'
      ? (discount as Record<string, unknown>)['approver_role']
      : undefined;
  return !CAPTURE_APPROVER_ROLES.has(role);
}

/** Whether any line matches; an unreadable snapshot or a non-list matches (held, never a guess). */
function anyLine(sale: Pick<SaleRow, 'lines_json'>, test: (line: unknown) => boolean): boolean {
  let lines: unknown;
  try {
    lines = JSON.parse(sale.lines_json);
  } catch {
    return true;
  }
  return !Array.isArray(lines) || lines.some(test);
}

/**
 * Whether any line of the sale carries a frozen `discount`. An unreadable
 * snapshot counts as discounted: it is held, never sent as a guess.
 */
export function saleHasLineDiscount(sale: Pick<SaleRow, 'lines_json'>): boolean {
  return anyLine(sale, hasDiscount);
}

/**
 * RT-858: whether the drain holds the sale. With discount capture off, every
 * discounted sale is held; with it on, only a sale with a discount the capture
 * cannot send (no recorded approver role) or an unreadable snapshot. The SQL
 * twin is `discountHeldSaleSql` in the state repo; the two must agree.
 */
export function isSaleHeldFromSync(
  sale: Pick<SaleRow, 'lines_json'>,
  discountCaptureSupported: boolean,
): boolean {
  return anyLine(sale, discountCaptureSupported ? hasUnsendableDiscount : hasDiscount);
}
