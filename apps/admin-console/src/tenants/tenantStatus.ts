/**
 * The tenant status badge: its label key and its colour role. The status code
 * drives the label; the raw code is never the copy (UX-12). An unrecognised
 * code reads as unknown, in the danger role (RT-956, DESIGN.md §3).
 */
import type { MessageKey } from "@/i18n";

const STATUS_CLASS: Record<string, string> = {
  active: "badge badge--success",
  suspended: "badge badge--warning",
  pending: "badge badge--pending",
};

const STATUS_LABEL: Record<string, MessageKey> = {
  active: "tenants.status.active",
  suspended: "tenants.status.suspended",
  pending: "tenants.status.pending",
};

export function tenantStatusClass(status: string): string {
  return Object.hasOwn(STATUS_CLASS, status) ? STATUS_CLASS[status] : "badge badge--danger";
}

export function tenantStatusLabel(status: string): MessageKey {
  return Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : "tenants.status.unknown";
}
