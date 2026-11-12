import type { brands as ar } from "../ar/brands";
import type { MessagesOf } from "../types";

export const brands: MessagesOf<typeof ar> = {
  "brands.nav.label": "Brands",

  // --- List -----------------------------------------------------------------
  "brands.list.title": "Brands",
  "brands.list.subtitle": "The brands that classify {tenant}'s items. Each item has one brand.",
  "brands.list.scopePrompt": "Choose a tenant to manage its brands.",
  "brands.list.create": "Add brand",
  "brands.list.caption": "Brands, ordered by name",
  "brands.list.loadingNoun": "brands",
  "brands.list.empty": "This tenant has no brands yet.",
  "brands.list.loadFailed": "Couldn't load the brands.",
  "brands.list.retry": "Try again",
  "brands.list.col.name": "Name",
  "brands.list.col.updated": "Last updated",
  "brands.list.col.actions": "Actions",
  "brands.list.rename": "Rename",
  "brands.list.renameLabel": "Rename the brand {name}",

  // --- Form -----------------------------------------------------------------
  "brands.form.createTitle": "Add brand",
  "brands.form.renameTitle": "Rename brand",
  "brands.form.name": "Name",
  "brands.form.nameHint":
    "Up to {max} characters. A name is not repeated among the tenant's brands.",
  "brands.form.nameRequired": "Enter the brand name.",
  "brands.form.nameTooLong": "The brand name is longer than allowed.",
  "brands.form.nameTaken": "A brand with this name already exists.",
  "brands.form.saveCreate": "Add brand",
  "brands.form.saveRename": "Save name",

  // --- Write outcomes ---------------------------------------------------------
  "brands.write.error.validation": "The server refused the name. Check it and try again.",
  "brands.write.error.session": "Your session ended. Sign in again.",
  "brands.write.error.forbidden": "You don't have permission to change brands.",
  "brands.write.error.rateLimited": "Too many requests. Wait a moment and try again.",
  "brands.write.error.stale":
    "This brand changed since you opened it. The list was reloaded: open it again and retry.",
  "brands.write.error.gone": "This brand no longer exists. The list was reloaded.",
  "brands.write.error.uncertain":
    "No clear answer came back, and the request may have been carried out. Press save again; it won't run twice.",
  "brands.write.error.generic": "Couldn't save the brand. Try again.",
};
