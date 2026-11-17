import type { forceActions as ar } from "../ar/forceActions";
import type { MessagesOf } from "../types";

/** English copy for the owner's force actions on a shift (RT-1437 A1, RT-1440 U1). Mirrors the Arabic keys. */
export const forceActions: MessagesOf<typeof ar> = {
  // --- Open shifts of a store ------------------------------------------------
  "forceActions.openShifts.title": "Open shifts",
  "forceActions.openShifts.sub": "Shifts open now in {store}, with the server's verdict on each.",
  "forceActions.openShifts.caption": "Open shifts in the store",
  "forceActions.openShifts.col.terminal": "Terminal",
  "forceActions.openShifts.col.cashier": "Cashier",
  "forceActions.openShifts.col.opened": "Opened",
  "forceActions.openShifts.col.verdict": "Verdict",
  "forceActions.openShifts.terminal.none": "Unlabelled terminal",
  "forceActions.openShifts.cashier.none": "Cashier with no name",
  "forceActions.openShifts.lastSeen": "Last seen: {time}",
  "forceActions.openShifts.neverSeen": "Never connected",
  "forceActions.openShifts.age": {
    one: "Age: {count} minute",
    other: "Age: {count} minutes",
  },
  "forceActions.openShifts.verdict.eligible": "Can be closed without a count now.",
  "forceActions.openShifts.verdict.blocked": "Cannot be closed from here now:",
  "forceActions.openShifts.empty": "No shifts are open in this store.",
  "forceActions.openShifts.loading": "Loading open shifts…",
  "forceActions.openShifts.loadFailed": "Could not load the open shifts.",
  "forceActions.openShifts.retry": "Try again",
  "forceActions.openShifts.notAvailable":
    "This page is not available for your access, or the store does not exist.",
  "forceActions.openShifts.snapshot":
    "As of {time}. This is a snapshot, not a reservation: the server decides again when you confirm.",
  "forceActions.openShifts.open": "Close without a count…",
  "forceActions.openShifts.openLabel": "Close the shift on {terminal} without a count…",

  // --- The device page: the next step for a blocked retire -------------------
  "forceActions.deviceLink": "View the store's open shifts to close one without a count",
  "forceActions.storeLink": "Open shifts in this store",

  // --- The close-without-a-count dialog --------------------------------------
  "forceActions.close.title": "Close the shift without a count",
  "forceActions.close.consequence":
    "This shift will be closed without counting the drawer. No counted amount and no variance will be recorded. Recorded sales and cash movements stay as they are. This cannot be undone.",
  "forceActions.close.drawerUnaccounted": "The drawer's real cash stays unaccounted for in the system.",
  "forceActions.close.loading": "Checking the shift…",
  "forceActions.close.previewFailed": "Could not check the shift. Nothing changed.",
  "forceActions.close.retry": "Try again",
  "forceActions.close.snapshot":
    "As of {time}. This is a snapshot, not a reservation: the server decides again when you confirm.",
  "forceActions.close.fact.opened": "Opened",
  "forceActions.close.fact.cashier": "Cashier",
  "forceActions.close.fact.terminal": "Terminal",
  "forceActions.close.fact.float": "Recorded opening float",
  "forceActions.close.fact.movements": "Recorded cash movements",
  "forceActions.close.fact.lastMovement": "Last movement received",
  "forceActions.close.fact.sales": "Sales recorded from this terminal since the shift opened",
  "forceActions.close.fact.refunds": "Refunds recorded from this terminal since the shift opened",
  "forceActions.close.fact.unknown": "Unknown",
  "forceActions.close.fact.none": "None",
  "forceActions.close.heading.willChange": "What will change",
  "forceActions.close.heading.willNotChange": "What will not change",
  "forceActions.close.effect.willChange.shift_closed_not_counted":
    "The shift is closed without counting the drawer.",
  "forceActions.close.effect.willChange.no_cash_up_recorded": "No cash-up and no variance is recorded.",
  "forceActions.close.effect.willChange.terminal_may_open_new_shift": "The terminal can open a new shift.",
  "forceActions.close.effect.willChange.device_retire_replace_move_unblocked":
    "Retiring, replacing and moving the device become possible.",
  "forceActions.close.effect.willChange.timezone_change_unblocked":
    "This shift no longer blocks changing the store's time zone.",
  "forceActions.close.effect.willNotChange.sales_unchanged": "Recorded sales stay as they are.",
  "forceActions.close.effect.willNotChange.refunds_unchanged": "Recorded refunds stay as they are.",
  "forceActions.close.effect.willNotChange.cash_movements_unchanged":
    "Recorded cash movements stay as they are.",
  "forceActions.close.effect.willNotChange.stock_unchanged": "Stock records stay as they are.",
  "forceActions.close.effect.willNotChange.erp_documents_unchanged":
    "No accounting document is created or edited.",
  "forceActions.close.caveat.offline_facts_not_visible":
    "The server cannot see what the terminal has not synced: unsent sales or movements may exist.",
  "forceActions.close.caveat.terminal_not_notified":
    "The terminal is not told about the close; it finds out when its request to close the shift is refused.",
  "forceActions.close.caveat.unknown": "The server cannot see everything the terminal knows.",
  "forceActions.close.effect.unknown": "Other changes the server reports that this screen does not describe yet.",
  "forceActions.close.blockedIntro": "It cannot be closed from here now:",
  "forceActions.close.blocker.shift_not_open": "The shift is no longer open.",
  "forceActions.close.blocker.not_stale": "The shift was opened a short while ago.",
  "forceActions.close.blocker.live_operator_session":
    "The terminal is still in use (an active cashier session). Close the shift from the terminal itself.",
  "forceActions.close.blocker.live_cashier_admission":
    "The terminal is still in use (an active cashier sign-in). Close the shift from the terminal itself.",
  "forceActions.close.blocker.unknown": "This shift cannot be closed from here now.",
  "forceActions.close.reason.label": "Reason for closing (required)",
  "forceActions.close.reason.help": "Up to 200 characters. Do not write personal data.",
  "forceActions.close.reason.required": "Write the reason for closing.",
  "forceActions.close.reason.tooLong": "The reason is longer than 200 characters.",
  "forceActions.close.acknowledge": "I understand that this drawer's cash will not be counted in the system.",
  "forceActions.close.needInputs": "Write the reason and confirm you understand to enable the confirmation.",
  "forceActions.close.cancel": "Cancel",
  "forceActions.close.commit": "Confirm closing the shift without a count",
  "forceActions.close.committing": "Closing the shift…",
  "forceActions.close.done": "Done",
  "forceActions.close.stale": "The shift changed since the check. Review the new check, then confirm.",
  "forceActions.close.settled.force_close": "This shift was already closed without a count. Nothing changed.",
  "forceActions.close.settled.cash_up":
    "This shift was already closed with a drawer count from the terminal itself. It does not need closing without a count.",
  "forceActions.close.retryable":
    "We could not confirm the close was recorded. Try again with the same request; a second close will not be recorded.",
  "forceActions.close.session": "Your sign-in expired. Sign in again to continue.",
  "forceActions.close.success": "The shift was closed without a count. No counted amount and no variance was recorded.",
  "forceActions.close.successReplay": "This shift is already closed without a count. Nothing changed.",
  "forceActions.close.error.generic": "Could not close the shift. Nothing was recorded.",
  "forceActions.close.error.readOnlySession": "A support session is read-only: the shift cannot be closed from it.",
  "forceActions.close.error.forbidden": "You do not have permission to close this shift.",
  "forceActions.close.error.notAvailable":
    "This action is not available for your access, or the shift does not exist.",
  "forceActions.close.error.capReached":
    "The organisation reached the hourly limit for these actions. Try again later.",
  "forceActions.close.error.rateLimited": "Too many requests. Wait a moment, then try again.",
  "forceActions.close.error.validation": "The values were not accepted. Check the reason and try again.",

  // --- Shifts closed without a count (A4, from the audit search) -------------
  "forceActions.closed.title": "Shifts closed without a count",
  "forceActions.closed.sub": "From the audit log: when the shift was closed, who closed it and in which store. The reason is stored with the record and is not shown here.",
  "forceActions.closed.caption": "Shifts closed without a count",
  "forceActions.closed.col.when": "When",
  "forceActions.closed.col.by": "Closed by",
  "forceActions.closed.col.channel": "Channel",
  "forceActions.closed.col.store": "Store",
  "forceActions.closed.col.shift": "Shift",
  "forceActions.closed.col.age": "Shift age",
  "forceActions.closed.channel.pos": "Point-of-sale terminal",
  "forceActions.closed.channel.console": "Console",
  "forceActions.closed.channel.unknown": "Unknown",
  "forceActions.closed.minutes": {
    one: "{count} minute",
    other: "{count} minutes",
  },
  "forceActions.closed.unknown": "Unknown",
  "forceActions.closed.empty": "No shifts were closed without a count.",
  "forceActions.closed.loading": "Loading the closes…",
  "forceActions.closed.loadFailed": "Could not load the closes without a count.",
  "forceActions.closed.retry": "Try again",
  "forceActions.closed.loadMore": "Load more",
  "forceActions.closed.notAvailable": "This page is not available for your access.",
};
