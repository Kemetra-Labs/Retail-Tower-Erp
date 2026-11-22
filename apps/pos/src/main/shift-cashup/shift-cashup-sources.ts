/**
 * RT-17 slice 3 part 3 — the cash-up calculator's sources, read from the
 * local sale and return tables of ONE terminal for ONE window:
 *
 *   • sales: `sales` rows of the scope (tenant, branch, terminal) whose
 *     `finalized_at` is in the window, with their frozen tender summary
 *     (008; append-only, so a sale's cash never changes after the fact);
 *   • refunds: RT-15 return payouts COMPLETED (`return_payouts.paid_at`) in
 *     the window, joined to the journaled return of the scope for its
 *     server-confirmed amount (`return_total_minor`), its server reference
 *     (`return_ref`) and its currency. `drawer` and `manual` payouts both
 *     count: either way the cash left this drawer (RT-15 S4: `manual` = the
 *     operator opened the drawer by hand). So does `no_drawer` (RT-531: the
 *     terminal has no cash drawer, the payout completed without an attestation):
 *     the query never filters on `method`, and a test pins that every method
 *     is counted the same. A started payout that never
 *     completed has no `paid_at` and matches no window.
 *
 * Windows never overlap (review P2-1). A window is [from, to] (both ends
 * included) AND after `after`, the terminal's previous local close
 * (`lastClosedAt`), whose instant is EXCLUDED: that close already counted
 * it, so a sale finalized in the very millisecond of a close and of a
 * same-millisecond reopen is counted once. The bound holds even when the
 * open shift's `openedAt` lies before that close (a clock that stepped
 * back). And a return ref any local close already reported in
 * `cashRefundReturnRefs` is never offered again (compared in lower case, as
 * the close stores it): Backend-Core refuses a ref another shift's close
 * claimed (422 `refund_ref_invalid`).
 *
 * Void payouts (RT-530, RT-1403 S2): `sale_void_payouts` rows (migration 0069) whose
 * `paid_at` is in the window: the cash a void handed back out of the drawer, a gated
 * payout of a confirmed void or a manager-attested exception. A void REQUEST counts
 * nothing; only the payout record does.
 *
 * `pendingDrawerActivity` (review P2-2) counts the scope's drawer cash still
 * in flight, which the cash-up cannot read yet:
 *   • refundPayouts     RT-15 payouts started (the drawer may already be
 *                       open) but not completed (`paid_at IS NULL`);
 *   • voidPayouts       RT-1403 S2 void payout claims (migration 0069) with no
 *                       payout record yet, while the claim's own shift is open: same
 *                       shape, same hold. A claim whose shift is closed (locally or by a
 *                       manager closure) is stale: it holds nothing, and only the
 *                       manager-attested cash exception settles it;
 *   • unfinalizedSales  `payment.settled` audits of the terminal that the 008
 *                       finalize listener has not turned into a sale yet —
 *                       the listener's own pending-set filter — PLUS (RT-496)
 *                       the terminal's settled attempts stranded with no such
 *                       audit and no sale (`STRANDED_SETTLEMENT_FILTER`; the
 *                       two sets are disjoint). Either way money was taken
 *                       and is not a sale yet, so the close is held; an
 *                       unattributable strand holds it until it is resolved
 *                       by hand.
 *
 * Instants are compared as instants (`julianday`), never as strings.
 */
import type { DatabaseHandle } from '../db/client.js';
import { UNFINALIZED_SETTLEMENT_FILTER } from '../sales/finalize-listener.js';
import { STRANDED_SETTLEMENT_FILTER } from '../payments/settled-audit-reconciler.js';
import type { CashupRefund, CashupSale, CashupVoidPayout } from './shift-cashup-calculator.js';
import type { ShiftScope } from './shift-cashup-repo.js';

export interface CashupWindow {
  /** The shift's `openedAt` (included). */
  from: string;
  /** The terminal's previous local close (excluded); null when none. */
  after: string | null;
  /** Now (a pay-out) or the close's `closedAt` (included). */
  to: string;
}

export interface CashupSourceQuery {
  scope: ShiftScope;
  window: CashupWindow;
}

/** The scope's drawer cash in flight (counts only). */
export interface PendingDrawerActivity {
  refundPayouts: number;
  /**
   * RT-1403 S2 (H1, M1): void payouts CLAIMED (the drawer may be open or the kick unresolved) with no
   * payout record yet, in a shift that is still open: that shift cannot close over them. A claim of a
   * closed shift is not counted (c18183): it never blocks the next shift from opening.
   */
  voidPayouts: number;
  unfinalizedSales: number;
}

export interface ShiftCashupSources {
  salesIn(query: CashupSourceQuery): CashupSale[];
  refundsIn(query: CashupSourceQuery): CashupRefund[];
  /**
   * RT-1403 S2: the cash the scope's voids paid out in the window, from the payout
   * records (never from a void request): the gated payout of a confirmed void and
   * the manager-attested exception both left the drawer.
   */
  voidsIn(query: CashupSourceQuery): CashupVoidPayout[];
  /** The `closedAt` of the scope's latest local close; null when none. */
  lastClosedAt(scope: ShiftScope): string | null;
  pendingDrawerActivity(scope: ShiftScope): PendingDrawerActivity;
  /**
   * RT-440 (spec 024 K4, OP-2) — parked sales on the scope's terminal, whoever
   * parked them. A count only: no owner, label or amount.
   */
  parkedSales(scope: ShiftScope): number;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}
interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}
/** A `COUNT(*)` always yields its one row. */
interface PrepareCount {
  get(...params: unknown[]): { n: number };
}

