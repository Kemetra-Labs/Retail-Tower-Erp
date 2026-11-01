/**
 * RT-1020 (v4.0) the reports index catalogue: what the Console can open today
 * and what is only proposed. Pure data and role gates, no React.
 *
 * - `available`: the built reports (daily received sales, sales by store);
 * - `review`: existing review screens, linked as they are;
 * - `proposed`: a report that has no screen and no served figure yet. It is
 *   listed so the owner can see the map, never linked and never given a number.
 *
 * Each openable item uses the same role predicate as the sidebar entry of its
 * screen, so the index never offers a destination the role cannot open
 * (UX-09). The nav is not an authorization decision: the API still answers.
 */
import type { MessageKey } from "@/i18n";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { canReadSales } from "@/sales/saleLogic";
import { canReadShiftCloses } from "@/shift-closes/shiftCloseLogic";
import { canReadStockDiscrepancies } from "@/stock-discrepancies/stockDiscrepancyLogic";

export type ReportKind = "available" | "review" | "proposed";

type Gate = (role: string | null | undefined) => boolean;

export interface ReportItem {
  readonly id: string;
  readonly kind: ReportKind;
  readonly title: MessageKey;
  readonly question: MessageKey;
  /** The route of an openable item; a proposed item has none. */
  readonly to?: string;
  readonly canOpen?: Gate;
}

export interface ReportGroup {
  readonly id: string;
  readonly title: MessageKey;
  readonly items: readonly ReportItem[];
}

const GROUPS: readonly ReportGroup[] = [
  {
    id: "sales",
    title: "reports.group.sales",
    items: [
      {
        id: "daily-sales",
        kind: "available",
        title: "salesDaily.title",
        question: "reports.item.daily.q",
        to: "/sales-daily",
        canOpen: canReadSales,
      },
      {
        id: "sales-by-store",
        kind: "available",
        title: "reports.item.byStore.title",
        question: "reports.item.byStore.q",
        to: "/sales-by-store",
        canOpen: canReadSales,
      },
      {
        id: "sales-by-hour",
        kind: "proposed",
        title: "reports.item.byHour.title",
        question: "reports.item.byHour.q",
      },
    ],
  },
  {
    id: "cash",
    title: "reports.group.cash",
    items: [
      {
        id: "shift-variance",
        kind: "review",
        title: "reports.item.shiftVariance.title",
        question: "reports.item.shiftVariance.q",
        to: "/shift-closes",
        canOpen: canReadShiftCloses,
      },
      {
        id: "shortage-trend",
        kind: "proposed",
        title: "reports.item.shortageTrend.title",
        question: "reports.item.shortageTrend.q",
      },
    ],
  },
  {
    id: "stock",
    title: "reports.group.stock",
    items: [
      {
        id: "stock-discrepancies",
        kind: "review",
        title: "reports.item.stockDiscrepancies.title",
        question: "reports.item.stockDiscrepancies.q",
        to: "/stock-discrepancies",
        canOpen: canReadStockDiscrepancies,
      },
      {
        id: "stock-movement",
        kind: "proposed",
        title: "reports.item.stockMovement.title",
        question: "reports.item.stockMovement.q",
      },
    ],
  },
  {
    id: "erp",
    title: "reports.group.erp",
    items: [
      {
        id: "sales-repair",
        kind: "review",
        title: "reports.item.salesRepair.title",
        question: "reports.item.salesRepair.q",
        to: "/sales-needing-repair",
        canOpen: canUseSaleSyncOps,
      },
      {
        id: "posting-health",
        kind: "proposed",
        title: "reports.item.postingHealth.title",
        question: "reports.item.postingHealth.q",
      },
    ],
  },
];

function isOpenable(item: ReportItem, role: string | null | undefined): boolean {
  return item.kind === "proposed" || (item.canOpen?.(role) ?? false);
}

/** The groups a role sees: an openable item its role cannot open is left out. */
export function reportGroups(role: string | null | undefined): ReportGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isOpenable(item, role)),
  })).filter((group) => group.items.length > 0);
}

/** True when the role can open at least one report or review screen. */
export function canOpenAnyReport(role: string | null | undefined): boolean {
  return GROUPS.some((group) =>
    group.items.some((item) => item.kind !== "proposed" && item.canOpen?.(role)),
  );
}
