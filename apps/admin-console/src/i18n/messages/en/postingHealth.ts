import type { postingHealth as ar } from "../ar/postingHealth";
import type { MessagesOf } from "../types";

/** English copy for the posting-health report. */
export const postingHealth: MessagesOf<typeof ar> = {
  // --- Band ---------------------------------------------------------------
  "postingHealth.band.subStore": "{store} · {tenant}",
  "postingHealth.band.subScope": "All stores in scope · {tenant}",
  "postingHealth.band.subTenant": "{tenant}",

  // --- Loading and failure ------------------------------------------------
  "postingHealth.loading": "Loading the report…",
  "postingHealth.failed": "The report could not be loaded.",
  "postingHealth.retry": "Retry",
  "postingHealth.rateLimited": "Too many requests. Try again when the wait ends.",
  "postingHealth.rateLimitedHint": "The banner at the top of the page shows the time left.",

  // --- Table ---------------------------------------------------------------
  "postingHealth.table.caption": "Posting by day",
  "postingHealth.table.hint":
    "Received sales posted, stuck, permanently rejected, and with no posting row — for each business day. “Unknown” never means “not posted”.",
  "postingHealth.summary.days": "Completed days fully posted: {fully} of {total}.",
  "postingHealth.summary.failures": "Completed days with failed postings: {days}.",
  "postingHealth.col.day": "Day",
  "postingHealth.col.posted": "Posted",
  "postingHealth.col.pending": "Pending",
  "postingHealth.col.failed": "Failed",
  "postingHealth.col.unknown": "No row",
  "postingHealth.col.verdict": "Verdict",
  "postingHealth.row.total": "Total",
  "postingHealth.row.totalSoFar": "Total so far",
  "postingHealth.repairHint": "Individual failed sales are listed in the repair queue:",

  // --- Day verdicts --------------------------------------------------------
  "postingHealth.verdict.fullyPosted": "Fully posted",
  "postingHealth.verdict.needsAttention": "Needs attention",
  "postingHealth.verdict.unknownRows": "No posting rows",
  "postingHealth.verdict.noSales": "No sales",
  "postingHealth.verdict.noData": "Unknown",
  "postingHealth.verdict.running": "Running",
  "postingHealth.verdict.notBegun": "Not begun",
};