/**
 * `column` in the window; params `from, to, after`. A null `after` is no
 * bound: `julianday(NULL)` is NULL, coalesced to 0, before every instant.
 */
function inWindow(column: string): string {
  return `julianday(${column}) BETWEEN julianday(?) AND julianday(?)
    AND julianday(${column}) > COALESCE(julianday(?), 0)`;
}

const SALES_SQL = `
  SELECT tender_lines_summary_json AS tenderLinesSummaryJson
  FROM sales
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
    AND ${inWindow('finalized_at')}
  ORDER BY finalized_at, sale_id`;

const REFUNDS_SQL = `
  SELECT j.return_ref AS returnRef, j.return_total_minor AS amountMinor,
         j.currency_code AS currencyCode
  FROM return_payouts p JOIN return_journal j ON j.return_id = p.return_id
  WHERE j.tenant_id = ? AND j.branch_id = ? AND j.terminal_id = ?
    AND ${inWindow('p.paid_at')}
    AND NOT EXISTS (
      SELECT 1 FROM shift_cashup_closes c, json_each(c.cash_refund_return_refs_json) claimed
      WHERE claimed.value = lower(j.return_ref))
  ORDER BY p.paid_at, j.return_id`;

const VOIDS_SQL = `
  SELECT p.amount_minor AS amountMinor, p.currency_code AS currencyCode
  FROM sale_void_payouts p
  WHERE p.tenant_id = ? AND p.branch_id = ? AND p.terminal_id = ?
    AND ${inWindow('p.paid_at')}
  ORDER BY p.paid_at, p.payout_id`;

const LAST_CLOSED_AT_SQL = `
  SELECT c.closed_at AS closedAt
  FROM shift_cashup_closes c JOIN shift_cashup_opens o ON o.shift_id = c.shift_id
  WHERE o.tenant_id = ? AND o.branch_id = ? AND o.terminal_id = ?
  ORDER BY julianday(c.closed_at) DESC
  LIMIT 1`;

const PENDING_PAYOUTS_SQL = `
  SELECT COUNT(*) AS n
  FROM return_payouts p JOIN return_journal j ON j.return_id = p.return_id
  WHERE j.tenant_id = ? AND j.branch_id = ? AND j.terminal_id = ? AND p.paid_at IS NULL`;

/**
 * Void payout claims that hold the till: no record yet AND the claim's own shift still open (no
 * close, no manager closure: the repo's definition of an open shift). A claim whose shift is gone can
 * never be completed by `retry_drawer` or `manual` (they need that shift), so it must not block the
 * next shift from opening; only the manager-attested cash exception settles it (RT-1403 c18183).
 */
const PENDING_VOID_PAYOUTS_SQL = `
  SELECT COUNT(*) AS n
  FROM sale_void_payout_claims c
  WHERE c.tenant_id = ? AND c.branch_id = ? AND c.terminal_id = ?
    AND NOT EXISTS (SELECT 1 FROM sale_void_payouts p WHERE p.void_id = c.void_id)
    AND NOT EXISTS (SELECT 1 FROM shift_cashup_closes cl WHERE cl.shift_id = c.shift_id)
    AND NOT EXISTS (SELECT 1 FROM shift_manager_closures m WHERE m.shift_id = c.shift_id)`;

const PARKED_SALES_SQL = `
  SELECT COUNT(*) AS n FROM carts
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
    AND parked_at IS NOT NULL AND state = 'editing'`;

const UNFINALIZED_SALES_SQL = `
  SELECT COUNT(*) AS n FROM audit_events WHERE ${UNFINALIZED_SETTLEMENT_FILTER}`;

const STRANDED_SETTLEMENTS_SQL = `
  SELECT COUNT(*) AS n FROM payment_attempts a WHERE ${STRANDED_SETTLEMENT_FILTER}`;

function scopeParams(scope: ShiftScope): string[] {
  return [scope.tenantId, scope.branchId, scope.terminalId];
}

export function createShiftCashupSources(db: DatabaseHandle): ShiftCashupSources {
  function count(sql: string, params: readonly unknown[]): number {
    return (db.prepare(sql) as PrepareCount).get(...params).n;
  }

  function lastClosedAt(scope: ShiftScope): string | null {
    const stmt = db.prepare(LAST_CLOSED_AT_SQL) as PrepareGet<{ closedAt: string }>;
    return stmt.get(...scopeParams(scope))?.closedAt ?? null;
  }

  function read<Row>(sql: string, query: CashupSourceQuery): Row[] {
    const { window } = query;
    return (db.prepare(sql) as PrepareAll<Row>).all(
      ...scopeParams(query.scope),
      window.from,
      window.to,
      window.after,
    );
  }

  return {
    salesIn: (query) => read<CashupSale>(SALES_SQL, query),
    refundsIn: (query) => read<CashupRefund>(REFUNDS_SQL, query),
    voidsIn: (query) => read<CashupVoidPayout>(VOIDS_SQL, query),
    lastClosedAt,
    pendingDrawerActivity: (scope) => ({
      refundPayouts: count(PENDING_PAYOUTS_SQL, scopeParams(scope)),
      voidPayouts: count(PENDING_VOID_PAYOUTS_SQL, scopeParams(scope)),
      unfinalizedSales:
        count(UNFINALIZED_SALES_SQL, [scope.terminalId]) +
        count(STRANDED_SETTLEMENTS_SQL, scopeParams(scope)),
    }),
    parkedSales: (scope) => count(PARKED_SALES_SQL, scopeParams(scope)),
  };
}
