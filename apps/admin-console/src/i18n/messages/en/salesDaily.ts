import type { salesDaily as ar } from "../ar/salesDaily";
import type { MessagesOf } from "../types";

/** English copy for the daily received-sales report (RT-821, VIZ-3). */
export const salesDaily: MessagesOf<typeof ar> = {
  // --- Entry and heading -------------------------------------------------------
  "salesDaily.entry": "Daily received sales",
  "salesDaily.title": "Daily received sales",
  "salesDaily.back": "Sales",

  // --- Range form --------------------------------------------------------------
  "salesDaily.range.label": "Business-date range",
  "salesDaily.range.note": "At most 31 business days, both ends included.",
  "salesDaily.range.rejected":
    "The server rejected this range. Use real dates, at most 31 business days.",

  // --- Context -----------------------------------------------------------------
  "salesDaily.context.calendar": "By each store's local business day",
  "salesDaily.context.zonesPartial": {
    one: "zones of the first {count} store only; the other stores were not read",
    other: "zones of the first {count} stores only; the other stores were not read",
  },
  "salesDaily.context.soFar":
    "Days marked (so far) are not over yet in at least one store, and the range total includes them.",

  // --- Tables ------------------------------------------------------------------
  "salesDaily.table.money.caption":
    "Received sales, voids, returns and legacy refunds per business day",
  "salesDaily.table.money.hint":
    "Each cell: the count, then the total in each currency on its own line. Currencies are never added together.",
  "salesDaily.table.status.caption":
    "Sync state, ERPNext posting state and shift closes per business day",
  "salesDaily.table.status.hint":
    "Sync and ERP states are the state now (as of the read) of each day's received sales, not a backlog on that day.",
  "salesDaily.col.day": "Business day",
  "salesDaily.row.notBegun": "(not yet begun)",
  "salesDaily.row.total": "Range total",
  "salesDaily.row.totalSoFar": "Range total (includes days so far)",

  // --- Chart (RT-823, VIZ-5) ---------------------------------------------------
  "salesDaily.chart.title": "Received sales per business day",
  "salesDaily.chart.summary":
    "A summary of the table below: one bar per business day, in {currency}. Select a bar to go to its row. The exact figures are in the table.",
  "salesDaily.chart.legend":
    "A hatched bar is a day still running (so far). A day with no figure from the server is marked Unknown and has no bar.",
  "salesDaily.chart.currency": "Currency",
  "salesDaily.chart.bar": "{date}: {value} {currency}",
  "salesDaily.chart.barSoFar": "{date}: {value} {currency}, so far",
  "salesDaily.chart.barUnknown": "{date}: unknown",
  "salesDaily.chart.barNotBegun": "{date}: not yet begun",
  "salesDaily.chart.soFar": "So far",
  "salesDaily.chart.unknown": "Unknown",
  "salesDaily.chart.notBegun": "Not begun",
  "salesDaily.chart.empty": "No sales were received in this range.",
  "salesDaily.chart.emptyUnknown": "The server returned no figures for these days.",

  // --- Export (RT-824, VIZ-6) --------------------------------------------------
  "salesDaily.export.button": "Export CSV",
  "salesDaily.export.hint":
    "Downloads the figures in the tables below with this context: scope, stores and time zones, range, as-of time and completeness.",

  // --- Definitions -------------------------------------------------------------
  "salesDaily.about": "What these figures mean",

  // --- States ------------------------------------------------------------------
  "salesDaily.loading": "Loading the report…",
  "salesDaily.failed": "The report could not be loaded.",
  "salesDaily.retry": "Retry",
  "salesDaily.rateLimited": "Too many requests. Try again when the wait ends.",
  "salesDaily.rateLimitedHint": "The banner at the top of the page shows the time left.",

  // --- RT-1020 (v4.0): the report's band and day panel -------------------------
  "salesDaily.band.group": "Reports · Sales",
  "salesDaily.band.label": "Report context from the server",
  "salesDaily.band.subStore": "{store} · {tenant}",
  "salesDaily.band.subScope": "All stores in scope · {tenant}",
  "salesDaily.band.subTenant": "{tenant}",
  "salesDaily.band.zone": "Time zone",
  "salesDaily.band.asOf": "Read at",
  "salesDaily.back.reports": "Reports",
  "salesDaily.day.title": "Business day detail",
  "salesDaily.day.hint":
    "The same figures as the day's row in the two tables below, with no new calculation.",
  "salesDaily.day.pick": "Business day",
  "salesDaily.day.notBegunNote": "This business day has not begun, so it has no figures yet.",
  "salesDaily.day.unknownNote":
    "The figures for this day could not be determined, and they are not zero.",
  "salesDaily.day.salesLink": "Sales for this day",
  "salesDaily.day.rowLink": "This day's row in the table",

  // --- RT-1020 (v4.0): the reports index ---------------------------------------
  "reports.nav.label": "Reports",
  "reports.index.sub":
    "{tenant} · each report answers one question with server figures and their context",
  "reports.index.noneOpen": "Your role has no report or review screen here.",
  "reports.group.sales": "Sales",
  "reports.group.cash": "Cash and shifts",
  "reports.group.stock": "Inventory",
  "reports.group.erp": "ERPNext integration",
  "reports.status.available": "Available",
  "reports.status.review": "Review screen",
  "reports.status.proposed": "Proposed, not available yet",
  "reports.answers": "Answers:",
  "reports.open.report": "Open the report",
  "reports.open.screen": "Open the screen",
  "reports.item.daily.q":
    "How many sales, voids and returns did the server receive each business day, and where are their sync and ERPNext posting now?",
  "reports.item.shiftVariance.title": "Cash variance in shifts",
  "reports.item.shiftVariance.q":
    "Which shift close recorded a shortage or an overage, and was an approver recorded?",
  "reports.item.stockDiscrepancies.title": "ERPNext stock discrepancies",
  "reports.item.stockDiscrepancies.q":
    "Which items are negative in the latest ERPNext snapshot of each store?",
  "reports.item.salesRepair.title": "Sales needing repair",
  "reports.item.salesRepair.q": "Which sales stopped syncing, why, and who asked for the repair?",
  "reports.item.byStore.title": "Sales by store",
  "reports.item.byStore.q":
    "Which store received the most and the least in the period, and how did its rank change?",
  "reports.item.byHour.title": "Sales by hour",
  "reports.item.byHour.q":
    "When do sales peak in the business day, and are there enough registers then?",
  "reports.item.shortageTrend.title": "Shortage and overage trend",
  "reports.item.shortageTrend.q": "Does a shortage repeat in one store or shift across the weeks?",
  "reports.item.stockMovement.title": "Stock movement by type",
  "reports.item.stockMovement.q":
    "How much stock came in, went out, was adjusted and was transferred in the period, per store?",
  "reports.item.postingHealth.title": "Posting health across days",
  "reports.item.postingHealth.q":
    "How many days ended with every sale posted, and where do failures cluster?",
};
