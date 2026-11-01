import type { salesByStore as ar } from "../ar/salesByStore";
import type { MessagesOf } from "../types";

/** English copy for the «Sales by store» report (RT-1054, Report-stores board). */
export const salesByStore: MessagesOf<typeof ar> = {
  // --- Heading and band ----------------------------------------------------------
  "salesByStore.title": "Sales by store",
  "salesByStore.band.subtitle":
    "Which store received the most and the least in the period, and how did its rank change?",
  "salesByStore.band.label": "Scope totals from the server",
  "salesByStore.fact.received": "Received sales",
  "salesByStore.fact.stores": "Stores",
  "salesByStore.fact.withoutSales": "Stores without sales",

  // --- Controls ------------------------------------------------------------------
  "salesByStore.controls.label": "Range and comparison",
  "salesByStore.preset.label": "Quick ranges",
  "salesByStore.preset.last7": "Last 7 business days",
  "salesByStore.preset.last10": "Last 10 business days",
  "salesByStore.preset.month": "This month so far",
  "salesByStore.compare.label": "Compare with the previous equal period",
  "salesByStore.currency.label": "Ranking currency",

  // --- Context line --------------------------------------------------------------
  "salesByStore.context.scope": "Stores: every store in your scope ({count})",
  "salesByStore.context.baseline": "Previous period: {range}",
  "salesByStore.context.noCompare": "No comparison with the previous period",
  "salesByStore.context.soFar": "Includes days so far",

  // --- Ranking -------------------------------------------------------------------
  "salesByStore.rank.title": "Store ranking",
  "salesByStore.rank.hint": "Bar: the store's share of the scope total, as the server gives it.",
  "salesByStore.rank.hintCompare":
    "Bar: the store's share of the scope total. Badge: change against the previous period.",
  "salesByStore.rank.aria": "Rank {rank}, {name}, {amount}",
  "salesByStore.rank.unrankedAria": "Unranked, {name}",
  "salesByStore.rank.unrankedHeading": "Stores with no sales in this currency",
  "salesByStore.rank.unrankedNote": "Listed after the ranked stores, with no rank.",
  "salesByStore.rank.notRankable":
    "Your scope has one store or none, so there is no ranking. The store's figures are shown as they are.",
  "salesByStore.move.was": "Was rank {rank} in the previous period",
  "salesByStore.move.notRankedBefore": "No sales in the previous period",
  "salesByStore.noSales": "No received sales in this currency in the range",
  "salesByStore.sales.count": "Sales: {count}",
  "salesByStore.share": "{share} of the scope total",
  "salesByStore.delta.aria": "Change against the previous period: {delta}",
  "salesByStore.delta.none": "No comparison: no sales in the previous period",
  "salesByStore.status.inactive": "Inactive",
  "salesByStore.status.deleted": "Deleted",
  "salesByStore.notAvailable": "Not available",

  // --- Store × business day ------------------------------------------------------
  "salesByStore.matrix.title": "Store × business day",
  "salesByStore.matrix.hint":
    "Where and when do sales concentrate? Received amount in the ranking currency, as the server gives it. ★ is the store's best day.",
  "salesByStore.matrix.caption":
    "Received sales of each store on each business day, in the ranking currency",
  "salesByStore.matrix.store": "Store",
  "salesByStore.matrix.best": "Best day",
  "salesByStore.matrix.legend":
    "Hatched cell: a day not over yet. Faded cell: no received sales (a real zero).",

  // --- Selected store panel ------------------------------------------------------
  "salesByStore.panel.label": "Selected store details",
  "salesByStore.panel.rank": "Selected store · Rank {rank}",
  "salesByStore.panel.unranked": "Selected store · Unranked",
  "salesByStore.panel.shareLine": "{share} of the scope total · Sales: {count}",
  "salesByStore.panel.vsPrevious": "Against the previous period",
  "salesByStore.panel.previousTotal": "Previous period",
  "salesByStore.panel.average": "Average sale value",
  "salesByStore.panel.averageNote": "from the server",
  "salesByStore.panel.returns": "Returns",
  "salesByStore.panel.voids": "Voids",
  "salesByStore.panel.legacyRefunds": "Legacy refunds",
  "salesByStore.panel.bestDay": "Best day",
  "salesByStore.panel.days": "Days in the range",
  "salesByStore.panel.storeLink": "Store details",

  // --- Exact figures -------------------------------------------------------------
  "salesByStore.table.title": "Exact figures",
  "salesByStore.table.hint":
    "Each currency on its own line; currencies are never added together. The total is the server's, not a sum of the rows.",
  "salesByStore.table.caption":
    "Received sales, returns and voids of each store over the range, with the previous period",
  "salesByStore.table.col.store": "Store",
  "salesByStore.table.col.sales": "Received sales",
  "salesByStore.table.col.returns": "Returns",
  "salesByStore.table.col.voids": "Voids",
  "salesByStore.table.col.legacy": "Legacy refunds",
  "salesByStore.table.col.baseline": "Previous period ({currency})",
  "salesByStore.table.col.change": "Change",
  "salesByStore.table.total": "Scope total",
  "salesByStore.table.totalSoFar": "Scope total (includes days so far)",

  // --- States --------------------------------------------------------------------
  "salesByStore.loading": "Loading the report…",
  "salesByStore.failed": "The report could not be loaded.",
  "salesByStore.retry": "Try again",
  "salesByStore.rateLimited": "Too many requests. Try again when the wait ends.",
  "salesByStore.rateLimitedHint": "The banner at the top of the page shows the remaining wait.",
  "salesByStore.rejected":
    "The server refused this request. Check the range (31 business days at most) and the currency code.",
  "salesByStore.scopeTooLarge":
    "Your scope is larger than the report can rank (500 stores at most).",
  "salesByStore.scopeTooLargeHint":
    "Nothing is shown and nothing was cut off. Ask a platform admin for a smaller scope.",
  "salesByStore.empty": "There are no stores in your scope.",
  "salesByStore.emptyHint": "Add a store, then come back to the report.",
  "salesByStore.allUnranked":
    "There are no received sales in {currency} in this range, so every store is unranked.",
};
