import type { vouchers as ar } from "../ar/vouchers";
import type { MessagesOf } from "../types";

export const vouchers: MessagesOf<typeof ar> = {
  "vouchers.nav.label": "Vouchers",

  // --- List -----------------------------------------------------------------
  "vouchers.list.title": "Vouchers",
  "vouchers.list.subtitle": "Promotional vouchers given away in the stores of {tenant}.",
  "vouchers.list.scopePrompt": "Select a tenant to manage its vouchers.",
  "vouchers.list.issue": "Issue vouchers",
  "vouchers.list.caption": "Vouchers, newest first",
  "vouchers.list.loadingNoun": "vouchers",
  "vouchers.list.empty": "No vouchers in this tenant yet.",
  "vouchers.list.emptyFiltered": "No vouchers match these filters.",
  "vouchers.list.emptyPage": "No vouchers on this page. Load more to keep looking.",
  "vouchers.list.loadMore": "Load more",
  "vouchers.list.loadFailed": "Vouchers could not be loaded.",
  "vouchers.list.col.value": "Value",
  "vouchers.list.col.status": "Status",
  "vouchers.list.col.validIn": "Valid in",
  "vouchers.list.col.expires": "Expires",
  "vouchers.list.col.issued": "Issued",
  "vouchers.list.col.actions": "Actions",
  "vouchers.list.open": "Open",
  "vouchers.list.openLabel": "Open the {amount} voucher issued {issued}",
  "vouchers.list.noExpiry": "Never",

  "vouchers.filters.label": "Voucher filters",
  "vouchers.filters.status": "Status",
  "vouchers.filters.statusAny": "Any status",
  "vouchers.filters.store": "Valid in store",
  "vouchers.filters.storeAny": "Any store",

  "vouchers.eligibility.all": "All stores",
  "vouchers.eligibility.unnamed": {
    one: "{count} other store",
    other: "{count} other stores",
  },

  "vouchers.status.active": "Active",
  "vouchers.status.redeemed": "Redeemed",
  "vouchers.status.cancelled": "Cancelled",
  "vouchers.status.expired": "Expired",
  "vouchers.status.unknown": "Unknown status",

  // --- Shared errors -------------------------------------------------------
  "vouchers.errors.session": "Your session has expired. Sign in again to continue.",
  "vouchers.errors.forbidden": "You do not have access to vouchers in this tenant.",
  "vouchers.errors.rateLimited":
    "Too many requests in a short time. Wait a moment, then try again.",

  // --- Issue ----------------------------------------------------------------
  "vouchers.issue.title": "Issue vouchers",
  "vouchers.issue.scopeLine": "Issuing vouchers in tenant {tenant}.",
  "vouchers.issue.onceNote":
    "Voucher codes are shown once, right after issuing, and can never be shown again. Have a safe place ready to keep them.",
  "vouchers.issue.count": "Number of vouchers",
  "vouchers.issue.countHint": "1 to {max} vouchers per batch.",
  "vouchers.issue.amount": "Value of each voucher (EGP)",
  "vouchers.issue.amountHint": "A voucher is used once; any unused remainder is lost.",
  "vouchers.issue.expiresAt": "Expires (optional)",
  "vouchers.issue.expiresHint":
    "In your device's time. Leave empty for a voucher that never expires.",
  "vouchers.issue.scope": "Where the vouchers are valid",
  "vouchers.issue.scopeAll": "All stores, including stores added later",
  "vouchers.issue.scopeStores": "Selected stores only",
  "vouchers.issue.stores": "Stores",
  "vouchers.issue.noStores": "No stores are available for you to choose.",
  "vouchers.issue.note": "Internal note (optional)",
  "vouchers.issue.noteHint": "Do not put personal data in the note.",
  "vouchers.issue.submit": "Issue the vouchers",
  "vouchers.issue.errors.validation":
    "Check the voucher details and try again. No voucher was issued.",
  "vouchers.issue.errors.generic":
    "The vouchers could not be issued. No voucher was issued. Try again.",
  "vouchers.issue.errors.forbidden":
    "You cannot issue these vouchers. Issuing for all stores needs access to every store of the tenant. No voucher was issued.",
  "vouchers.issue.errors.storeUnavailable":
    "One of the selected stores is not available. Choose other stores. No voucher was issued.",
  "vouchers.issue.errors.storeInactive":
    "One of the selected stores is inactive. Choose active stores. No voucher was issued.",
  "vouchers.issue.uncertain":
    "The issue result is not confirmed: the vouchers may have been issued without their codes reaching you. Do not issue again now. Open the voucher list, cancel the newest vouchers whose codes you do not have, then issue again.",
  "vouchers.issue.uncertainAction": "Open the voucher list",

  // --- Issued codes (shown once) ----------------------------------------------
  "vouchers.codes.title": "Issued voucher codes",
  "vouchers.codes.issued": {
    one: "1 voucher was issued.",
    other: "{count} vouchers were issued.",
  },
  "vouchers.codes.warning":
    "These codes are shown now only. Download the file or copy the codes before you close; they can never be shown again. If a code is lost, cancel its voucher and issue another.",
  "vouchers.codes.caption": "Voucher codes issued in this batch",
  "vouchers.codes.col.code": "Code",
  "vouchers.codes.col.value": "Value",
  "vouchers.codes.col.expires": "Expires",
  "vouchers.codes.download": "Download the codes file",
  "vouchers.codes.copy": "Copy all codes",
  "vouchers.codes.copied": "The codes were copied.",
  "vouchers.codes.copyFailed": "The codes could not be copied. Download the codes file instead.",
  "vouchers.codes.done": "I saved the codes, close",

  // --- Detail and cancel -------------------------------------------------------
  "vouchers.detail.title": "Voucher details",
  "vouchers.detail.loading": "voucher details",
  "vouchers.detail.notFound": "This voucher does not exist or is outside your access.",
  "vouchers.detail.loadFailed": "The voucher could not be loaded.",
  "vouchers.detail.value": "Value",
  "vouchers.detail.status": "Status",
  "vouchers.detail.validIn": "Valid in",
  "vouchers.detail.expires": "Expires",
  "vouchers.detail.issued": "Issued",
  "vouchers.detail.cancelledAt": "Cancelled",
  "vouchers.detail.batch": "Batch ID",
  "vouchers.detail.voucherId": "Voucher ID",
  "vouchers.detail.note": "Note",
  "vouchers.detail.noNote": "No note",
  "vouchers.detail.redeemedAt": "Redeemed",
  "vouchers.detail.applied": "Amount used",
  "vouchers.detail.forfeited": "Amount forfeited",
  "vouchers.detail.codeNote": "A voucher code is never shown after it is issued.",
  "vouchers.detail.cancel": "Cancel voucher",
  "vouchers.detail.cancelPrompt":
    "Cancelling this voucher is final: no store will accept it any more. No money is refunded.",
  "vouchers.detail.cancelConfirm": "Confirm cancelling the voucher",
  "vouchers.detail.cancelKeep": "Keep the voucher",
  "vouchers.detail.cancelled": "The voucher was cancelled.",
  "vouchers.detail.alreadyCancelled": "The voucher was already cancelled.",
  "vouchers.detail.cancelForbidden": "You cannot cancel this voucher.",
  "vouchers.detail.cancelRedeemed": "This voucher was redeemed, so it cannot be cancelled.",
  "vouchers.detail.cancelInProgress":
    "The cancel request is still in progress. Wait a moment, then confirm the cancel again.",
  "vouchers.detail.cancelFailed": "The voucher could not be cancelled. Try again.",

  // --- Form validation -----------------------------------------------------------
  "vouchers.form.countInvalid": "Enter a whole number from 1 to {max}.",
  "vouchers.form.amountRequired": "Enter the voucher value.",
  "vouchers.form.amountInvalid": "Enter a value greater than zero.",
  "vouchers.form.amountPrecision": "The value takes at most {digits} decimal places.",
  "vouchers.form.expiryInvalid": "Enter a valid date and time.",
  "vouchers.form.expiryPast": "Choose an expiry in the future.",
  "vouchers.form.storesRequired": "Choose at least one store.",
  "vouchers.form.storesTooMany": "Choose at most {max} stores.",
  "vouchers.form.noteTooLong": "The note is at most {max} characters.",
};
