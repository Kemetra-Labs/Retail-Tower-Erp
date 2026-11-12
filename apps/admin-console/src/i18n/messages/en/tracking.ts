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

  "tracking.resolution.title": "Resolution queue",
  "tracking.resolution.intro":
    "Sales captured without a confirmed tracking identity. They are bound to an existing identity by a governed command with a reason. Until then the sale has no effect on stock and no ERPNext posting.",
  "tracking.resolution.caption":
    "Sales without a confirmed tracking identity, newest capture first",
  "tracking.resolution.loadingNoun": "the resolution queue",
  "tracking.resolution.loadFailed":
    "The resolution queue could not be loaded. The count is unknown.",
  "tracking.resolution.empty": "No sales are waiting to be bound.",
  "tracking.resolution.statusLabel": "Status",
  "tracking.resolution.status.unresolved": "Waiting to be bound",
  "tracking.resolution.status.resolved": "Bound",
  "tracking.resolution.status.all": "All",
  "tracking.resolution.ownerOnly":
    "Binding an identity is sensitive and is for the tenant owner only. Ask the owner to bind it if needed.",
  "tracking.resolution.col.sale": "Sale",
  "tracking.resolution.col.businessDate": "Business date",
  "tracking.resolution.col.capturedAt": "Received",
  "tracking.resolution.col.lines": "Lines",
  "tracking.resolution.col.resolution": "Recorded binding",
  "tracking.resolution.lineReason.tracking_missing": "No tracking data",
  "tracking.resolution.lineReason.identity_unknown": "Unknown identity",
  "tracking.resolution.lineReason.identity_other_product": "Another product's identity",
  "tracking.resolution.bind": "Bind identity",
  "tracking.resolution.drawer.title": "Bind identities to the sale's lines",
  "tracking.resolution.drawer.scope": "Sale {sale}",
  "tracking.resolution.drawer.sensitive":
    "A sensitive, audited action. Choose an existing identity for every unresolved line, then give the reason and a note. The binding is final: its stock effect and its ERPNext posting are recorded together.",
  "tracking.resolution.identityChoose": "Choose the batch or serial",
  "tracking.resolution.identitiesLoading": "Loading the product's identities",
  "tracking.resolution.identitiesFailed": "This product's identities could not be loaded.",
  "tracking.resolution.identitiesNone": "This product has no recorded identity.",
  "tracking.resolution.identitiesMore": "Load more identities",
  "tracking.resolution.loadMore": "Load more sales",
  "tracking.saleLines.loadMore": "Load more findings",
  "tracking.resolution.submit": "Review binding",
  "tracking.resolution.confirm": {
    one: "Bind an identity to the line? The binding is final and cannot be undone.",
    other: "Bind an identity to all {count} lines? The binding is final and cannot be undone.",
  },
  "tracking.resolution.confirmYes": "Confirm binding",
  "tracking.resolution.recorded": {
    one: "The binding was recorded on 1 line.",
    other: "The binding was recorded on {count} lines.",
  },
  "tracking.saleLines.title": "Sale-line findings",
  "tracking.saleLines.intro":
    "Fixed records of what happened at the sale: sold under a hold, a tracked line without validation, a held ERPNext posting. They are not removed when the cause is fixed and are not part of the band's counts.",
  "tracking.saleLines.caption": "Sale-line findings, newest recorded first",
  "tracking.saleLines.loadingNoun": "sale-line findings",
  "tracking.saleLines.loadFailed": "Sale-line findings could not be loaded.",
  "tracking.saleLines.empty": "No sale-line findings are recorded.",
  "tracking.saleLines.kindLabel": "Kind",
  "tracking.saleLines.kindAll": "All kinds",
  "tracking.saleLines.col.kind": "Kind",
  "tracking.saleLines.col.cause": "Cause",
  "tracking.saleLines.col.recordedAt": "Recorded",
  "tracking.saleLines.kind.unvalidated_tracked_line": "Tracked line without validation",
  "tracking.saleLines.kind.sold_under_hold": "Sold under a hold",
  "tracking.saleLines.kind.erp_intent_held": "ERPNext posting held",
  "tracking.saleLines.cause.validation_missing": "No validation id",
  "tracking.saleLines.cause.validation_mismatch": "Validation does not match the identity",
  "tracking.saleLines.cause.quality_hold": "Quality hold",
  "tracking.saleLines.cause.recall_hold": "Recall hold",
  "tracking.saleLines.cause.expired": "The batch was expired",
  "tracking.saleLines.cause.edge_map_missing": "No ERPNext batch mapped",
  "tracking.consistency.unavailable.title": "The tracking consistency check is not available",
  "tracking.consistency.unavailable.body":
    "The server does not emit this check's findings yet, so having none does not mean the records are consistent.",
  "tracking.manager.readOnly":
    "Recording a recall and placing a hold are for the tenant owner and admin. Rows show the finding's fields only.",
  "tracking.manager.queueCount": "Sales waiting for an identity in your stores:",
  "tracking.manager.queueCountFailed":
    "The number of sales waiting for an identity could not be loaded. The count is unknown.",

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
  "tracking.write.reason": "Reason",
  "tracking.write.reasonChoose": "Choose a reason",
  "tracking.write.note": "Note",
  "tracking.write.noteOptional": "Optional, up to 500 characters. No personal data.",
  "tracking.write.noteRequired": "Required with “Other”, up to 500 characters. No personal data.",
  "tracking.write.error.reason": "Choose a reason from the list.",
  "tracking.write.error.noteRequired": "Write a note that explains “Other”.",
  "tracking.write.error.noteLength": "The note is longer than 500 characters.",
  "tracking.write.error.reference": "Enter the reference, 1 to 200 characters.",
  "tracking.write.error.identities": "Choose at least one batch.",
  "tracking.write.error.tooMany": "At most 100 batches can be recalled at once.",
  "tracking.write.error.effectiveAt": "The effective time is now or earlier, never later.",
  "tracking.write.error.date": "Enter the date as year-month-day.",
  "tracking.write.error.dateRequired": "Choose the new date, or choose to clear the expiry date.",
  "tracking.write.rejected": "Nothing was recorded",
  "tracking.write.noBody": "The server refused the command (status {status}) without a message.",
  "tracking.write.code": "Code: {code}",
  "tracking.write.failed":
    "No answer arrived, so it is not known whether the command was recorded. Retrying the same command is safe: it is never recorded twice.",
  "tracking.write.hint.notFound":
    "The server did not find this batch. Tracking commands work only once batches are imported from ERPNext.",
  "tracking.write.hint.forbidden": "This command is not available to your role.",
  "tracking.write.hint.bindNotFound":
    "The server did not find this sale or one of the identities, or the sale is no longer waiting. Nothing was recorded.",
  "tracking.write.hint.resolutionMismatch":
    "One of the identities is not of its line's product. Nothing was recorded.",
  "tracking.write.hint.resolutionHeld":
    "One of the identities has an active hold now, or had one at the time of the sale. Nothing was recorded.",
  "tracking.write.hint.resolutionExpired":
    "One of the identities expired before the sale's business date. Nothing was recorded.",
  "tracking.write.hint.resolutionResolved":
    "This sale was already bound by another command. Reload the list.",
  "tracking.write.error.bindNote": "Write a note explaining the binding: it is required.",
  "tracking.write.error.bindLines": "Choose an identity for every line.",
  "tracking.write.hint.holdActive":
    "This batch already has an active hold of this kind, so nothing was recorded. Open the existing hold from the active holds list.",
  "tracking.write.hint.expiryUnchanged":
    "That is the current expiry date, so no correction was recorded.",
  "tracking.write.cancel": "Cancel",
  "tracking.write.close": "Close",
  "tracking.placeHold.open": "Place quality hold",
  "tracking.placeHold.title": "Place quality hold",
  "tracking.placeHold.scope": "{code} · every store",
  "tracking.placeHold.effect":
    "Sellable and return-inspection stock of this batch moves to “Quality hold” in every store, and a held batch is not sold. Only the tenant owner can release it.",
  "tracking.placeHold.submit": "Place hold",
  "tracking.placeHold.recorded":
    "A quality hold was placed on {code}. Holds and quantities are re-read from the server.",
  "tracking.release.submit": "Release hold",
  "tracking.release.confirm":
    "Release the hold on {code}? Its stock returns to “Sellable”, or to “Recall hold” if it was ever recalled.",
  "tracking.release.yes": "Yes, release the hold",
  "tracking.release.recorded":
    "The hold on {code} was released. Holds and quantities are re-read from the server.",
  "tracking.recallCreate.open": "Record recall",
  "tracking.recallCreate.title": "Record recall",
  "tracking.recallCreate.pickProduct": "Choose the recalled product, then its batches.",
  "tracking.recallCreate.changeProduct": "Change product",
  "tracking.recallCreate.identities": "Recalled batches",
  "tracking.recallCreate.identitiesHelp": {
    one: "1 to {max} batches. 1 chosen.",
    other: "1 to {max} batches. {count} chosen.",
  },
  "tracking.recallCreate.identitiesNoun": "batches",
  "tracking.recallCreate.identitiesFailed": "The product's batches could not be loaded.",
  "tracking.recallCreate.identitiesEmpty": "No batches or serials are recorded for this product.",
  "tracking.recallCreate.identitiesMore": "Load more batches",
  "tracking.recallCreate.referenceHelp":
    "The external notice number, such as an authority notice. Up to 200 characters.",
  "tracking.recallCreate.effectiveHelp": "Leave empty for now, or choose an earlier time.",
  "tracking.recallCreate.effect":
    "Sellable and return-inspection stock of these batches moves to “Recall hold” in every store. Releasing the recall hold later does not return it.",
  "tracking.recallCreate.submit": "Record the recall",
  "tracking.recallCreate.recorded": {
    one: "The recall was recorded and 1 batch is under a recall hold. Holds are re-read from the server.",
    other:
      "The recall was recorded and {count} batches are under a recall hold. Holds are re-read from the server.",
  },
  "tracking.identity.viewHold": "View hold",
  "tracking.expiry.newDate": "New expiry date",
  "tracking.expiry.current": "Current date: {date}.",
  "tracking.expiry.currentNone": "No expiry date is recorded now.",
  "tracking.expiry.clear":
    "Clear the expiry date (the server refuses it when the tracking profile requires one)",
  "tracking.expiry.submit": "Record correction",
  "tracking.expiry.recorded":
    "The expiry date was corrected to {date}. The correction is kept with the old date and the reason.",
  "tracking.expiry.cleared":
    "The expiry date was cleared. The correction is kept with the old date and the reason.",
  "tracking.corrections.history": "Correction history",
};
