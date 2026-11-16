import type { counts as ar } from "../ar/counts";
import type { MessagesOf } from "../types";

export const counts: MessagesOf<typeof ar> = {
  "counts.value.unknown": "Unknown",
  "counts.value.none": "—",
  "counts.optional": "(optional)",
  "counts.scopePrompt": "Choose a tenant from the scope bar to see stock counts.",

  // --- Pages -------------------------------------------------------------------
  "counts.title": "Stock counts",
  "counts.back": "Store inventory",
  "counts.store.sub": "Count sessions of this store.",
  "counts.store.notFound":
    "Stock counts are not enabled for this tenant, or this store is not available to you.",
  "counts.note.blind":
    "Counting is blind: expected quantities appear only after the count is submitted for review.",
  "counts.note.deskGuard":
    "Record counts here only. Do not adjust stock yourself in ERPNext while a count session is open.",

  // --- Sessions list -----------------------------------------------------------
  "counts.list.title": "Count sessions",
  "counts.list.caption": "The store's count sessions, newest first",
  "counts.list.col.opened": "Opened",
  "counts.list.col.state": "Status",
  "counts.list.col.products": "Products",
  "counts.list.col.openedBy": "Opened by",
  "counts.list.col.findings": "Late findings",
  "counts.list.open": "Open the count session started at {when}",
  "counts.list.filter": "Filter by status",
  "counts.list.filter.all": "All statuses",
  "counts.list.loadingNoun": "count sessions",
  "counts.list.loadFailed": "Count sessions could not be loaded.",
  "counts.list.empty": "No count sessions in this store yet. Open one to start counting.",
  "counts.list.emptyFiltered": "No sessions with this status.",
  "counts.list.loadMore": "Load older sessions",

  // --- Open a count --------------------------------------------------------------
  "counts.open.title": "Open a count session",
  "counts.open.sub":
    "Choose the products to count. Each product is counted whole, across every location and status of the store.",
  "counts.open.search": "Search a product by name or code",
  "counts.open.searchAction": "Search",
  "counts.open.searchFailed": "The catalog search failed. Try again.",
  "counts.open.loadingNoun": "products",
  "counts.open.noProducts": "No matching products.",
  "counts.open.results": "Search results",
  "counts.open.tracked": "Batch or serial",
  "counts.open.selected": {
    one: "1 product chosen.",
    other: "{count} products chosen.",
  },
  "counts.open.error.empty": "Choose at least one product.",
  "counts.open.note": "Note",
  "counts.open.submit": "Open count session",
  "counts.open.failed": "The count session was not opened",

  // --- Session ---------------------------------------------------------------------
  "counts.session.title": "Count session",
  "counts.session.back": "All count sessions",
  "counts.session.loadingNoun": "the count session",
  "counts.session.loadFailed": "The count session could not be loaded.",
  "counts.session.notFound":
    "Stock counts are not enabled for this tenant, or this count session is not available.",

  "counts.state.open": "Open",
  "counts.state.cut_taken": "Cut taken",
  "counts.state.submitted": "Awaiting approval",
  "counts.state.approved": "Approved",
  "counts.state.posting": "Posting",
  "counts.state.confirmed": "Confirmed by ERPNext",
  "counts.state.needs_attention": "Needs attention",
  "counts.state.closed": "Closed",
  "counts.state.cancelled": "Cancelled",

  // --- Status and facts -------------------------------------------------------------
  "counts.status.title": "Status",
  "counts.erp.title": "ERPNext status",
  "counts.erp.posting":
    "The approved count is being posted to ERPNext. ERPNext has not confirmed the result yet.",
  "counts.erp.confirmed": "ERPNext confirmed the result of this count.",
  "counts.erp.needs_attention":
    "The approved count needs attention: the posting was rejected or could not be confirmed, or a late event appeared after approval. No ERPNext document is cancelled to hide a mismatch.",
  "counts.selfApproved.title": "Self-approved",
  "counts.selfApproved.message":
    "This session was approved by someone who took part in counting or submitting it, under the tenant owner's documented exception. It is marked in review and audit.",
  "counts.policy.strict": "Approved by another person",
  "counts.policy.exception": "Small-shop exception",
  "counts.fact.opened": "Opened",
  "counts.fact.cut": "Count Cut",
  "counts.fact.submitted": "Submitted for review",
  "counts.fact.approved": "Approved",
  "counts.fact.cancelled": "Cancelled",
  "counts.fact.note": "Note",
  "counts.fact.products": "Products",
  "counts.fact.findings": "Late event findings",

  // --- Capture -------------------------------------------------------------------------
  "counts.capture.title": "Counting",
  "counts.capture.sub":
    "Record what is on the shelf at each location and status. Expected quantities are not shown here, so they cannot influence the count.",
  "counts.capture.product": "Product",
  "counts.capture.location": "Stock location",
  "counts.capture.status": "Status",
  "counts.capture.quantity": "Counted quantity",
  "counts.capture.unit": "Counted unit",
  "counts.capture.choose": "Choose…",
  "counts.capture.submit": "Record count",
  "counts.capture.saved": "Count recorded.",
  "counts.capture.failed": "The count was not recorded",
  "counts.capture.locationsFailed": "Stock locations could not be loaded. Reload the page.",
  "counts.capture.error.product": "Choose the product.",
  "counts.capture.error.location": "Choose the stock location.",
  "counts.capture.error.quantity": "Enter a quantity of zero or more, with at most four decimals.",
  "counts.capture.error.unit": "Enter the unit you counted in (up to 32 characters).",
  "counts.capture.recorded": "Recorded in this visit",
  "counts.capture.recordedEmpty": "Nothing recorded in this visit yet.",
  "counts.capture.coverage": "Coverage",
  "counts.capture.covered": "Count recorded",
  "counts.capture.notCovered": "No count recorded",
  "counts.capture.coverageNote":
    "This list shows only what you recorded in this visit. The server checks every product when you submit and refuses the submit if a product has no count.",

  // --- Commands ------------------------------------------------------------------------
  "counts.actions.title": "Actions",
  "counts.cut.title": "Count Cut",
  "counts.cut.sub":
    "The Count Cut freezes the expected quantity of every product. It can only be taken once every POS device of the store has synced and the ERPNext import has caught up.",
  "counts.cut.action": "Take the Count Cut",
  "counts.cut.failed": "The Count Cut was not taken",
  "counts.submit.title": "Submit for review",
  "counts.submit.sub":
    "After submitting, expected quantities and variances appear. You can send chosen products back for a recount before approval.",
  "counts.submit.action": "Submit for review",
  "counts.submit.failed": "The count was not submitted",
  "counts.cancel.start": "Cancel this count session",
  "counts.cancel.title": "Cancel this count session",
  "counts.cancel.consequence":
    "Recorded counts and the audit trail are kept and no quantity changes. A cancelled session cannot be reopened.",
  "counts.cancel.reason": "Reason for cancelling",
  "counts.cancel.error.reason": "Write the reason for cancelling.",
  "counts.cancel.confirm": "Confirm cancel",
  "counts.cancel.keep": "Keep the session",
  "counts.cancel.failed": "The count session was not cancelled",

  // --- Review ----------------------------------------------------------------------------
  "counts.review.title": "Variance review",
  "counts.review.sub":
    "Variance is counted minus expected at the cut. Figures are as the server sent them.",
  "counts.review.caption": "Count variances by product",
  "counts.review.col.product": "Product",
  "counts.review.col.expected": "Expected at the cut",
  "counts.review.col.counted": "Counted",
  "counts.review.col.variance": "Variance",
  "counts.review.col.flags": "Flags",
  "counts.review.col.actions": "Action",
  "counts.review.loadingNoun": "variances",
  "counts.review.loadFailed": "Variances could not be loaded.",
  "counts.review.empty": "There are no lines to review.",
  "counts.review.acknowledge": "I reviewed this line",
  "counts.review.acknowledgeLine": "Confirm review of {product}",
  "counts.review.acknowledged": "Reviewed",
  "counts.review.cannotPost": "Will not post",
  "counts.review.recount": "Recount",
  "counts.review.recountLine": "Recount {product}",
  "counts.flag.divergence": "Differs from ERPNext",
  "counts.flag.stale_snapshot": "Stale ERPNext snapshot",
  "counts.flag.pending": "Movements still posting",
  "counts.flag.unmapped": "Not mapped to ERPNext",
  "counts.flag.uom_mismatch": "Different unit",
  "counts.refusal.count_up_without_valuation_history":
    "An increase cannot be posted for a product with no earlier stock or valuation in ERPNext. A receipt or valuation is needed first. The rest of the session proceeds.",
  "counts.refusal.count_line_unmapped":
    "This product is not mapped to an ERPNext item, so it cannot be posted. The rest of the session proceeds.",
  "counts.refusal.count_line_uom_mismatch":
    "The counted unit differs from the stocking unit, so it cannot be posted. The rest of the session proceeds.",

  // --- Approval and recount --------------------------------------------------------------
  "counts.approve.action": "Approve the count",
  "counts.approve.failed": "The count was not approved",
  "counts.approve.loadingLines": "Loading every line before approval…",
  "counts.approve.pending": {
    zero: "Every flagged line is reviewed. You can approve.",
    one: "1 flagged line is not reviewed yet.",
    other: "{count} flagged lines are not reviewed yet.",
  },
  "counts.approve.tookPart":
    "You took part in counting or submitting this session. The server requires someone else to approve it, unless the tenant owner enabled the small-shop exception. The server decides.",
  "counts.recount.reason": "Reason for the recount",
  "counts.recount.error.reason": "Write the reason for the recount.",
  "counts.recount.action": {
    zero: "Send back for a recount",
    one: "Recount 1 product",
    other: "Recount {count} products",
  },

  // --- Late events -------------------------------------------------------------------------
  "counts.late.title": "Late pre-cut events",
  "counts.late.sub":
    "A sale or ERPNext document dated before the Count Cut that arrived after it. No stock movement is made automatically, and there is no action to resolve a finding here.",
  "counts.late.caption": "Late event findings, oldest first",
  "counts.late.col.product": "Product",
  "counts.late.col.assessment": "Effect on availability",
  "counts.late.col.quantity": "Quantity",
  "counts.late.col.risk": "Oversell risk",
  "counts.late.col.event": "Event",
  "counts.late.col.detected": "Detected",
  "counts.late.understated": "The count understates availability",
  "counts.late.overstated": "The count overstates availability",
  "counts.late.oversell": "Oversell risk",
  "counts.late.noOversell": "No risk",
  "counts.late.loadingNoun": "findings",
  "counts.late.loadFailed": "Late event findings could not be loaded.",
  "counts.late.empty": "No findings.",
  "counts.late.loadMore": "Load more findings",

  "counts.cut.devices": "POS devices blocking the cut",
  "counts.cut.warehouses": "ERPNext warehouses blocking the cut",
  "counts.cut.device.no_heartbeat": "The device has sent no health report",
  "counts.cut.device.stale_heartbeat": "The device's last report is older than the cut request",
  "counts.cut.device.queue_unknown": "The device did not report its sale queue",
  "counts.cut.device.queue_pending": "The device's queue holds a pending, failed or held sale",
  "counts.cut.warehouse.import_not_past_cut": "No stock import has completed since the cut request",
  "counts.error.ownerOnly": "Only the tenant owner can read or change this setting.",

  "counts.selfSetting.title": "Small-shop self-approval",
  "counts.selfSetting.sub":
    "By default someone other than the counters and the submitter approves a count. If you run the shop alone or with very few people, you can allow self-approval with a recorded reason. Every change is audited and self-approved sessions are marked in review. There is no variance threshold and no override from outside the tenant.",
  "counts.selfSetting.on": "Self-approval is allowed.",
  "counts.selfSetting.off": "Self-approval is not allowed.",
  "counts.selfSetting.changed": "Changed by {who} at {when}.",
  "counts.selfSetting.enable": "Allow self-approval of counts",
  "counts.selfSetting.reason": "Reason for allowing it",
  "counts.selfSetting.error.reason": "Write the reason for allowing self-approval.",
  "counts.selfSetting.save": "Save setting",
  "counts.selfSetting.saved": "Setting saved.",
  "counts.selfSetting.failed": "The setting was not saved",
  "counts.selfSetting.loadingNoun": "the setting",
  "counts.selfSetting.loadFailed": "The setting could not be loaded.",
  "counts.selfSetting.notAvailable": "This setting is not available.",

  // --- Refusals (a typed code selects the message; the code stays visible) -----------------
  "counts.error.code": "Code: {code}",
  "counts.error.noAnswer":
    "The server did not answer, so it is not known whether the request was applied. Try again: the same request is never applied twice.",
  "counts.error.notInState":
    "This action is not available in the session's current status. Nothing changed. Refresh the page.",
  "counts.error.trackedRefused":
    "A batch or serial product cannot be counted yet. The session was not opened. Remove that product.",
  "counts.error.scopeInUse":
    "At least one product is already in another live count session of the store. The session was not opened.",
  "counts.error.cutBlocked":
    "The Count Cut is not ready yet: not every POS device of the store has synced, or the ERPNext import has not caught up. No cut was recorded. Try again after syncing.",
  "counts.error.approverConflict":
    "Whoever took part in counting or submitting cannot approve, unless the tenant owner enabled the small-shop exception. The count was not approved. Ask another person to approve it.",
  "counts.error.notAcknowledged":
    "A flagged line has not been reviewed. The count was not approved. Review every flagged line.",
  "counts.error.lineStale":
    "A line changed after you reviewed it (a recount or a late event). The count was not approved. The lines were reloaded: review again.",
  "counts.error.keyConflict": "The request key conflicts. Nothing was applied. Try again.",
  "counts.error.conflict":
    "The server refused the request because it conflicts with the session's state. Nothing changed.",
  "counts.error.validation": "The server rejected the values entered. Check them and try again.",
  "counts.error.session": "Your session has ended. Sign in again.",
  "counts.error.forbidden": "This action is not available to your role or for this store.",
  "counts.error.notFound": "The session or store is not available.",
  "counts.error.rateLimited": "Too many requests in a short time. Wait a moment, then retry.",
  "counts.error.rateLimitedFor": {
    one: "Too many requests in a short time. Retry in 1 second.",
    other: "Too many requests in a short time. Retry in {count} seconds.",
  },
  "counts.error.generic":
    "The request could not be completed. It is not known whether anything changed. Try again.",
};
