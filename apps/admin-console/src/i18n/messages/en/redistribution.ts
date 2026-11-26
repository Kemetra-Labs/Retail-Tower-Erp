import type { redistribution as ar } from "../ar/redistribution";
import type { MessagesOf } from "../types";

export const redistribution: MessagesOf<typeof ar> = {
  "redistribution.nav.label": "Stock redistribution",
  "redistribution.title": "Stock redistribution proposals",
  "redistribution.sub":
    "Proposals to move quantities from a store with surplus to a store below its reorder level, newest first.",
  "redistribution.note.advice":
    "A proposal is advice only: it changes no stock and reserves nothing. Accepting creates transfers in draft; they are approved and dispatched on the Transfers screen.",
  "redistribution.scopePrompt": "Choose an organization to see redistribution proposals.",
  "redistribution.notAvailable":
    "Redistribution proposals are not available for this organization.",
  "redistribution.back": "Redistribution proposals",

  "redistribution.compute.action": "Compute a new proposal",
  "redistribution.compute.nothing":
    "No store needs stock moved right now. No new proposal was stored.",
  "redistribution.compute.nothingReplaced":
    "No store needs stock moved right now. No new proposal was stored, and the previous open proposal ended because a newer compute replaced it.",

  "redistribution.list.caption": "Redistribution proposals",
  "redistribution.list.label": "proposals",
  "redistribution.list.col.created": "Created",
  "redistribution.list.col.state": "State",
  "redistribution.list.col.objective": "Shortfall and size",
  "redistribution.list.col.excluded": "Excluded stores",
  "redistribution.list.col.warnings": "Warnings",
  "redistribution.list.col.actions": "Actions",
  "redistribution.list.open": "Open",
  "redistribution.list.openLabel": "Open the proposal of {time}",
  "redistribution.list.empty": "No proposals yet.",
  "redistribution.list.emptyHint":
    "Compute a proposal to see the quantities the system suggests moving between stores.",
  "redistribution.list.more": "Show older proposals",

  "redistribution.state.open": "Open",
  "redistribution.state.reviewed": "Under review",
  "redistribution.state.partially_accepted": "Partially accepted",
  "redistribution.state.accepted": "Accepted",
  "redistribution.state.rejected": "Rejected",
  "redistribution.state.expired": "Expired",
  "redistribution.state.superseded": "Replaced by a newer proposal",
  "redistribution.state.unknown": "Unknown state",

  "redistribution.objective.before": "Shortfall before",
  "redistribution.objective.after": "Shortfall after",
  "redistribution.objective.pairs": "Store pairs",
  "redistribution.objective.lines": "Lines",

  "redistribution.detail.title": "Redistribution proposal",
  "redistribution.detail.computedAt": "Computed",
  "redistribution.detail.expiresAt": "Expires",
  "redistribution.detail.rejectReason": "Reason for rejection: {reason}",
  "redistribution.phase.shadow":
    'Trial phase: mark each line "Would accept" or "Would reject". No transfer is created in this phase.',
  "redistribution.phase.live":
    "Live phase: the lines you accept become transfers in draft. No transfer is approved or dispatched here.",

  "redistribution.lines.title": "Proposed lines",
  "redistribution.lines.caption": "Proposed lines",
  "redistribution.lines.col.select": "Select for accept",
  "redistribution.lines.col.product": "Product",
  "redistribution.lines.col.route": "From → to",
  "redistribution.lines.col.quantity": "Quantity",
  "redistribution.lines.col.warnings": "Warnings",
  "redistribution.lines.col.review": "Review",
  "redistribution.lines.col.outcome": "Accept result",
  "redistribution.lines.route": "From {source} to {destination}",
  "redistribution.lines.rowLabel": "Review the {product} line",
  "redistribution.lines.select": "Select the {product} line for accept",

  "redistribution.review.wouldAccept": "Would accept",
  "redistribution.review.wouldReject": "Would reject",
  "redistribution.review.none": "Not reviewed",
  "redistribution.review.done": "Review recorded.",

  "redistribution.outcome.created": "Created in draft",
  "redistribution.outcome.reduced": "Created with less",
  "redistribution.outcome.dropped": "Not created",
  "redistribution.outcome.unknown": "Unknown result",
  "redistribution.outcome.quantity": "Quantity in draft:",

  "redistribution.reason.source_not_fresh": "The source store's data is no longer current.",
  "redistribution.reason.source_available_insufficient":
    "The source store no longer has enough available after open transfers.",
  "redistribution.reason.destination_gap_closed":
    "The receiving store no longer needs this quantity.",
  "redistribution.reason.product_not_sellable":
    "The product is no longer sellable at one of the stores.",
  "redistribution.reason.stocking_unit_changed": "The product's stocking unit changed.",
  "redistribution.reason.transfer_rule_refused": "A transfer rule does not allow this line.",
  "redistribution.reason.unknown": "Unknown reason.",

  "redistribution.stores.title": "Stores read",
  "redistribution.stores.caption": "Stores and when their stock was read",
  "redistribution.stores.col.store": "Store",
  "redistribution.stores.col.readAt": "Read at",
  "redistribution.stores.col.source": "Can give stock",
  "redistribution.stores.eligible": "Yes",
  "redistribution.stores.notEligible": "No",

  "redistribution.exclusion.pos_queue_unknown": "POS sale queue state unknown",
  "redistribution.exclusion.pos_queue_dead_letter_or_held": "Stuck or held sales on a POS",
  "redistribution.exclusion.device_heartbeat_stale": "A POS has not checked in recently",
  "redistribution.exclusion.inactive": "Store is inactive",
  "redistribution.exclusion.unknown": "Excluded for an unknown reason",

  "redistribution.warnings.title": "Compute warnings",
  "redistribution.warnings.none": "No warnings.",
  "redistribution.warnings.count": { one: "1 product", other: "{count} products" },
  "redistribution.warning.store_excluded_as_source": "Store excluded as a source",
  "redistribution.warning.negative_available_to_sell": "Negative available to sell",
  "redistribution.warning.reorder_level_missing": "Reorder level not set",
  "redistribution.warning.tracked_product_skipped": "Tracked product left out",
  "redistribution.warning.stocking_unit_mismatch": "Stocking unit mismatch",
  "redistribution.warning.source_near_reorder_level": "Source close to its reorder level",
  "redistribution.warning.unknown": "Unknown warning",

  "redistribution.accept.openNone": "Accept selected lines",
  "redistribution.accept.open": {
    one: "Accept 1 selected line",
    other: "Accept {count} selected lines",
  },
  "redistribution.accept.title": "Accept lines into draft transfers",
  "redistribution.accept.consequence": {
    zero: "No line is selected.",
    one: "The selected line becomes a transfer in draft. Nothing is approved, dispatched or reserved.",
    other:
      "{count} selected lines become transfers in draft. Nothing is approved, dispatched or reserved.",
  },
  "redistribution.accept.recheck":
    "Each line is checked again against current stock, so it may be created with less or not at all, with the reason.",
  "redistribution.accept.commit": {
    zero: "Confirm accept",
    one: "Confirm accepting 1 line",
    other: "Confirm accepting {count} lines",
  },
  "redistribution.accept.done": "Transfers created in draft.",
  "redistribution.accept.resultCounts":
    "Created in full: {created} · Created with less: {reduced} · Not created: {dropped}",
  "redistribution.accept.resultTransfers":
    "Transfers created in draft (approve them on the Transfers screen):",
  "redistribution.transfer.openLabel": "Open the Transfers screen for transfer {id}",

  "redistribution.reject.open": "Reject proposal",
  "redistribution.reject.title": "Reject the proposal",
  "redistribution.reject.consequence":
    "The proposal ends and no further line can be accepted. Lines already accepted keep their draft transfers.",
  "redistribution.reject.reason": "Reason for rejection",
  "redistribution.reject.reasonHint": "Required, up to {max} characters.",
  "redistribution.reject.commit": "Confirm rejecting the proposal",
  "redistribution.reject.done": "Proposal rejected.",

  "redistribution.dialog.cancel": "Cancel",
  "redistribution.dialog.done": "Done",

  "redistribution.error.validation": "The server refused the request data. Nothing was recorded.",
  "redistribution.error.session": "Your session ended. Sign in again.",
  "redistribution.error.origin":
    "The request was refused because it did not come from this screen. Reload the page and try again.",
  "redistribution.error.notAvailable": "This proposal or this action is not available.",
  "redistribution.error.superseded":
    "A newer proposal replaced this one. Nothing was recorded. Open the newest proposal.",
  "redistribution.error.expired":
    "This proposal has expired. Nothing was recorded. Compute a new one.",
  "redistribution.error.stateConflict":
    "This proposal already has a final decision. Nothing was recorded.",
  "redistribution.error.lineDecided":
    "A line already has an accept result. Nothing was recorded. The proposal was read again.",
  "redistribution.error.stale":
    "None of the selected lines is still valid against current stock. No transfer was created. Compute a new proposal.",
  "redistribution.error.tooLarge":
    "Too many stores or products for one proposal. Nothing was stored.",
  "redistribution.error.deadline":
    "The compute took longer than allowed. Nothing was stored. Try again later.",
  "redistribution.error.planInvalid":
    "The validation check refused the computed plan. Nothing was stored. Contact support with the reference.",
  "redistribution.error.uncertain":
    "No clear answer arrived, and the request may have been recorded. Retry now with the same button: it resends the same request.",
  "redistribution.error.rateLimited":
    "Too many requests in a short time. Nothing ran. Wait a moment, then retry.",
  "redistribution.error.generic": "The request could not be completed. Nothing was recorded.",
  "redistribution.error.loadFailed": "Redistribution proposals could not be loaded.",
};
