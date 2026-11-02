import type { postingRepair as ar } from "../ar/postingRepair";
import type { MessagesOf } from "../types";

/** English copy for the sale detail's ERPNext posting-failure banner and repair (RT-1072, RT-977 §7). */
export const postingRepair: MessagesOf<typeof ar> = {
  // --- Cause, by rejectionCategory (an open set: unknown or null → `other`) -----
  "postingRepair.cause.unmappedItem": "An item in this sale has no confirmed ERPNext item mapping.",
  "postingRepair.cause.unmappedStore": "This store has no active ERPNext warehouse mapping.",
  "postingRepair.cause.unmappedAccount": "ERPNext reported a missing account mapping.",
  "postingRepair.cause.validation": "ERPNext refused the document as invalid.",
  "postingRepair.cause.closedPeriod":
    "ERPNext refused the document: its accounting period is closed.",
  "postingRepair.cause.retryBudgetExhausted": "Posting stopped after repeated temporary failures.",
  "postingRepair.cause.reconciliationRequired":
    "ERPNext already has a document for this sale that does not match. Fix it in ERPNext; Retail Tower will not post it again.",
  "postingRepair.cause.reconciliationRequiredWithDocument":
    "ERPNext already has a document for this sale ({doctype} {name}) that does not match. Fix it in ERPNext; Retail Tower will not post it again.",
  "postingRepair.cause.other": "ERPNext refused the document.",

  // --- Safety ---------------------------------------------------------------------
  "postingRepair.safety": "The sale stays recorded in Retail Tower. Repair does not change it.",

  // --- Action ---------------------------------------------------------------------
  "postingRepair.action.categoryOnly": "An owner or a tenant admin can repair this posting.",
  "postingRepair.action.send": "Send to ERPNext again",
  "postingRepair.action.mappingHint": "Fix the mapping first, then send again.",
  "postingRepair.changed": "This posting changed. Refresh to see its state.",

  // --- Evidence -------------------------------------------------------------------
  "postingRepair.evidence.stoppedAt": "Stopped at {time}.",
  "postingRepair.evidence.reason": "Message from ERPNext: {reason}",

  // --- Confirmation ---------------------------------------------------------------
  "postingRepair.confirm.label": "Confirm sending to ERPNext again",
  "postingRepair.confirm.sale":
    "Send this sale to ERPNext again? Retail Tower checks the cause again. If it is fixed, ERPNext receives the sale once; it is never posted twice.",
  "postingRepair.confirm.reversal":
    "Send the void reversal of this sale to ERPNext again? Retail Tower checks the cause again. If it is fixed, ERPNext receives the reversal once; it is never posted twice.",
  "postingRepair.confirm.submit": "Send again",
  "postingRepair.sending": "Sending…",

  // --- Outcome (keyed on RecordedRepair.outcome, never on 200 vs 201) -------------
  "postingRepair.outcome.eligibleAgain": "Sent again. The ERPNext posting is pending.",
  "postingRepair.outcome.stillFailing":
    "Nothing was sent. The cause is still there; fix it, then try again.",
  "postingRepair.outcome.alreadyPosted":
    "Already posted to ERPNext as {ref}. Nothing was sent again.",
  "postingRepair.outcome.alreadySent":
    "Already sent again and waiting for ERPNext. Nothing changed.",
  "postingRepair.outcome.notFound":
    "This posting can no longer be repaired here. Refresh the sale.",
  "postingRepair.outcome.keyConflict":
    "The server refused the request because it does not match an earlier request with the same key. Nothing changed; you can try again.",
  "postingRepair.outcome.originRejected":
    "The request was refused. Reload the page, then try again.",
  "postingRepair.outcome.forbidden": "Your role cannot repair this posting. Nothing changed.",
  "postingRepair.outcome.session": "Your session has ended. Sign in again.",
  "postingRepair.outcome.rejected": "The server rejected the request. Nothing changed.",
  "postingRepair.outcome.rateLimited":
    "Too many requests in a short time. Nothing was sent; wait, then try again.",
  "postingRepair.outcome.unconfirmed": "We could not confirm the result. Try again.",
  "postingRepair.retry": "Try again",
};
