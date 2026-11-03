import type { tracking as ar } from "../ar/tracking";
import type { MessagesOf } from "../types";

export const tracking: MessagesOf<typeof ar> = {
  "tracking.nav.label": "Holds and recalls",
  "tracking.title": "Holds and recalls",
  "tracking.loadingNoun": "holds and recalls",
  "tracking.sub.tenant": "Tracked batches and serials in {tenant}, across every store.",
  "tracking.sub.manager": "Tracked batches and serials in your stores.",

  "tracking.band.label": "Tracking safety findings",
  "tracking.band.activeHolds": "Active holds",
  "tracking.band.expiredPositions": "Expired positions still sellable",
  "tracking.band.generatedAt": "Computed",
  "tracking.band.unknown": "The band's counts are unknown until the findings are read.",

  "tracking.findings.loadingNoun": "tracking safety findings",
  "tracking.findings.loadFailed":
    "Tracking safety findings could not be loaded. The band's counts are unknown.",
  "tracking.findings.stale":
    "Tracking safety findings could not be refreshed. Showing the last successful read.",
  "tracking.findings.unpaged":
    "This list is not paged: it is everything the server computed in your scope. Product and store names come from the catalog and the store list.",

  "tracking.tabs.label": "Holds and recalls sections",
  "tracking.tab.active": "Active holds",
  "tracking.tab.expired": "Expired, still sellable",
  "tracking.tab.expiring": "Expiring soon",
  "tracking.tab.released": "Released holds",
  "tracking.tab.recalls": "Recalls",
  "tracking.tab.resolution": "Resolution queue",
  "tracking.tab.saleLines": "Sale-line findings",

  "tracking.col.status": "Status",
  "tracking.col.kind": "Kind",
  "tracking.col.product": "Product",
  "tracking.col.identity": "Batch or serial",
  "tracking.col.code": "Code",
  "tracking.col.expiry": "Expiry date",
  "tracking.col.manufactured": "Manufactured",
  "tracking.col.origin": "Source",
  "tracking.col.placedAt": "Placed",
  "tracking.col.placedBy": "Placed by",
  "tracking.col.releasedAt": "Released",
  "tracking.col.releasedBy": "Released by",
  "tracking.col.releaseNote": "Release note",
  "tracking.col.stores": "Stores with stock",
  "tracking.col.store": "Store",
  "tracking.col.unit": "Stocking unit",
  "tracking.col.action": "Action",
  "tracking.col.reason": "Reason",
  "tracking.col.note": "Note",
  "tracking.col.recall": "Recall",
  "tracking.col.reference": "Reference",
  "tracking.col.effectiveAt": "Effective from",
  "tracking.col.createdAt": "Recorded",
  "tracking.col.createdBy": "Recorded by",
  "tracking.col.activeHolds": "Active holds",
  "tracking.col.expiredOn": "Expired on",
  "tracking.col.businessDate": "Store business date",
  "tracking.col.sellable": "Sellable",

  "tracking.action.open": "View",
  "tracking.value.none": "None",
  "tracking.date.none": "Not recorded",
  "tracking.stores.none": "No stock",
  "tracking.actor.unknown": "Not a member now",
  "tracking.holdKind.quality_hold": "Quality hold",
  "tracking.holdKind.recall_hold": "Recall hold",
  "tracking.reason.supplier_notice": "Supplier notice",
  "tracking.reason.authority_notice": "Authority notice",
  "tracking.reason.label_misprint": "Label misprint",
  "tracking.reason.other": "Other",
  "tracking.check.identity_without_edge_map": "Identity with no ERPNext link",
  "tracking.check.untracked_effect_on_tracked_product":
    "Movement without an identity on a tracked product",
  "tracking.check.serial_position_out_of_range": "Serial quantity out of range",
  "tracking.check.profile_erp_flag_mismatch": "Tracking profile does not match ERPNext",

  "tracking.active.caption": "Active holds on batches and serials",
  "tracking.active.empty": "No active holds.",
  "tracking.active.emptyHint": "No batch or serial is under an active quality or recall hold now.",
  "tracking.active.openLabel": "View the hold on {code}",

  "tracking.expired.caption": "Expired batches still sellable, per store and unit",
  "tracking.expired.empty": "No expired batch is still sellable.",
  "tracking.expired.move": "Move to “Expired”",
  "tracking.expired.note":
    "Opens the status move on the store's product balance page. A batch is sellable through the end of its expiry day.",

  "tracking.expiring.tag": "Stopped",
  "tracking.expiring.title": "The “expiring soon” alert is not on.",
  "tracking.expiring.body":
    "The window of days before expiry has not been approved. This does not mean no batch is about to expire.",

  "tracking.soon.tag": "Coming soon",
  "tracking.resolution.title": "The resolution queue is not on yet.",
  "tracking.resolution.body":
    "Sales recorded without a confirmed tracking identity, bound to an existing identity through a governed command with a reason. The contract is approved and the server has not turned it on yet, so no list or count is shown here.",
  "tracking.saleLines.title": "Sale-line findings are not on yet.",
  "tracking.saleLines.body":
    "Sold under hold, unvalidated tracked line and held ERPNext posting, per sale line. The contract is approved and the server has not turned it on yet, so no list or count is shown here.",
  "tracking.manager.readOnly":
    "Recording a recall and placing a hold are for the tenant owner and admin. Rows show the finding's fields only.",
  "tracking.manager.queueCount": "The number of sales waiting for an identity in your stores.",

  "tracking.consistency.title": {
    one: "1 tracking consistency finding",
    other: "{count} tracking consistency findings",
  },
  "tracking.consistency.body":
    "Records of a tracked product or identity disagree. The server computes these; fix them at their source.",

  "tracking.released.caption": "Released holds, newest first",
  "tracking.released.empty": "No released holds.",
  "tracking.released.loadingNoun": "released holds",
  "tracking.released.loadFailed": "Released holds could not be loaded.",
  "tracking.released.loadMore": "Load more holds",

  "tracking.recalls.caption": "Recalls, newest first",
  "tracking.recalls.empty": "No recalls.",
  "tracking.recalls.loadingNoun": "recalls",
  "tracking.recalls.loadFailed": "Recalls could not be loaded.",
  "tracking.recalls.loadMore": "Load more recalls",
  "tracking.recalls.holdCount": "{active} of {total}",
  "tracking.recalls.openLabel": "View recall {reference}",

  "tracking.hold.title": "{kind} · {state}",
  "tracking.hold.titleLoading": "Hold",
  "tracking.hold.scope": "Applies in every store",
  "tracking.hold.active": "Active",
  "tracking.hold.released": "Released",
  "tracking.hold.loadingNoun": "hold",
  "tracking.hold.loadFailed": "The hold could not be loaded.",
  "tracking.hold.notFound": "This hold is not available.",
  "tracking.release.ownerNote":
    "Releasing returns the held stock to “Sellable”, or to “Recall hold” if the batch was ever recalled. A release is final.",
  "tracking.release.ownerOnly":
    "Only the tenant owner can release a hold. Ask them to release it if needed.",
  "tracking.recall.title": "Recall",
  "tracking.recall.scope": "Applies in every store and does not retire the product",
  "tracking.recall.loadingNoun": "recall",
  "tracking.recall.loadFailed": "The recall could not be loaded.",
  "tracking.recall.notFound": "This recall is not available.",
  "tracking.recall.holdsCaption": "The recall's holds",
  "tracking.recall.note":
    "Releasing a recall hold does not return the stock to sale: it leaves through disposition.",

  "tracking.identity.back": "Back",
  "tracking.identity.titleLoading": "Batch",
  "tracking.identity.sub": "{kind} · {product}",
  "tracking.identity.loadingNoun": "batch",
  "tracking.identity.loadFailed": "The batch could not be loaded.",
  "tracking.identity.notFound": "This batch is not available.",
  "tracking.identity.open": "Open batch",
  "tracking.identity.openLabel": "Open batch {id}",
  "tracking.identity.data": "Batch details",
  "tracking.identity.originErp": "ERPNext · batches are created there only and not edited here.",
  "tracking.identity.holds": "Holds",
  "tracking.identity.noActiveHold": "No active hold on this batch.",
  "tracking.identity.heldSince": "{kind} active since",
  "tracking.identity.holdsCaption": "The batch's hold history, newest first",
  "tracking.identity.holdsNoun": "holds",
  "tracking.identity.holdsEmpty": "This batch has never been held.",
  "tracking.identity.holdsFailed":
    "The batch's holds could not be loaded. Its hold state is unknown.",
  "tracking.identity.holdsMore": "Load more holds",
  "tracking.identity.correctionsEmpty": "No expiry corrections.",
  "tracking.identity.correctionsFailed": "The correction history could not be loaded.",

  "tracking.positions.title": "Stock of this batch in the stores",
  "tracking.positions.caption": "Quantity by store, unit and status for this batch",
  "tracking.positions.total": "Total",
  "tracking.positions.loadingNoun": "stock",
  "tracking.positions.loadFailed": "The batch's stock could not be loaded. Quantities are unknown.",
  "tracking.positions.empty": "No stock movement for this batch yet.",
  "tracking.positions.note":
    "Summed over each store's locations: +5 at one and −5 at another read as 0. Quantities as the server sends them.",

  "tracking.corrections.title": "Expiry date corrections",
  "tracking.corrections.note":
    "Every correction is kept: the old and new date, the reason and who made it. It applies to the batch in every store.",
  "tracking.corrections.caption": "Correction history, newest first",
  "tracking.corrections.loadingNoun": "correction history",
  "tracking.corrections.loadMore": "Load more corrections",
  "tracking.corrections.old": "Old date",
  "tracking.corrections.new": "New date",
  "tracking.corrections.by": "Corrected by",

  "tracking.notTracked.title": "This tenant has no tracked products.",
  "tracking.notTracked.body":
    "This section appears once at least one product has a batch or serial tracking profile.",
};
