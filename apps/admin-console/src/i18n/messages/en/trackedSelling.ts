import type { trackedSelling as ar } from "../ar/trackedSelling";
import type { MessagesOf } from "../types";

/** English copy for the tenant's tracked-selling switch (RT-455 part 1). */
export const trackedSelling: MessagesOf<typeof ar> = {
  "trackedSelling.title": "Batch selling",
  "trackedSelling.sub.manage":
    "Whether the points of sale in every store of this tenant ask for the batch of a tracked product. Switching off is always possible; switching on needs the conditions below.",
  "trackedSelling.sub.status": "View only. The tenant owner or admin changes it.",
  "trackedSelling.loadingNoun": "Batch selling setting",
  "trackedSelling.loadFailed": "The batch selling setting could not be loaded.",
  "trackedSelling.sessionExpired": "Your session has ended. Sign in again.",
  "trackedSelling.retry": "Try again",

  "trackedSelling.field.state": "State",
  "trackedSelling.field.changed": "Last change",
  "trackedSelling.state.on": "On",
  "trackedSelling.state.off": "Off",
  "trackedSelling.changed.never": "Not changed since the tenant was created.",
  "trackedSelling.changed.at": "{at}, by",

  "trackedSelling.preconditions.title": "Conditions for switching on",
  "trackedSelling.preconditions.unmet": "Not met now:",
  "trackedSelling.preconditions.allMet": "Every condition for switching on is met now.",
  "trackedSelling.preconditions.failClosed":
    "A condition the server cannot confirm counts as not met.",
  "trackedSelling.precondition.sale_effects_active":
    "Sales, voids and returns update inventory for this tenant.",
  "trackedSelling.precondition.status_moves_available":
    "Stock status moves and return inspection are available.",
  "trackedSelling.precondition.erp_tracking_import":
    "Stock import from ERPNext with batches works, so new batches are recorded.",
  "trackedSelling.precondition.erp_batch_posting_verified":
    "Posting batch lines to ERPNext with the batch number is verified.",
  "trackedSelling.precondition.identity_anchor": "Each batch's starting balance is set.",
  "trackedSelling.precondition.tracking_grain_reconciliation":
    "Batch-level stock reconciliation is available.",
  "trackedSelling.precondition.unknown": "Unknown condition:",

  "trackedSelling.warning.title": "Batch selling is on, but one or more conditions no longer hold.",
  "trackedSelling.warning.body":
    "It stays on and never switches itself off. Review the conditions below, or switch it off if needed.",

  "trackedSelling.turnOn": "Switch batch selling on",
  "trackedSelling.turnOff": "Switch batch selling off",
  "trackedSelling.confirm.label": "Confirm switching batch selling off",
  "trackedSelling.confirm.body":
    "Switch batch selling off in every store of this tenant? The points of sale stop asking for the batch, and Holds and recalls is hidden. Nothing is deleted: holds, recalls and recorded tracking stay. Switching back on needs the conditions to hold again.",
  "trackedSelling.confirm.yes": "Confirm switching off",
  "trackedSelling.confirm.cancel": "Cancel",

  "trackedSelling.saved.on": "Batch selling is switched on.",
  "trackedSelling.saved.off": "Batch selling is switched off.",
  "trackedSelling.unmet":
    "Batch selling was not switched on: at least one condition is not met now. Nothing was recorded, and the conditions below were read again from the server.",
  "trackedSelling.unavailable":
    "The batch selling setting is not available now. Nothing was recorded.",
  "trackedSelling.forbidden": "Your role cannot change this setting. Nothing was recorded.",
  "trackedSelling.rateLimited": "Too many requests in a short time. Wait a moment, then try again.",
  "trackedSelling.rateLimitedFor": {
    one: "Too many requests in a short time. Try again in {count} second.",
    other: "Too many requests in a short time. Try again in {count} seconds.",
  },
  "trackedSelling.rejected":
    "The server refused the command (status {status}). Nothing was recorded.",
  "trackedSelling.code": "Code: {code}",
  "trackedSelling.failed":
    "No answer arrived, so whether the setting changed is unknown. The state below was read again from the server, and repeating the command is safe.",

  "trackedSelling.pagesOff.title": "Holds and recalls is not available for this tenant now.",
  "trackedSelling.pagesOff.body": "It shows while batch selling is switched on for the tenant.",
  "trackedSelling.pagesFailed":
    "Whether batch selling is on could not be confirmed, so Holds and recalls is not shown.",
};
