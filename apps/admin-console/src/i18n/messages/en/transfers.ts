import type { transfers as ar } from "../ar/transfers";
import type { MessagesOf } from "../types";

export const transfers: MessagesOf<typeof ar> = {
  "transfers.entry": "Stock transfers between stores",
  "transfers.title": "Stock transfers",
  "transfers.sub": "Goods moving between the organization's stores, newest first.",
  "transfers.note.readOnly":
    "Read only. No transfer is created, approved, dispatched or received here.",
  "transfers.note.inTransit":
    "In transit is a quantity of the transfer line, not a stock location or a stock status.",

  "transfers.value.unknown": "Unknown",
  "transfers.value.none": "—",
  "transfers.notFound": "This transfer is not available.",
  "transfers.notAvailable": "Stock transfers are not available for this organization.",
  "transfers.notAvailable.hint":
    "Transfers may not be switched on for the organization yet. An owner or tenant admin switches them on when it is ready.",
  "transfers.notAvailable.filtered":
    "Transfers may not be switched on for the organization, or the chosen store is not available to you. Reset the filters.",
  "transfers.route": "From {source} to {destination}",

  "transfers.state.draft": "Draft",
  "transfers.state.approved": "Approved",
  "transfers.state.in_transit": "In transit",
  "transfers.state.partially_received": "Partially received",
  "transfers.state.received": "Received",
  "transfers.state.closed": "Closed",
  "transfers.state.cancelled": "Cancelled",

  "transfers.leg.not_posted": "Not posted yet",
  "transfers.leg.pending": "Posting",
  "transfers.leg.confirmed": "Confirmed by ERPNext",
  "transfers.leg.rejected": "Rejected by ERPNext",
  "transfers.leg.reconciliation_required": "Needs reconciliation",
  "transfers.leg.notDispatched": "Not dispatched yet",

  "transfers.filter.legend": "Filter transfers",
  "transfers.filter.store": "Store",
  "transfers.filter.store.all": "All stores",
  "transfers.filter.direction": "Direction",
  "transfers.filter.direction.any": "Outbound and inbound",
  "transfers.filter.direction.outbound": "Outbound from the store",
  "transfers.filter.direction.inbound": "Inbound to the store",
  "transfers.filter.state": "Status",
  "transfers.filter.state.all": "All statuses",
  "transfers.filter.reset": "Reset filters",

  "transfers.list.title": "Transfers",
  "transfers.list.caption": "Stock transfers, newest first",
  "transfers.list.col.created": "Created",
  "transfers.list.col.route": "Route",
  "transfers.list.col.state": "Status",
  "transfers.list.col.lines": "Lines",
  "transfers.list.col.receipts": "Receipts",
  "transfers.list.col.dispatchErp": "Dispatch posting in ERPNext",
  "transfers.list.openHint": "Open transfer details",
  "transfers.list.loadingNoun": "transfers",
  "transfers.list.loadFailed": "Could not load the transfers.",
  "transfers.list.empty": "There are no stock transfers yet.",
  "transfers.list.emptyFiltered": "No transfers match the filters.",
  "transfers.list.loadMore": "Load older transfers",

  "transfers.detail.title": "Transfer details",
  "transfers.detail.loadingNoun": "the transfer",
  "transfers.detail.loadFailed": "Could not load the transfer.",
  "transfers.detail.route": "Route",
  "transfers.detail.state": "Status",
  "transfers.detail.createdAt": "Created",
  "transfers.detail.approvedAt": "Approved",
  "transfers.detail.dispatchedAt": "Dispatched",
  "transfers.detail.shortClosedAt": "Short-close approved",
  "transfers.detail.closedAt": "Closed",
  "transfers.detail.cancelledAt": "Cancelled",
  "transfers.detail.dispatchErp": "Dispatch posting in ERPNext",
  "transfers.detail.reason": "Reason",
  "transfers.detail.shortCloseReason": "Short-close reason",
  "transfers.detail.cancelReason": "Cancellation reason",
  "transfers.detail.id": "Transfer reference",

  "transfers.lines.title": "Lines",
  "transfers.lines.caption": "The transfer's lines and their quantities",
  "transfers.lines.col.seq": "Line",
  "transfers.lines.col.product": "Product",
  "transfers.lines.col.tracking": "Tracking identity",
  "transfers.lines.col.unit": "Unit",
  "transfers.lines.col.ordered": "Ordered",
  "transfers.lines.col.dispatched": "Dispatched",
  "transfers.lines.col.received": "Received",
  "transfers.lines.col.shortClosed": "Short-closed",
  "transfers.lines.col.inTransit": "In transit",

  "transfers.receipts.title": "Receipts",
  "transfers.receipts.caption": "The transfer's receipts, oldest first",
  "transfers.receipts.col.receivedAt": "Received",
  "transfers.receipts.col.erp": "Receipt posting in ERPNext",
  "transfers.receipts.col.line": "Line",
  "transfers.receipts.col.quantity": "Quantity received",
  "transfers.receipts.col.status": "Stock status on receipt",
  "transfers.receipts.col.note": "Note",
  "transfers.receipts.loadingNoun": "receipts",
  "transfers.receipts.loadFailed": "Could not load the receipts.",
  "transfers.receipts.empty": "No receipt has been recorded for this transfer yet.",
  "transfers.receipts.loadMore": "Load later receipts",

  "transfers.note.writes":
    "Here you can draft, approve, cancel and dispatch transfers. Receiving and closing are not available here yet.",

  "transfers.create.open": "New transfer",
  "transfers.create.title": "New transfer",
  "transfers.create.scope": "A draft transfer between two stores",
  "transfers.create.intro":
    "Choose the source store and the destination store, then add products and quantities. The transfer is saved as a draft: no goods move and no stock is reserved before approval.",
  "transfers.create.chooseStore": "Choose a store",
  "transfers.create.source": "Source store",
  "transfers.create.destination": "Destination store",
  "transfers.create.noLines": "No products added yet.",
  "transfers.create.quantity": "Quantity",
  "transfers.create.remove": "Remove",
  "transfers.create.removeLine": "Remove line: {name}",
  "transfers.create.addProduct": "Add a product",
  "transfers.create.addProductHelp":
    "Search for an active product and choose it to add a line. One line per product, and per batch for batch-tracked products.",
  "transfers.create.add.serial":
    "Serial-tracked products cannot be transferred yet. Choose another product.",
  "transfers.create.add.duplicate": "This product is already added. One line per product.",
  "transfers.create.add.tooMany": "The transfer has reached the limit of 100 lines.",
  "transfers.create.add.unknownMode":
    "This product's tracking mode is unknown, so it cannot be added.",
  "transfers.create.identity": "Batch",
  "transfers.create.identitiesNoun": "Batches",
  "transfers.create.identitiesFailed": "Could not load the product's batches.",
  "transfers.create.identitiesUnavailable": "Your role cannot read this product's batches.",
  "transfers.create.identitiesEmpty": "No batch is recorded for this product.",
  "transfers.create.identitiesMore": "Load more batches",
  "transfers.create.stock.noSource": "Choose the source store to read its stock of this product.",
  "transfers.create.stock.loading": "Reading the source store's stock…",
  "transfers.create.stock.failed":
    "The source store's stock could not be read, so the stocking unit is unknown and the transfer cannot be sent.",
  "transfers.create.stock.physical": "Physical on-hand at source",
  "transfers.create.stock.sellable": "Sellable at source",
  "transfers.create.stock.noUnit":
    "Unknown: no unit is recorded for this product at the source store",
  "transfers.create.reason": "Reason for the transfer",
  "transfers.create.reasonHelp": "Up to {max} characters.",
  "transfers.create.effect":
    "Saving does not ship anything: the transfer stays a draft until it is approved and then dispatched.",
  "transfers.create.submit": "Save transfer draft",
  "transfers.create.error.source": "Choose the source store.",
  "transfers.create.error.destination": "Choose the destination store.",
  "transfers.create.error.sameStore": "The destination store must differ from the source store.",
  "transfers.create.error.noLines": "Add at least one product.",
  "transfers.create.error.tooManyLines": "A transfer holds at most 100 lines.",
  "transfers.create.error.reason": "The transfer reason is longer than 500 characters.",
  "transfers.create.error.identity": "Choose a batch for this product.",
  "transfers.create.error.quantity": "Enter a quantity above zero, up to 4 decimal places.",
  "transfers.create.error.unit":
    "The stocking unit of this product at the source store is unknown.",
  "transfers.create.error.duplicate":
    "This product (and batch) is repeated on another line. Keep one line.",

  "transfers.write.optional": "(optional)",
  "transfers.write.retry": "Send the same request again",
  "transfers.write.failed":
    "No answer came back, so it is unknown whether the request was recorded. Send the same request again: it will not be recorded twice.",
  "transfers.write.error.validation":
    "The server rejected the request data. Check the fields, then try again.",
  "transfers.write.error.session": "Your session has ended. Sign in again.",
  "transfers.write.error.forbidden": "Your role does not allow this action on this transfer.",
  "transfers.write.error.notFound": "The store or transfer is not available to you.",
  "transfers.write.error.rateLimited":
    "Too many requests in a short time. Wait a moment, then retry.",
  "transfers.write.error.rateLimitedFor": {
    one: "Too many requests in a short time. Retry in 1 second.",
    other: "Too many requests in a short time. Retry in {count} seconds.",
  },
  "transfers.write.error.notInState":
    "The transfer's state has changed and this action is no longer available. Reopen the transfer to see its current state.",
  "transfers.write.error.crossLegalEntity":
    "The two stores belong to different legal entities, so goods cannot be transferred between them.",
  "transfers.write.error.identityRequired":
    "A tracked product needs exactly one batch on each line. Choose the batch.",
  "transfers.write.error.identityHeldOrExpired":
    "The chosen batch is on hold or expired. Choose another batch.",
  "transfers.write.error.serialNotSupported":
    "Transferring serial-tracked products is not supported yet.",
  "transfers.write.error.warehouseUnmapped":
    "One of the stores, or the in-transit warehouse, is not mapped to an ERPNext warehouse. Ask an administrator to complete the mapping.",
  "transfers.write.error.itemUnmapped":
    "One of the products is not mapped to its ERPNext counterpart. Ask an administrator to complete the mapping.",
  "transfers.write.error.keyConflict":
    "This request could not be confirmed and was not recorded. Submit again to send a new request.",
  "transfers.write.error.overReceipt":
    "The received quantity exceeds the ordered quantity and needs approval.",
  "transfers.write.error.shortCloseReason": "Short-closing the missing quantity needs a reason.",
  "transfers.write.error.generic": "The server could not complete the request. Try again shortly.",
  "transfers.write.error.code": "Error code: {code}",

  "transfers.actions.title": "Actions",
  "transfers.approve.open": "Approve transfer",
  "transfers.approve.intro":
    "Approving reserves the transfer's quantity at the source store until the chosen window ends.",
  "transfers.approve.window": "Reservation window",
  "transfers.approve.days.1": "1 day",
  "transfers.approve.days.3": "3 days",
  "transfers.approve.days.7": "7 days",
  "transfers.approve.until": "The reservation ends around {at}.",
  "transfers.approve.submit": "Approve",
  "transfers.cancel.open": "Cancel transfer",
  "transfers.cancel.intro":
    "Cancelling ends this transfer and keeps the reason on it. There is no undo for a cancellation here.",
  "transfers.cancel.reason": "Reason for cancelling",
  "transfers.cancel.submit": "Confirm cancellation",
  "transfers.cancel.error.reason": "Enter a reason for cancelling, 1 to 500 characters.",
  "transfers.dispatch.open": "Dispatch transfer",
  "transfers.dispatch.confirm":
    "The whole approved quantity leaves the source store and goes In transit. There is no partial dispatch.",
  "transfers.dispatch.note": "Dispatch note",
  "transfers.dispatch.submit": "Confirm dispatch",
  "transfers.dispatch.error.note": "The dispatch note is longer than 500 characters.",
  "transfers.recorded.approve": "The approval was recorded.",
  "transfers.recorded.cancel": "The cancellation was recorded.",
  "transfers.recorded.dispatch": "The dispatch was recorded.",
};
