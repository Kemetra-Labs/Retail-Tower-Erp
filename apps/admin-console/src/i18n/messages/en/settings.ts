import type { settings as ar } from "../ar/settings";
import type { MessagesOf } from "../types";

/**
 * RF-7 — Settings: the destination that gathers the tenant's existing sections
 * (branding, shift variance policy, AI plan, batch selling) instead of duplicating them.
 */
export const settings: MessagesOf<typeof ar> = {
  "settings.nav.label": "Settings",
  "settings.title": "Settings",
  "settings.sub":
    "Settings for the active tenant: branding, the shift variance policy, the AI plan, and batch selling.",
  "settings.noTenant": "Choose a tenant first to see its settings.",
  "settings.quick.title": "Quick links",
};
