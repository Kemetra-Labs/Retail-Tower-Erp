import type { shell as ar } from "../ar/shell";
import type { MessagesOf } from "../types";

export const shell: MessagesOf<typeof ar> = {
  "shell.nav.label": "Primary",
  "shell.sidebar.label": "Scope and navigation",
  "shell.nav.overview": "Overview",
  // RT-995 (D-V9): the label of the first, daily-operations nav group, shown in the list band.
  "shell.nav.section.operations": "Operations",
  "shell.nav.section.management": "Management",
  "shell.nav.tenants": "Tenants",
  "shell.nav.stores": "Stores",
  "shell.nav.operators": "Operators",
  "shell.nav.audit": "Audit",
  "shell.nav.stockDiscrepancies": "Stock discrepancies",
  "shell.nav.shiftCloses": "Shift closes",
  "shell.nav.unknownItems": "Unknown items",
  "shell.skipToContent": "Skip to content",
  "shell.signOut": "Sign out",
  "shell.menu": "Menu",

  "shell.overview.title": "Overview",
  "shell.overview.scope": "{tenant} · {store}",

  "shell.scope.menuGroup": "STORE · {tenant}",
  "shell.scope.allStores": "All stores",
  "shell.scope.loading": "Loading stores…",
  "shell.scope.loadFailed": "Couldn't load stores.",
  "shell.scope.noStores": "No stores you can open in this tenant.",
  "shell.scope.announce": "Now working in {tenant}, {store}.",
  "shell.scope.in": " in ",

  "shell.navigator.open": "Go to a page or store",
  "shell.navigator.title": "Go to",
  "shell.navigator.input": "Page or store name",
  "shell.navigator.pages": "Pages",
  "shell.navigator.stores": "Stores",
  "shell.navigator.current": "(current)",
  "shell.navigator.empty": "No page or store matches “{query}”.",
  "shell.userMenu.prefs": "Preferences",
  "shell.userMenu.account": "My account",

  "shell.gate.title": "Select your context",
  "shell.gate.sub": "Choose a tenant to continue.",
  "shell.gate.searchPlaceholder": "Search tenants…",
  "shell.gate.searchLabel": "Search tenants",
  "shell.gate.listLabel": "Available tenants",

  "shell.mismatch.label": "Scope",
  "shell.mismatch.message":
    "This link is for a different store. You are working in {store}, and your scope was not changed.",
  "shell.mismatch.switch": "Switch to this store",
  "shell.mismatch.stay": "Stay in {store}",

  "shell.leave.title": "Leave without saving?",
  "shell.leave.desc": "This page has changes that are not saved. If you leave, they are lost.",
  "shell.leave.stay": "Stay on this page",
  "shell.leave.discard": "Discard changes",

  "components.banner.requestRef": "request_id: {id}",
  "components.list.loading": "Loading {label}…",
  "components.list.loadingDefault": "items",
  "components.confirmDelete.label": "Confirm: {action}",
  "components.confirmDelete.prompt": "{action} {name}? It can be restored by an administrator.",
  "components.errorSummary.title": {
    one: "{count} problem needs fixing",
    other: "{count} problems need fixing",
  },

  "platform.label": "Platform",
  "platform.nav.label": "Platform",
  "platform.nav.tenants": "Organizations",
  "platform.tenants.emptyTitle": "No organizations",
  "platform.tenants.emptyBody": "There are no organizations on the platform to show yet.",
  "platform.noAccess.title": "Not available",
  "platform.noAccess.body": "This page isn't available for your account.",
  "platform.noAccess.home": "Back to home",
};
