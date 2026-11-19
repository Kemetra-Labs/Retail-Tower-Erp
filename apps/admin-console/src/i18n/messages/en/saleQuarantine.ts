import type { saleQuarantine as ar } from "../ar/saleQuarantine";
import type { MessagesOf } from "../types";

export const saleQuarantine: MessagesOf<typeof ar> = {
  // --- Navigation (under the Integration section, owner / tenant_admin) ----------
  "saleQuarantine.nav.label": "Sales the till could not send",

  // --- List ------------------------------------------------------------------------
  "saleQuarantine.list.title": "Sales the till could not send",
  "saleQuarantine.list.bandSub": "Sales the server has not recorded yet · {tenant}",
  "saleQuarantine.list.sub":
    "Sales in {tenant} that a till sent after the server refused to record them for good, or that the till held back after a re-pair, newest first. These sales are not recorded in the system until someone acts on them.",
  "saleQuarantine.list.note":
    "This list is separate from Sales needing repair, which holds sales that were recorded and whose sync stopped. A sale listed here is not an ERPNext posting failure, and a sale missing from the list is not proof it was posted.",
  "saleQuarantine.list.otherQueue": "Sales needing repair (ERPNext sync)",
  "saleQuarantine.list.scopePrompt": "Select a tenant to view sales the till could not send.",
  "saleQuarantine.list.refresh": "Refresh",
  "saleQuarantine.list.loadMore": "Load more",
  "saleQuarantine.list.asOf": "Last read: {time}",
  "saleQuarantine.list.caption": "Sales the till could not send, newest first",
  "saleQuarantine.list.loadingNoun": "sales the till could not send",
  "saleQuarantine.list.loadFailed": "Sales the till could not send could not be loaded.",
  "saleQuarantine.list.empty": "No open sales the till could not send.",
  "saleQuarantine.list.emptyState": "No items in this state.",
  "saleQuarantine.list.emptyStore": "No items in this store in the chosen state.",
  "saleQuarantine.list.emptyHint":
    "An empty list does not mean every till sale was recorded; the unsent sale counts are on the Devices screen.",
  "saleQuarantine.list.storeNotFound": "This store is not available to you.",
  "saleQuarantine.list.stateNotFound": "This state is not known.",
  "saleQuarantine.list.unknownStore": "Unknown store",
  "saleQuarantine.list.openItem": "Open item {ref}",
  "saleQuarantine.filter.label": "Filter sales the till could not send",
  "saleQuarantine.filter.store": "Store",
  "saleQuarantine.filter.allStores": "All stores",
  "saleQuarantine.filter.state": "State",
  "saleQuarantine.col.externalId": "Source reference",
  "saleQuarantine.col.store": "Store",
  "saleQuarantine.col.reason": "Why it is stuck",
  "saleQuarantine.col.total": "Total on the till",
  "saleQuarantine.col.state": "State",
  "saleQuarantine.col.receivedAt": "Reached the server",

  // --- State and the till's reason ----------------------------------------------------
  "saleQuarantine.state.open": "Open",
  "saleQuarantine.state.captured": "Recorded by a repair",
  "saleQuarantine.state.alreadyCaptured": "Already recorded",
  "saleQuarantine.state.writtenOff": "Closed without recording",
  "saleQuarantine.state.unknown": "Unknown state",
  "saleQuarantine.meaning.open":
    "The sale is not recorded in the system and is waiting for action. It can be closed without recording if it was handled outside Retail Tower.",
  "saleQuarantine.meaning.captured":
    "The server recorded this sale through a repair. The item has left the open list.",
  "saleQuarantine.meaning.alreadyCaptured":
    "The server found the sale already recorded with the same facts. The item has left the open list.",
  "saleQuarantine.meaning.writtenOff":
    "The item was closed without recording the sale. No sale, posting or stock effect was created, and the sale is handled outside Retail Tower.",
  "saleQuarantine.meaning.unknown":
    "The server sent a state this version does not know. Treat it as neither open nor closed.",
  "saleQuarantine.reason.refused": "The server refused the sale for good",
  "saleQuarantine.reason.payloadDivergence": "Different facts for the same sale reference",
  "saleQuarantine.reason.cashierClaimRefused": "The cashier claim was refused",
  "saleQuarantine.reason.heldPreviousPairing": "Held from an earlier pairing",
  "saleQuarantine.reason.unknown": "Unknown reason",

  // --- Item page ------------------------------------------------------------------------
  "saleQuarantine.detail.back": "Back to sales the till could not send",
  "saleQuarantine.detail.title": "Unsent till sale {ref}",
  "saleQuarantine.detail.scopePrompt": "Select a tenant to view this item.",
  "saleQuarantine.detail.loadingNoun": "item",
  "saleQuarantine.detail.loadFailed": "This item could not be loaded.",
  "saleQuarantine.detail.notFound": "This item was not found or is not available to you.",
  "saleQuarantine.detail.uploadConflict": {
    one: "The till uploaded a sale with this reference once more, with different facts. The till holds a different sale for this reference, and nothing of it is stored here. Check it on the till before you act.",
    other:
      "The till uploaded a sale with this reference {count} more times, with different facts. The till holds a different sale for this reference, and nothing of it is stored here. Check it on the till before you act.",
  },
  "saleQuarantine.section.item": "Item",
  "saleQuarantine.section.till": "What the till recorded",
  "saleQuarantine.section.sale": "The sale as the till recorded it",
  "saleQuarantine.section.handling": "Handling",
  "saleQuarantine.field.state": "State",
  "saleQuarantine.field.store": "Store",
  "saleQuarantine.field.device": "Uploading device",
  "saleQuarantine.field.source": "Source system",
  "saleQuarantine.field.externalId": "Source reference",
  "saleQuarantine.field.receivedAt": "Reached the server",
  "saleQuarantine.field.reason": "Why it is stuck (the till's claim)",
  "saleQuarantine.field.tillStatus": "Refusal status at the till",
  "saleQuarantine.field.tillCode": "Error code at the till",
  "saleQuarantine.field.tillRecordedAt": "Recorded on the till (till clock)",
  "saleQuarantine.field.previousTerminal": "Device of the earlier pairing",
  "saleQuarantine.field.occurredAt": "Sale time",
  "saleQuarantine.field.total": "Total on the till",
  "saleQuarantine.field.lineCount": "Lines",
  "saleQuarantine.field.repairCount": "Repairs",
  "saleQuarantine.field.lastRepair": "Last repair attempt",
  "saleQuarantine.field.sale": "Recorded sale",
  "saleQuarantine.field.writtenOffAt": "Closed",
  "saleQuarantine.field.writeOffNote": "Closing note",
  "saleQuarantine.value.notRecorded": "Not recorded",
  "saleQuarantine.value.openSale": "Open the sale",
  "saleQuarantine.lastRepair": "{at}: {outcome}",
  "saleQuarantine.lastRepair.captured": "A new sale was recorded",
  "saleQuarantine.lastRepair.alreadyCaptured": "Already recorded",
  "saleQuarantine.lastRepair.refused": "Refused again",
  "saleQuarantine.lastRepair.unknown": "Unknown result",
  "saleQuarantine.summary.hint":
    "A summary read from the stored sale. The sale body and its lines are not shown. A field reads Not recorded when the stored sale does not carry it in a valid form.",
  "saleQuarantine.handling.repairLater":
    "Recording the sale from here is not available yet. If this sale was handled outside Retail Tower, you can close the item without recording it.",
  "saleQuarantine.handling.closed": "This item is no longer open, so no action is offered on it.",
  "saleQuarantine.handling.unknownState":
    "This item's state is not known to this version, so no action is offered on it.",

  // --- Write-off (the one write) -----------------------------------------------------------
  "saleQuarantine.writeOff.title": "Close without recording",
  "saleQuarantine.writeOff.explain":
    "Closes the item for good without recording the sale: no sale, posting or stock effect is created, and it cannot be undone. Use it for a sale handled outside Retail Tower. The stored sale is kept with the audit record.",
  "saleQuarantine.writeOff.action": "Close without recording",
  "saleQuarantine.writeOff.dialogTitle": "Close the item without recording the sale",
  "saleQuarantine.writeOff.consequence":
    "Item {ref} will be closed for good without recording the sale. It will not appear in the store's sales or post to ERPNext, and stock will not change. This cannot be undone.",
  "saleQuarantine.writeOff.note.label": "Reason for closing",
  "saleQuarantine.writeOff.note.help":
    "Required, up to 500 characters. For example: refunded in cash outside Retail Tower. Do not enter card data.",
  "saleQuarantine.writeOff.note.required": "Enter the reason for closing.",
  "saleQuarantine.writeOff.note.tooLong": "The reason is longer than 500 characters.",
  "saleQuarantine.writeOff.needNote": "Enter the reason for closing to enable it.",
  "saleQuarantine.writeOff.commit": "Close without recording",
  "saleQuarantine.writeOff.committing": "Closing…",
  "saleQuarantine.writeOff.cancel": "Cancel",
  "saleQuarantine.writeOff.done": "Done",
  "saleQuarantine.writeOff.success":
    "The item was closed without recording the sale. No sale, posting or stock effect was created.",
  "saleQuarantine.writeOff.error.conflict":
    "The item is no longer open, and this request changed nothing. The item has been refreshed.",
  "saleQuarantine.writeOff.error.keyConflict":
    "The server refused the request because it does not match an earlier request with the same key. Nothing changed; you can close the item again.",
  "saleQuarantine.writeOff.error.notFound":
    "This item was not found or is not available to you. Nothing changed.",
  "saleQuarantine.writeOff.error.forbidden": "Your role cannot close this item. Nothing changed.",
  "saleQuarantine.writeOff.error.originRejected":
    "The server refused where this request came from, and nothing changed. Report it to support with the request ID.",
  "saleQuarantine.writeOff.error.rejected": "The server rejected the request. Nothing changed.",
  "saleQuarantine.writeOff.error.rateLimited":
    "Too many requests in a short time. The item was not closed.",
  "saleQuarantine.writeOff.error.rateLimitedFor": {
    one: "Too many requests in a short time. The item was not closed; you can ask again in 1 second.",
    other:
      "Too many requests in a short time. The item was not closed; you can ask again in {count} seconds.",
  },
  "saleQuarantine.writeOff.error.unconfirmed":
    "The server did not confirm the result and may have acted. Refresh the page and check the item's state before asking again; the next request with the same reason reuses the same key, so the item is never closed twice.",
};
