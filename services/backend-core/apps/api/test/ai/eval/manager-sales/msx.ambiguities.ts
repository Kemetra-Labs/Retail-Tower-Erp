/**
 * RT-1540 — where RT-1526 v6 section 6 (or the P-05 contract) does not fix a
 * case's expected outcome, the dataset encodes what the text says and lists the
 * interpretation here for the reviewer, instead of inventing a rule.
 */
export const MSX_AMBIGUITIES: readonly string[] = [
  "Cases 1, 3, 6, 7 and 38 (\"this week\", \"month\"): encoded with completed past ranges (7 and 31 days) so only the section 6 notices apply. A range that includes today would also carry `day_in_progress` (section 4.3).",
  "Cases 8 to 17, 21, 22, 30 and 37: the by-store reads need a ranking currency, but section 6 lists none for question-only requests. The request carries the panel's currency control (M-2), as the contract's open item leaves a missing currency undefined.",
  "Cases 8, 9, 15, 21, 22 and 37: how a store with no sales in the ranking currency renders is not fixed. It is shown with its name and a zero count only, with no rank, total or share.",
  "Case 12: the by-store read and the baseline summary read both return per-currency scope totals. Only the ranking currency (EGP) line is shown; no difference is computed (gap G-3).",
  "Case 13: the facts table lists stores in ascending `deltaRatio` order (sorting only) and omits A3, which has no EGP sales; baseline voids and returns come from a summary read (gap G-6).",
  "Case 29: \"OA · all\" with A1 (EGP) and A3 (SAR) is encoded as those two selected stores, so the answer is per store with no subset total (gap G-1) and `multi_currency`.",
  "Case 31: a range containing today and later days carries both `day_in_progress` (to is not before the current business date, section 4.3) and `day_not_begun`; section 6 lists only the latter. Not-begun days are rows with a `dayState` figure, because the contract leaves a state marker on a zero or missing cell open.",
  "Case 37: where the bidi controls are stripped (server or client) is not fixed. The expected body carries the stripped name; the pack keeps the raw one.",
  "Cases 18, 19 and 36: section 6 expected a 200 `unavailable` (`store_out_of_scope`) and `not_authorized`; the owner decision RT-1538 comment 18048 makes all three the non-disclosing 404.",
  "Cases 20 and 35: both are deliberate validation failures (400 `validation_error`). Case 20 fails the request schema (unknown key `tenant_id`); case 35 passes the schema and fails the prose 31-day rule.",
  "Cases 23 to 28 and 32 to 36: section 6 gives no controls, so the request uses an explicit range (MONTH for refusals that name a month, WEEK otherwise), `storeIds` empty for the owner and the manager's own stores for MA (X-3).",
  "Cases 33 and 34 give no question text; a neutral Arabic question stands in. The contract places the kill switch and opt-out before the intent match, so the text does not matter.",
  "Ledger `task_class` and the citation `fieldPath` strings are fixture placeholders: the contract types them but does not fix their value domains (its open items).",
];
