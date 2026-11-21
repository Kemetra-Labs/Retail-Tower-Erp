import type { aiManagerSales as ar } from "../ar/aiManagerSales";
import type { MessagesOf } from "../types";

export const aiManagerSales: MessagesOf<typeof ar> = {
  // --- Panel ----------------------------------------------------------------------
  "aiManagerSales.title": "Ask about sales",
  "aiManagerSales.sub": "Read only. Answers from the sales the server has received, no guessing.",
  "aiManagerSales.controls.label": "Scope of the question",
  "aiManagerSales.stores.legend": "Stores",
  "aiManagerSales.stores.all": "All my stores",
  "aiManagerSales.currency.label": "Currency",
  "aiManagerSales.range.note":
    "Stores, period and currency come from these choices only. The longest period is 31 days.",
  "aiManagerSales.chips.legend": "Suggested questions",
  "aiManagerSales.question.label": "Or type your question",
  "aiManagerSales.question.hint":
    "Typing only picks a supported question. It never changes the stores or the period.",
  "aiManagerSales.ask": "Ask",
  "aiManagerSales.loading": "Preparing the answer…",
  "aiManagerSales.announce.answer": "The answer is ready.",
  "aiManagerSales.announce.noAnswer": "There is no answer. Read the message below the form.",
  "aiManagerSales.retry": "Retry",
  "aiManagerSales.crashed": "The assistant is paused for now. Sales reports work as usual.",

  // --- Chips (U-1; T-01 .. T-10, T-12) ---------------------------------------------
  "aiManagerSales.chip.T01": "How much did we sell?",
  "aiManagerSales.chip.T02": "Sales day by day",
  "aiManagerSales.chip.T03": "Voids and returns",
  "aiManagerSales.chip.T04": "Store ranking",
  "aiManagerSales.chip.T05": "Compare stores",
  "aiManagerSales.chip.T06": "How do we compare with the previous period?",
  "aiManagerSales.chip.T07": "What changed since last period?",
  "aiManagerSales.chip.T08": "Best day for each store",
  "aiManagerSales.chip.T09": "Average sale for each store",
  "aiManagerSales.chip.T10": "Why isn't this final?",
  "aiManagerSales.chip.T12": "Stores with no sales received",

  // --- Answer (U-3, U-4) -----------------------------------------------------------
  "aiManagerSales.ctx.scopeAll": "All your stores",
  "aiManagerSales.ctx.scopeStores": {
    one: "1 store",
    other: "{count} stores",
  },
  "aiManagerSales.ctx.scopeAnswer": {
    one: "1 store",
    other: "{count} stores",
  },
  "aiManagerSales.ctx.line.store":
    "Store: {scope} · Period: {period} · As of {asOf} · Received by the server only",
  "aiManagerSales.ctx.line.stores":
    "Stores: {scope} · Period: {period} · As of {asOf} · Received by the server only",
  "aiManagerSales.table.region": "Answer table",
  "aiManagerSales.table.caption": "The figures of the answer, each with a source",
  "aiManagerSales.cite.open": "Open source {n}",
  "aiManagerSales.figure.seeSource": "See the source",
  "aiManagerSales.col.store": "Store",
  "aiManagerSales.col.date": "Day",
  "aiManagerSales.col.receivedSales": "Received sales",
  "aiManagerSales.col.count": "Count",
  "aiManagerSales.col.share": "Share of all your stores",
  "aiManagerSales.col.rank": "Rank",
  "aiManagerSales.col.averageSale": "Average sale",
  "aiManagerSales.col.bestDay": "Best day",
  "aiManagerSales.col.baselineTotal": "Previous period",
  "aiManagerSales.col.deltaRatio": "Change ratio",
  "aiManagerSales.col.voids": "Voids",
  "aiManagerSales.col.returns": "Returns",
  "aiManagerSales.col.legacyRefunds": "Legacy refunds",
  "aiManagerSales.col.total": "Total",

  // --- Notices (U-5, U-5b) and declines (U-6) --------------------------------------
  "aiManagerSales.notices.label": "Notes on the figures",
  "aiManagerSales.notice.receivedOnly":
    "Figures cover only what the server has received; they are not a final total.",
  "aiManagerSales.notice.dayInProgress":
    "Today is still in progress: figures include only what reached the server by {time}. Sales still on cashier terminals are not counted yet; the figure may rise.",
  "aiManagerSales.notice.dayNotBegun": "Days that have not begun show «Not begun», never zero.",
  "aiManagerSales.notice.multiCurrency":
    "Each currency has its own line; currencies are never added together.",
  "aiManagerSales.notice.scopeRelativeRatio":
    "Share and rank are relative to all your stores, not only the selected ones.",
  "aiManagerSales.notice.controlsOnly":
    "Period and stores come from the controls above. This answer covers: {scope} · {period}.",
  "aiManagerSales.declines.label": "What can't be said",
  "aiManagerSales.decline.causal": "This shows which figures changed; the data can't tell why.",
  "aiManagerSales.decline.conclusive": "This figure can't be treated as final: {reason}",
  "aiManagerSales.reason.dayInProgress": "today's figures are still in progress and may rise.",
  "aiManagerSales.reason.receivedOnly": "figures cover only what the server has received.",
  "aiManagerSales.gaps.label": "What this answer does not include",
  "aiManagerSales.gap.g1": "There is no total for the selected stores alone.",
  "aiManagerSales.gap.g2": "There is no rank or share for the selected stores alone.",
  "aiManagerSales.gap.g3":
    "There is no computed difference for all stores, so each period's total is shown separately.",
  "aiManagerSales.gap.g4": "There is no average sale for all stores together.",
  "aiManagerSales.gap.g5": "Sales still on cashier terminals can't be counted here.",
  "aiManagerSales.gap.g6":
    "Voids and returns of the previous period come from the sales summary read.",
  "aiManagerSales.gap.g7": "Net sales, margin, profit and cost are not available.",

  // --- Sources (X-4) ---------------------------------------------------------------
  "aiManagerSales.sources.title": "Sources",
  "aiManagerSales.source.salesSummary": "Sales summary",
  "aiManagerSales.source.salesByStore": "Sales by store",

  // --- Refusals (U-6) --------------------------------------------------------------
  "aiManagerSales.refusal.finance":
    "Cost and profit data aren't available in Retail Tower yet, so margin or profit can't be calculated. You can view received sales and returns.",
  "aiManagerSales.refusal.forecast":
    "The assistant doesn't forecast. It shows only actual sales the server has received.",
  "aiManagerSales.refusal.write":
    "The assistant is read-only and takes no actions. Open the relevant screen to do this.",
  "aiManagerSales.refusal.unsupported":
    "This question isn't supported yet. Choose a suggested question.",

  // --- Unavailable (U-7, U-8) ------------------------------------------------------
  "aiManagerSales.unavailable.system": "The assistant is turned off. Sales reports work as usual.",
  "aiManagerSales.unavailable.generic":
    "The assistant isn't available right now. Contact the account owner.",
  "aiManagerSales.unavailable.genericOwner":
    "The assistant isn't available right now for your organization.",
  "aiManagerSales.unavailable.optOutOwner":
    "You turned this feature off for your organization; turn it back on in AI settings.",
  "aiManagerSales.unavailable.quotaOwner":
    "Your organization reached its question limit for this period.",

  // --- Errors and clarifications (U-10, U-11) --------------------------------------
  "aiManagerSales.error.generic": "Couldn't get the answer. No data changed.",
  "aiManagerSales.error.session": "Your session has expired. Sign in again.",
  "aiManagerSales.error.rateLimited": "Too many requests in a short time.",
  "aiManagerSales.error.rateLimitedHint": "Wait a moment, then retry. No data changed.",
  "aiManagerSales.error.currency": "Enter a three-letter currency code, such as EGP.",
  "aiManagerSales.error.noStore": "Choose at least one store.",
  "aiManagerSales.error.noChoice": "Choose a suggested question or type your own.",
  "aiManagerSales.error.questionTooLong": "The question is longer than 500 characters. Shorten it.",
  "aiManagerSales.clarify.range": "The period is longer than 31 days; choose a shorter one.",
  "aiManagerSales.clarify.scopeTooLarge":
    "Your scope has more than 500 stores, which this report doesn't support; choose one store.",
  "aiManagerSales.clarify.invalid":
    "The choices weren't accepted. Check the stores, dates and currency.",
  "aiManagerSales.denied": "No answer can be shown for this selection.",
  "aiManagerSales.deniedHint": "Choose from the stores available to you, then ask again.",
};
