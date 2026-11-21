/**
 * RT-1034 — the sync-failure alert email. Pure; no I/O.
 *
 * Content is allowlisted (research memo S11): the store name, the condition and the open count.
 * No sale, customer, payment or posting payload, no recipient identity. `tags` carry only a stable
 * template id and the condition key (never PII).
 */

/**
 * The message the alert hands to a sender. Structurally the worker's `EmailMessage`; declared here so
 * this module imports nothing from `email/` or `observability/` (the import-cycle ratchet, RT-1454).
 */
export interface AlertEmail {
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export type SyncFailureCondition = "posting_permanently_rejected" | "sale_failed_needs_repair";

export interface SyncFailureAlertContent {
  readonly to: string;
  readonly storeName: string;
  readonly condition: SyncFailureCondition;
  readonly failureCount: number;
}

const CONDITION_TEXT: Readonly<Record<SyncFailureCondition, string>> = {
  posting_permanently_rejected: "were permanently rejected by the ERP posting",
  sale_failed_needs_repair: "failed to sync and need repair",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderSyncFailureAlertEmail(content: SyncFailureAlertContent): AlertEmail {
  const what = CONDITION_TEXT[content.condition];
  const lead = `${content.failureCount} sale record(s) at ${content.storeName} ${what}.`;
  const next = "Open the Retail Tower Console sync pages to review them. You receive this once until the condition clears.";
  return {
    to: content.to,
    subject: `Retail Tower: sync failure at ${content.storeName}`,
    textBody: `${lead}\n\n${next}`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(next)}</p>`,
    tags: { template_id: "alerts.sync-failure", condition: content.condition },
  };
}
