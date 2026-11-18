import type { storeDeletion as ar } from "../ar/storeDeletion";
import type { MessagesOf } from "../types";

/** English copy for the owner's store deletion (RT-1437 A2, RT-1441 U2). Mirrors the Arabic keys. */
export const storeDeletion: MessagesOf<typeof ar> = {
  // --- The danger zone on the store page -------------------------------------
  "storeDeletion.zone.title": "Delete the store",
  "storeDeletion.zone.suspendInstead": "Suspending the store instead of deleting it can be undone.",
  "storeDeletion.zone.alreadySuspended":
    "This store is already suspended. Suspending can be undone; deleting cannot.",
  "storeDeletion.zone.suspendConfirm":
    "Suspend {name}? You can activate it again from the edit store page.",
  "storeDeletion.zone.suspendFailed": "Could not suspend the store. Nothing changed.",
  "storeDeletion.zone.suspendUnclear":
    "We could not confirm whether the store was suspended. Reload the page to check its state.",
  "storeDeletion.zone.delete": "Delete store…",

  // --- The dialog ------------------------------------------------------------
  "storeDeletion.title": "Delete the store",
  "storeDeletion.consequence":
    "This store disappears from the lists, and all of its terminals stop connecting at once. Past sales, shifts and documents stay as they are. There is no supported way to restore the store.",
  "storeDeletion.irreversible": "Deleting is permanent and cannot be undone.",
  "storeDeletion.suspendHint":
    "To pause the store only for now, close this window and suspend the store; you can activate it again later.",
  "storeDeletion.loading": "Checking what deleting would change…",
  "storeDeletion.previewFailed": "Could not check what deleting would change. Nothing changed.",
  "storeDeletion.error.previewNotAvailable":
    "This action is not available for your access, or the store does not exist.",
  "storeDeletion.error.previewOwnerOnly": "Only the account owner can delete a store.",
  "storeDeletion.retry": "Try again",
  "storeDeletion.snapshot":
    "As of {time}. This is a snapshot, not a reservation: the server decides again when you confirm.",

  // --- What the preview shows ------------------------------------------------
  "storeDeletion.fact.store": "Store",
  "storeDeletion.fact.code": "Code",
  "storeDeletion.fact.state": "State",
  "storeDeletion.fact.openShifts": "Open shifts",
  "storeDeletion.fact.devices": "Terminals",
  "storeDeletion.fact.openCounts": "Open count sessions",
  "storeDeletion.fact.warehouses": "Accounting warehouse mappings (kept)",
  "storeDeletion.fact.members": "Members with no other store",
  "storeDeletion.fact.offers": "Offers whose pack is rebuilt",
  "storeDeletion.devices.heading": "The store's terminals",
  "storeDeletion.device.noLabel": "Unlabelled terminal",
  "storeDeletion.device.lastSeen": "Last seen: {time}",
  "storeDeletion.device.neverSeen": "Never connected",
  "storeDeletion.device.queueUnknown": "Unsent sales: unknown",
  "storeDeletion.device.queue": "Unsent {pending} · stuck {deadLetter} · held {held}",
  "storeDeletion.heading.willChange": "What will change",
  "storeDeletion.heading.willNotChange": "What will not change",
  "storeDeletion.effect.willChange.store_hidden_from_lists": "The store disappears from the lists.",
  "storeDeletion.effect.willChange.devices_refused_immediately":
    "All of the store's terminals are refused at once.",
  "storeDeletion.effect.willChange.offer_packs_rebuilt":
    "The packs of the offers that include the store are rebuilt.",
  "storeDeletion.effect.willChange.single_store_members_lose_access":
    "Every member whose only store this is loses access to stores.",
  "storeDeletion.effect.willChange.count_readiness_excludes_store":
    "The store no longer counts toward count readiness.",
  "storeDeletion.effect.willChange.inventory_activation_excludes_store":
    "The store no longer counts toward inventory-effects activation.",
  "storeDeletion.effect.willNotChange.sales_unchanged": "Recorded sales stay as they are.",
  "storeDeletion.effect.willNotChange.shifts_unchanged": "Recorded shifts stay as they are.",
  "storeDeletion.effect.willNotChange.stock_movements_unchanged":
    "Stock movements stay as they are.",
  "storeDeletion.effect.willNotChange.erp_documents_unchanged":
    "No accounting document is created or changed.",
  "storeDeletion.effect.willNotChange.warehouse_mapping_kept":
    "The accounting warehouse mappings are kept.",
  "storeDeletion.effect.unknown":
    "Other changes the server reports that this screen does not show yet.",
  "storeDeletion.caveat.offline_facts_not_visible":
    "The server cannot see what a terminal has not synced yet: there may be unsent sales or movements.",
  "storeDeletion.caveat.queue_as_of_last_heartbeat":
    "Unsent-sale counts are as of each terminal's last signal, not live.",
  "storeDeletion.caveat.unknown": "The server does not see everything a terminal knows.",

  // --- The blockers, each with the link to its fix ---------------------------
  "storeDeletion.blockedIntro": "The store cannot be deleted now:",
  "storeDeletion.blocker.store_has_open_shift": {
    one: "The store has {count} open shift. Close it first.",
    other: "The store has {count} open shifts. Close them first.",
  },
  "storeDeletion.blocker.store_has_unretired_device": {
    one: "The store has {count} terminal that is not retired. Retire it first.",
    other: "The store has {count} terminals that are not retired. Retire them first.",
  },
  "storeDeletion.blocker.store_device_queue_unsynced": {
    one: "{count} terminal has sales that are not sent yet, or an unknown count. Open it to review.",
    other:
      "{count} terminals have sales that are not sent yet, or an unknown count. Open them to review.",
  },
  "storeDeletion.blocker.store_has_open_count_session": {
    one: "The store has {count} open count session. Finish it first.",
    other: "The store has {count} open count sessions. Finish them first.",
  },
  "storeDeletion.blocker.unknown": "This store cannot be deleted now.",
  "storeDeletion.link.device": "Open the terminal {label}",
  "storeDeletion.link.countSession": "Open count session {index}",

  // --- The confirm step ------------------------------------------------------
  "storeDeletion.reason.label": "Reason for deleting (required)",
  "storeDeletion.reason.help": "Up to 200 characters. Do not write personal data.",
  "storeDeletion.reason.required": "Write the reason for deleting.",
  "storeDeletion.reason.tooLong": "The reason is longer than 200 characters.",
  "storeDeletion.password.label": "Your current password",
  "storeDeletion.password.help": "To confirm it is you. The password is not kept.",
  "storeDeletion.needInputs": "Write the reason and the password to enable the confirmation.",
  "storeDeletion.cancel": "Cancel",
  "storeDeletion.commit": "Confirm deleting the store",
  "storeDeletion.committing": "Deleting the store…",
  "storeDeletion.backToList": "Back to stores",

  // --- Answers ---------------------------------------------------------------
  "storeDeletion.success": "The store is deleted.",
  "storeDeletion.successReplay": "This store is already deleted. Nothing changed.",
  "storeDeletion.stale":
    "The store changed since the check. Review the new check, then confirm again.",
  "storeDeletion.reauthRequired":
    "The password confirmation expired. Write the password again, then confirm.",
  "storeDeletion.retryable":
    "We could not confirm the delete was recorded. Try again with the same request; no second delete will happen.",
  "storeDeletion.session": "Your session ended. Sign in again to continue.",
  "storeDeletion.reauth.failed": "Could not verify who you are. Check the password and try again.",
  "storeDeletion.reauth.rateLimited": "Too many attempts. Wait a moment, then try again.",
  "storeDeletion.reauth.unavailable":
    "Could not verify the password now. Nothing was deleted. Try again later.",
  "storeDeletion.error.generic": "Could not delete the store. Nothing was deleted.",
  "storeDeletion.error.tenantUnavailable":
    "This organization is no longer available, so the store was not deleted.",
  "storeDeletion.error.ownerOnly": "Only the account owner can delete a store.",
  "storeDeletion.error.forbidden": "You do not have permission to delete this store.",
  "storeDeletion.error.notAvailable":
    "This action is not available for your access, or the store does not exist.",
  "storeDeletion.error.capReached":
    "The organisation has reached its hourly limit for these actions. Try later.",
  "storeDeletion.error.rateLimited": "Too many requests. Wait a moment, then try again.",
  "storeDeletion.error.validation":
    "The values entered are not accepted. Check the reason and try again.",
};
