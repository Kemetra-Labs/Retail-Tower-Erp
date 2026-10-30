import type { overview as ar } from "../ar/overview";
import type { MessagesOf } from "../types";

/** English copy for the Overview landing (RT-559, spec 009). */
export const overview: MessagesOf<typeof ar> = {
  "overview.refresh": "Refresh",
  "overview.refreshing": "Refreshing…",

  // --- Attention ledger (P-1…P-4) --------------------------------------------
  "overview.attention.title": "Needs your attention",
  "overview.attention.nothingForRole": "No attention items are available to your role here.",
  "overview.count.exact": "{noun}: {count}",
  "overview.count.atLeast": "{noun}: {count} or more",
  "overview.count.none": "None",
  "overview.count.unproven": "The list has more to check",
  "overview.row.loading": "Loading…",
  "overview.row.failed": "Couldn't load.",
  "overview.row.retry": "Retry",

  "overview.stock.label": "Stock discrepancies · {store}",
  "overview.stock.noun": "Negative items",
  "overview.stock.asOf": "as of {asOf}",
  "overview.stock.open": "View store discrepancies",
  "overview.stock.none": "No stores to show discrepancies for.",
  "overview.stock.labelAll": "Stock discrepancies",
  "overview.stock.more": "Some stores aren't shown here. Open stock discrepancies to see them all.",
  "overview.stock.openAll": "View the full list",

  "overview.shift.label": "Shift-close variances with no recorded approver (last 7 days)",
  "overview.shift.noun": "Closes",
  "overview.shift.open": "Review closes",

  "overview.unknown.label": "Unknown items pending review",
  "overview.unknown.noun": "Items",
  "overview.unknown.open": "Review items",

  // --- Overview v2 (RT-970) ---------------------------------------------------
  "overview.unavailable": "Not available",
  "overview.panel.failed": "Couldn't load this part. Nothing was changed.",
  "overview.panel.retry": "Try again",

  "overview.kpi.label": "Today so far",
  "overview.kpi.transactions": "Transactions",
  "overview.kpi.soFar": "So far · {date}",
  "overview.kpi.compareNote": "Today so far is compared with the previous business day in full.",
  "overview.kpi.up": "Higher than the previous business day in full ({value})",
  "overview.kpi.down": "Lower than the previous business day in full ({value})",
  "overview.kpi.same": "Same as the previous business day in full ({value})",
  "overview.kpi.previousUnknown": "Previous business day: not available",
  "overview.kpi.mixed":
    "Stores are on different business days, so the scope has no single today. Choose a store, or open daily sales.",
  "overview.kpi.none": "No stores in scope.",

  "overview.pipeline.label": "A sale's path from the till to ERPNext",
  "overview.pipeline.pos": "Points of sale",
  "overview.pipeline.devices": "Trusted devices: {count}",
  "overview.pipeline.devicesAtLeast": "Trusted devices: {count} or more",
  "overview.pipeline.posNote": "Last activity isn't recorded, so connectivity isn't shown.",
  "overview.pipeline.server": "Received by the server",
  "overview.pipeline.received": "Today's sales: {count}",
  "overview.pipeline.asOf": "As of {asOf}",
  "overview.pipeline.erp": "Posting to ERPNext",
  "overview.pipeline.posted": "Posted: {posted} of {received}",
  "overview.pipeline.openDevices": "View devices",
  "overview.pipeline.openSales": "View sales",
  "overview.pipeline.openRepair": "Repair sales",
  "overview.pipeline.openConnection": "Connection status",

  "overview.trend.title": "Received sales, last 14 business days",
  "overview.trend.view": "View",
  "overview.trend.chart": "Chart",
  "overview.trend.table": "Table",
  "overview.trend.summary":
    "Bars of received sales in {currency} for each business day. The table shows the same figures.",
  "overview.trend.colDay": "Business day",
  "overview.trend.colSales": "Received sales ({currency})",
  "overview.trend.colCount": "Transactions",
  "overview.trend.colState": "State",
  "overview.trend.empty": "No sales received on these days.",

  "overview.recent.title": "Latest sales",
  "overview.recent.all": "All sales",
  "overview.recent.needsStore": "Choose a store in the scope switcher to see its latest sales.",
  "overview.recent.none": "No sales received for this store in the last 31 business days.",
};
