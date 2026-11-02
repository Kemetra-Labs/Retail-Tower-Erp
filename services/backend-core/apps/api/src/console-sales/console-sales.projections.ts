/**
 * RT-562 — pure wire projections and page assembly of the console sales read
 * (`console-sales.openapi.yaml` 1.0.0-draft). No DB, no clock.
 *
 * The console reads the same recorded sale facts as the POS sale history, so
 * the item and the detail are the sale-history projections (RT-539) with the
 * POS-only parts removed (`visibility`, `receiptFacts`, `reprint`) and the
 * store added (`storeRef`, `storeTimezone`): both reads describe one sale the
 * same way by construction. Console-only additions (1.2.0-draft, RT-1061):
 * `ConsoleSaleItem.syncStatusVersion` (RT-973) and
 * `ConsoleSaleDetail.erpPostingFailure` (RT-977); the POS projections never
 * carry them.
 *
 * Every filter (`sale_number`, `sync_status`, `voided`, `return_state`,
 * `erp_posting_state`) is matched against the PROJECTED item, so a filter and
 * the value it shows can never disagree (for example `unknown` covers every
 * posting status the projection maps to `unknown`, not only a missing posting
 * row), and the rows one request reads stay bounded whatever the filter.
 */
import {
  toSaleHistoryItem,
  type SaleHistoryDetail,
  type SaleHistoryItem,
  type SaleHistoryRow,
} from "../catalog/sales/history/sale-history.projections";
import type { SaleHistoryKeyset } from "../catalog/sales/history/sale-history.query";
import { syncStatusVersionOf } from "../catalog/sales/sale-sync-status";
import type { ConsoleErpPostingFailure } from "./console-sales.posting-failure";
import type { ConsoleSaleFilters } from "./console-sales.query";

/** A row of `SALE_SELECT_SQL` as the console reads it: the sale-history row plus the RT-973 version (BIGINT as text). */
export type ConsoleSaleRow = SaleHistoryRow & { readonly sync_status_version: string };

export type ConsoleSaleItem = SaleHistoryItem & {
  readonly storeRef: string;
  /** RT-973 (1.2.0-draft): the ordering of `syncStatus` across reads of this sale. */
  readonly syncStatusVersion: number;
};

export type ConsoleSaleDetail = Omit<SaleHistoryDetail, "summary" | "receiptFacts" | "reprint"> & {
  readonly summary: ConsoleSaleItem;
  readonly storeTimezone: string;
  /** RT-977 (1.2.0-draft): why a failed posting of this sale failed, and its repair handle. */
  readonly erpPostingFailure: ConsoleErpPostingFailure | null;
};

export interface ConsoleSalePage {
  readonly items: ReadonlyArray<ConsoleSaleItem>;
  readonly nextCursor: string | null;
  readonly asOf: string;
  readonly storeRef: string;
  readonly storeTimezone: string;
  readonly from: string;
  readonly to: string;
}

export function toConsoleSaleItem(item: SaleHistoryItem, storeRef: string, syncStatusVersion: string): ConsoleSaleItem {
  const { saleRef, ...rest } = item;
  return { saleRef, storeRef, ...rest, syncStatusVersion: syncStatusVersionOf(syncStatusVersion) };
}

export interface ConsoleDetailInput {
  readonly detail: SaleHistoryDetail;
  readonly storeRef: string;
  readonly storeTimezone: string;
  /** The sale row's `sync_status_version` (BIGINT as text). */
  readonly syncStatusVersion: string;
  readonly erpPostingFailure: ConsoleErpPostingFailure | null;
}

/** The sale-history detail as the console detail: no POS-only facts, plus the store and the console-only fields. */
export function toConsoleSaleDetail(input: ConsoleDetailInput): ConsoleSaleDetail {
  const { summary, receiptFacts: _receiptFacts, reprint: _reprint, ...facts } = input.detail;
  return {
    summary: toConsoleSaleItem(summary, input.storeRef, input.syncStatusVersion),
    storeTimezone: input.storeTimezone,
    ...facts,
    erpPostingFailure: input.erpPostingFailure,
  };
}

/** The list filters, matched on the projected item. */
export function matchesFilters(item: SaleHistoryItem, filters: ConsoleSaleFilters): boolean {
  const wanted: ReadonlyArray<readonly [unknown, unknown]> = [
    [filters.saleNumber, item.saleNumber],
    [filters.syncStatus, item.syncStatus],
    [filters.voided, item.voided],
    [filters.returnState, item.returnState],
    [filters.erpPostingState, item.erpPostingState],
  ];
  // A null filter is not set; a set one must equal the projected value.
  return wanted.every(([filter, value]) => filter === null || filter === value);
}

export function keysetOf(row: ConsoleSaleRow): SaleHistoryKeyset {
  return { businessDate: row.business_date, occurredAtKey: row.occurred_at_key, saleId: row.sale_id };
}

export interface AssembledPage {
  readonly items: ConsoleSaleItem[];
  /** Where the next page starts; null when the walk has ended. */
  readonly resumeAfter: SaleHistoryKeyset | null;
}

/**
 * One page from the rows the server read (in list order, at most `readLimit`).
 *
 *   - more matches than `pageSize`: the first `pageSize`; resume after the last RETURNED row;
 *   - otherwise, when the read was cut at `readLimit`: every match (possibly none); resume
 *     after the last row READ, so the next page never re-reads this window;
 *   - otherwise the range is exhausted: every match, and the walk ends.
 *
 * Either resume point is a row this request read, so every non-null cursor
 * moves the walk forward.
 */
export function assemblePage(input: {
  readonly rows: ReadonlyArray<ConsoleSaleRow>;
  readonly readLimit: number;
  readonly pageSize: number;
  readonly storeRef: string;
  readonly filters: ConsoleSaleFilters;
}): AssembledPage {
  const matched = input.rows
    .map((row) => ({ row, item: toConsoleSaleItem(toSaleHistoryItem(row), input.storeRef, row.sync_status_version) }))
    .filter(({ item }) => matchesFilters(item, input.filters));
  if (matched.length > input.pageSize) {
    const page = matched.slice(0, input.pageSize);
    return { items: page.map(({ item }) => item), resumeAfter: keysetOf(page.at(-1)!.row) };
  }
  const lastRead = input.rows.length >= input.readLimit ? input.rows.at(-1) : undefined;
  return { items: matched.map(({ item }) => item), resumeAfter: lastRead === undefined ? null : keysetOf(lastRead) };
}
