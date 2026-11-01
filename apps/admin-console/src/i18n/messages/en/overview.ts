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

  "overview.greeting": "Welcome, {name}",

  "overview.kpi.label": "Today so far",
  "overview.kpi.transactions": "Transactions",
  "overview.kpi.context": "{scope} · Today so far · {date} · As of {asOf}",
  "overview.kpi.scopeAll": "All stores",
  "overview.kpi.compareNote": "Today so far is compared with the previous business day in full.",
  "overview.kpi.up": "Higher than the previous business day in full ({value})",
  "overview.kpi.down": "Lower than the previous business day in full ({value})",
  "overview.kpi.same": "Same as the previous business day in full ({value})",
  "overview.kpi.previousUnknown": "Previous business day: not available",
  "overview.kpi.mixed":
    "Stores are on different business days, so the scope has no single today. Choose a store, or open daily sales.",
  "overview.kpi.none": "No stores in scope.",
  "overview.kpi.sparkPeriod": "Last 14 business days",
  "overview.kpi.sparkSummary":
    "Received sales in {currency} over the last 14 business days; gaps are days the read lacks.",

  "overview.pipeline.links": "Sale pipeline screens",
  "overview.pipeline.devices": "Trusted devices: {count}",
  "overview.pipeline.devicesAtLeast": "Trusted devices: {count} or more",
  "overview.pipeline.posNote": "Last activity isn't recorded, so connectivity isn't shown.",
  "overview.pipeline.received": "Today's sales: {count}",
  "overview.pipeline.posted": "Posted: {posted} of {received}",
  "overview.pipeline.openDevices": "View devices",
  "overview.pipeline.openSales": "View sales",
  "overview.pipeline.openRepair": "Repair sales",
  "overview.pipeline.openConnection": "Connection status",

  "overview.trend.title": "Received sales: this period against the previous one",
  "overview.trend.question":
    "Are this period's daily sales above or below the same days of the period before?",
  "overview.trend.period": "Period",
  "overview.trend.days7": "7 days",
  "overview.trend.days14": "14 days",
  "overview.trend.view": "View",
  "overview.trend.chart": "Chart",
  "overview.trend.table": "Table",
  "overview.trend.summary":
    "Lines of received sales in {currency}: the last {days} business days, solid, and the {days} before them, dashed. Gaps are days the read lacks. The table shows the same figures.",
  "overview.trend.current": "This period",
  "overview.trend.previous": "Previous period",
  "overview.trend.difference": "Difference: {value}",
  "overview.trend.colDay": "Business day",
  "overview.trend.colSales": "Received sales ({currency})",
  "overview.trend.colPreviousDay": "Same day, previous period",
  "overview.trend.colPrevious": "Previous period ({currency})",
  "overview.trend.colDifference": "Difference",
  "overview.trend.colState": "State",
  "overview.trend.empty": "No sales received on these days.",

  "overview.posting.title": "Today's sales in ERPNext",
  "overview.posting.question": "Of today's received sales, how many has ERPNext posted?",
  "overview.posting.summary":
    "Ring of today's {received} received sales by ERPNext posting state. The table beside it shows each count and share.",
  "overview.posting.caption": "Share of today's {received} received sales",
  "overview.posting.colState": "State",
  "overview.posting.colCount": "Count",
  "overview.posting.colShare": "Share",
  "overview.posting.center": "Received today",
  "overview.posting.none": "No sales received today yet.",

  "overview.recent.title": "Latest sales",
  "overview.recent.all": "All sales",
  "overview.recent.needsStore": "Choose a store in the scope switcher to see its latest sales.",
  "overview.recent.none": "No sales received for this store in the last 31 business days.",

  // --- Overview v4 side column (RT-993) ----------------------------------------
  "overview.side.label": "Overview side column",
  "overview.quick.title": "Quick actions",
  "overview.quick.salesDaily": "Daily received sales",
  "overview.quick.salesDailyNote": "Each business day's received sales, by store and currency.",
  "overview.quick.repair": "Sales needing repair",
  "overview.quick.repairNote": "Sales the server couldn't process, to retry or repair.",
  "overview.quick.catalog": "Tenant catalog",
  "overview.quick.catalogNote": "The catalog's products, prices and barcodes.",
  "overview.quick.operators": "Users",
  "overview.quick.operatorsNote": "This organisation's members and their roles.",
  "overview.soon": "Coming soon",
  "overview.stores.title": "Stores today",
  "overview.stores.soon":
    "Each store's share of today's sales will appear here once the server provides it.",
  "overview.lowStock.title": "Low stock",
  "overview.lowStock.soon":
    "Items below their reorder level, sorted by severity, will appear here once the server provides them.",
};
