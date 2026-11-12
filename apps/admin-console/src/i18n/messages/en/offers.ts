import type { offers as ar } from "../ar/offers";
import type { MessagesOf } from "../types";

export const offers: MessagesOf<typeof ar> = {
  "offers.nav.label": "Offers",

  // --- States ---------------------------------------------------------------
  "offers.state.draft": "Draft",
  "offers.state.scheduled": "Scheduled",
  "offers.state.active": "Active",
  "offers.state.paused": "Paused",
  "offers.state.ended": "Ended",
  "offers.state.archived": "Archived",
  "offers.state.unknown": "Unknown state",
  "offers.offline.allow_cached": "Works offline from the last offer pack",
  "offers.offline.online_only": "Works only when online",
  "offers.schedule.open": "no end",
  "offers.schedule.storeLocal": "store time",
  "offers.scope.all": "All stores",
  "offers.scope.unnamed": {
    one: "{count} other store",
    other: "{count} other stores",
  },

  // --- List -----------------------------------------------------------------
  "offers.list.title": "Offers",
  "offers.list.subtitle":
    "Buy-and-get-a-discount offers applied automatically at checkout in {tenant}'s stores.",
  "offers.list.scopePrompt": "Choose a tenant to manage its offers.",
  "offers.list.create": "New offer",
  "offers.list.caption": "Offers, newest first",
  "offers.list.loadingNoun": "offers",
  "offers.list.empty": "This tenant has no offers yet.",
  "offers.list.emptyFiltered": "No offers in this state.",
  "offers.list.loadMore": "Load more",
  "offers.list.loadFailed": "Couldn't load the offers.",
  "offers.list.ownStoresNote": "Only offers that cover your stores are shown here.",
  "offers.list.col.name": "Offer",
  "offers.list.col.state": "State",
  "offers.list.col.schedule": "Schedule",
  "offers.list.col.stores": "Stores",
  "offers.list.col.version": "Version",
  "offers.list.col.actions": "Actions",
  "offers.list.hasDraft": "Draft in progress",
  "offers.list.open": "Open",
  "offers.list.openLabel": "Open the offer {name}",
  "offers.filters.label": "Offer filters",
  "offers.filters.state": "State",
  "offers.filters.stateAny": "All listed states",

  // --- Page -----------------------------------------------------------------
  "offers.page.title": "Offer",
  "offers.page.newTitle": "New offer",
  "offers.page.subtitle":
    "An automatic offer in {tenant}'s stores. Results are worked out by the server, not on this screen.",
  "offers.page.back": "Back to offers",
  "offers.page.loadingNoun": "offer",
  "offers.page.loadFailed": "Couldn't load the offer.",
  "offers.page.notFound": "This offer doesn't exist or you can't see it.",

  // --- Form -----------------------------------------------------------------
  "offers.form.section.basics": "Name",
  "offers.form.section.deal": "Discount",
  "offers.form.section.stores": "Stores",
  "offers.form.section.schedule": "Schedule",
  "offers.form.section.offline": "Working offline",
  "offers.form.nameAr": "Name in Arabic",
  "offers.form.nameEn": "Name in English",
  "offers.form.nameEnHint": "Optional. Shown when English is chosen.",
  "offers.form.formula": "Buy X, get Y more at P% off. The discount goes to the cheapest items.",
  "offers.form.buy": "Buy (X)",
  "offers.form.buyHint": "A whole number from 1 to {max}.",
  "offers.form.get": "Get (Y)",
  "offers.form.getHint": "A whole number from 1 to {max}.",
  "offers.form.percent": "Percent off (P%)",
  "offers.form.percentHint": "A whole number from 1 to 100. 100 means free.",
  "offers.form.max": "Most applications per sale",
  "offers.form.maxHint": "Leave empty for no limit, or a whole number from 1 to {max}.",
  "offers.form.scopeAll": "All of the tenant's stores",
  "offers.form.scopeStores": "Chosen stores",
  "offers.form.boundedScope":
    "Your access covers specific stores, so you can't create an offer for all stores.",
  "offers.form.noStores": "There are no stores to choose.",
  "offers.form.starts": "Starts at",
  "offers.form.ends": "Ends at",
  "offers.form.timeHint": "In each store's own time.",
  "offers.form.endsHint": "Optional. Leave empty for no end.",
  "offers.form.absoluteNote":
    "This offer's schedule used absolute times. Saving it from here stores it in store time.",
  "offers.form.offline": "When a store is offline",
  "offers.form.offlineHint":
    "Whether the till applies the offer from the last offer pack it received when it can't reach the server.",
  "offers.form.error.nameArRequired": "Enter the offer name in Arabic.",
  "offers.form.error.nameTooLong": "The name is longer than {max} characters.",
  "offers.form.error.wholeNumber": "Enter a whole number from 1 to {max}.",
  "offers.form.error.percent": "Enter a whole percent from 1 to 100.",
  "offers.form.error.includeRequired":
    "Choose at least one item, category or brand for the offer to include.",
  "offers.form.error.tooManyRules": "More items, categories or brands are chosen than allowed.",
  "offers.form.error.allStoresNotAllowed":
    "You can't create an offer for all stores. Choose your stores.",
  "offers.form.error.storesRequired": "Choose at least one store.",
  "offers.form.error.tooManyStores": "Choose at most {max} stores.",
  "offers.form.error.startRequired": "Set the start time.",
  "offers.form.error.endInvalid": "The end time isn't valid.",
  "offers.form.error.endBeforeStart": "The offer must end after it starts.",

  // --- Rules ----------------------------------------------------------------
  "offers.rules.title": "What the offer covers",
  "offers.rules.exclusionWins":
    "Exclusion always wins: an item that matches any exclude rule is not in the offer, even if it matches an include rule. The server works out the eligible items; you see them in the preview before publishing.",
  "offers.rules.include.title": "Include",
  "offers.rules.include.hint":
    "An item that matches any rule here is in the offer. Choose at least one rule.",
  "offers.rules.include.noProducts": "No specific items added.",
  "offers.rules.include.addProduct": "Add an item to include",
  "offers.rules.exclude.title": "Exclude",
  "offers.rules.exclude.hint":
    "An item that matches any rule here is not in the offer. Exclusion wins over inclusion.",
  "offers.rules.exclude.noProducts": "No excluded items added.",
  "offers.rules.exclude.addProduct": "Add an item to exclude",
  "offers.rules.products": "Specific items",
  "offers.rules.categories": "Categories",
  "offers.rules.brands": "Brands",
  "offers.rules.noneAvailable": "Nothing to choose.",
  "offers.rules.unavailable": "Unavailable (removed from the catalog)",
  "offers.rules.selected": "Selected",
  "offers.rules.unavailableItem": "Unavailable item",
  "offers.rules.removeProduct": "Remove the item {name}",
  "offers.rules.doneAdding": "Done",
  "offers.rules.moreProducts": {
    one: "{count} more item",
    other: "{count} more items",
  },

  // --- Save, preview, publish -------------------------------------------------
  "offers.save.action": "Save draft",
  "offers.save.done": "The draft was saved.",
  "offers.publish.title": "Preview and publish",
  "offers.publish.action": "Publish",
  "offers.publish.done":
    "The offer was published. Tills apply it when they receive the new offer pack.",
  "offers.publish.hintSave": "Save the draft first to preview it.",
  "offers.publish.hintPreview": "Preview the saved draft before publishing.",
  "offers.preview.run": "Validate and preview",
  "offers.preview.done": "Previewed.",
  "offers.preview.publishable": "The draft can be published now.",
  "offers.preview.blocked": "The draft can't be published now. See the issues below.",
  "offers.preview.issues": "Issues that block publishing",
  "offers.preview.eligible": "Eligible items",
  "offers.preview.eligibleCount": {
    one: "{count} eligible item",
    other: "{count} eligible items",
  },
  "offers.preview.sampleHint": "A sample of up to {shown} items.",
  "offers.preview.conflicts": "Conflicts with other offers",
  "offers.preview.conflictsHint":
    "An item can be in only one offer per store. End the other offer or change this offer's rules.",
  "offers.preview.sharedProducts": {
    one: "{count} shared item",
    other: "{count} shared items",
  },
  "offers.issue.offer_reference_invalid":
    "A rule points to an item, category, brand or store that doesn't exist or was deleted.",
  "offers.issue.offer_eligible_set_empty": "The offer matches no active item.",
  "offers.issue.offer_eligible_set_too_large":
    "More items are eligible than an offer pack can hold.",
  "offers.issue.offer_schedule_elapsed":
    "The offer's end time has already passed in all of its stores.",
  "offers.issue.offer_store_offer_limit_exceeded":
    "A store would exceed the maximum number of live offers.",
  "offers.issue.unknown": "An unknown issue blocks publishing.",

  // --- Simulation -----------------------------------------------------------
  "offers.sim.title": "Cart simulation",
  "offers.sim.hint":
    "Enter unit prices in {currency} to see the result the tills will work out. A simulation changes nothing.",
  "offers.sim.price": "Unit price, line {n}",
  "offers.sim.quantity": "Quantity, line {n}",
  "offers.sim.addLine": "Add a line",
  "offers.sim.remove": "Remove",
  "offers.sim.removeLine": "Remove line {n}",
  "offers.sim.run": "Run simulation",
  "offers.sim.summary": "Applications: {applications}. Total discount: {discount}. Total: {total}.",
  "offers.sim.resultCaption": "Cart simulation result",
  "offers.sim.col.line": "Line",
  "offers.sim.col.price": "Unit price",
  "offers.sim.col.quantity": "Quantity",
  "offers.sim.col.eligible": "Eligible",
  "offers.sim.col.discount": "Discount",
  "offers.sim.col.amount": "Line amount",
  "offers.sim.yes": "Yes",
  "offers.sim.no": "No",
  "offers.sim.error.price": "Enter a valid price, with up to four decimals.",
  "offers.sim.error.quantity": "Quantity is from 1 to 999.",
  "offers.sim.error.noLines": "Add at least one line.",
  "offers.sim.error.tooManyLines": "A cart has up to 100 lines.",

  // --- Facts ----------------------------------------------------------------
  "offers.facts.state": "State",
  "offers.facts.published": "Published version",
  "offers.facts.neverPublished": "Not published yet",
  "offers.facts.version": "Version {version}",
  "offers.facts.currentVersion": "current",
  "offers.facts.versions": "Published versions",
  "offers.facts.schedule": "Schedule",
  "offers.facts.stores": "Stores",
  "offers.facts.draft": "Draft",
  "offers.facts.draftRevision": "Revision {revision}",
  "offers.facts.noDraft": "No draft",
  "offers.facts.endedAt": "Ended at",
  "offers.facts.archivedAt": "Archived at",
  "offers.facts.ownStoresNote":
    "The stores and pauses shown here are yours only; other stores may exist that you can't see.",
  "offers.facts.pauses": "Pauses",
  "offers.facts.wholePause": "The whole offer is paused",
  "offers.facts.resumeStore": "Resume",
  "offers.facts.resumeStoreLabel": "Resume the offer in {name}",
  "offers.facts.removed": "Items removed from offers by a catalog change",
  "offers.facts.removedHint":
    "After a catalog change an item was wanted by two offers; it stayed in the older one and left the newer one.",

  // --- Lifecycle ------------------------------------------------------------
  "offers.lifecycle.title": "Manage the offer",
  "offers.lifecycle.keep": "Keep the offer as it is",
  "offers.pause.open": "Pause",
  "offers.pause.title": "Pause the offer",
  "offers.pause.note":
    "An emergency pause. The offer leaves the offer pack at once and no history is deleted. The reason is recorded in the audit log.",
  "offers.pause.reason": "Reason for pausing",
  "offers.pause.reasonHint": "Required, up to {max} characters. Don't write personal data.",
  "offers.pause.scope": "What to pause",
  "offers.pause.scopeWhole": "The whole offer in all stores",
  "offers.pause.scopeStores": "Chosen stores",
  "offers.pause.scopeOwnStores": "My stores",
  "offers.pause.noStores": "There are no stores where you can pause this offer.",
  "offers.pause.confirm": "Pause",
  "offers.pause.done": "The offer was paused.",
  "offers.pause.error.reasonRequired": "Enter the reason for pausing.",
  "offers.pause.error.reasonTooLong": "The reason is longer than 500 characters.",
  "offers.pause.error.storesRequired": "Choose at least one store.",
  "offers.resume.open": "Resume",
  "offers.resume.prompt":
    "The pause is lifted in every store. Conflicts with other offers are checked again before it returns.",
  "offers.resume.confirm": "Resume the offer",
  "offers.resume.done": "The offer was resumed.",
  "offers.end.open": "End offer",
  "offers.end.prompt":
    "The offer ends now and leaves the offer pack. It can't be brought back; create a new offer instead. Earlier sales keep their data.",
  "offers.end.confirm": "End the offer",
  "offers.end.done": "The offer ended.",
  "offers.archive.open": "Archive",
  "offers.archive.prompt":
    "The offer disappears from the default offer list. All its versions and the data of earlier sales stay.",
  "offers.archive.confirm": "Archive the offer",
  "offers.archive.done": "The offer was archived.",

  // --- Errors ---------------------------------------------------------------
  "offers.error.validation": "The server refused these values. Check the fields and try again.",
  "offers.error.session": "Your session ended. Sign in again.",
  "offers.error.forbidden": "You don't have permission for this action.",
  "offers.error.origin":
    "The request was refused because its origin isn't trusted. Reload the page and try again.",
  "offers.error.notFound": "This offer doesn't exist or you can't see it.",
  "offers.error.storeNotFound": "One of the stores isn't available to you.",
  "offers.error.storeNotInScope":
    "One of the chosen stores isn't in this offer's scope or isn't paused there.",
  "offers.error.staleSave":
    "Someone else changed this draft after you opened it, so your changes were not saved. What you typed is still here; copy it, then reload the page to see the newer version.",
  "offers.error.stale":
    "The draft changed since you opened it. The offer was reloaded; review it and try again.",
  "offers.error.stateInvalid": "The offer's state doesn't allow this now. It was reloaded.",
  "offers.error.conflict": "Not done: the offer conflicts with other live or paused offers.",
  "offers.error.rateLimited": "Too many requests. Wait a moment and try again.",
  "offers.error.uncertain":
    "No clear answer came back, and the request may have been carried out. Press again; it won't run twice.",
  "offers.error.generic": "Couldn't carry out the request. Try again.",
};
