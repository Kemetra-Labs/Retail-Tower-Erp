import type { VouchersAdminSchema } from "@/generated/schema";
import type { MessageKey } from "@/i18n";
/**
 * RT-1109 vouchers page: pure helpers. No client, no React.
 *
 * - Access mirrors the contract's roles (decision 2A): `owner` and
 *   `tenant_admin` only. The nav entry and the page gate follow it; the server
 *   stays the authority.
 * - Keyset paging: "no more" is a null cursor, never an empty page.
 * - Money arrives as integer minor units plus `currency_code`; it is shown with
 *   the house money format (`1,250.00 EGP`), with no float on the way.
 * - The codes CSV is built only from the issue 201 body, in memory. A code is
 *   never read back from the server (no read response has one).
 */
import { formatMoney } from "@/i18n/format";

type Schemas = VouchersAdminSchema.components["schemas"];

export type VoucherRow = Schemas["Voucher"];
export type VoucherListPage = Schemas["VoucherPage"];
export type VoucherStatus = Schemas["VoucherStatus"];
export type VoucherIssueResponse = Schemas["VoucherIssueResponse"];

export const VOUCHER_STATUSES: readonly VoucherStatus[] = [
  "active",
  "redeemed",
  "cancelled",
  "expired",
];

const ROLES = ["owner", "tenant_admin"] as const;

export function canReadVouchers(role: string | null | undefined): boolean {
  return (ROLES as readonly string[]).includes(role ?? "");
}

/** getNextPageParam rule: a null cursor ends the walk. */
export function nextVoucherCursor(page: VoucherListPage): string | undefined {
  return page.next_cursor ?? undefined;
}

/** One row per voucher across pages, where it first appeared (a keyset walk is not a snapshot). */
export function flattenVoucherPages(pages: readonly VoucherListPage[]): VoucherRow[] {
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.items)
    .filter((row) => {
      if (seen.has(row.voucher_id)) return false;
      seen.add(row.voucher_id);
      return true;
    });
}

const STATUS_KEYS: Record<VoucherStatus, MessageKey> = {
  active: "vouchers.status.active",
  redeemed: "vouchers.status.redeemed",
  cancelled: "vouchers.status.cancelled",
  expired: "vouchers.status.expired",
};

/** The label key for an effective status; a status this build does not know reads as unknown. */
export function voucherStatusKey(status: string): MessageKey {
  return Object.hasOwn(STATUS_KEYS, status)
    ? STATUS_KEYS[status as VoucherStatus]
    : "vouchers.status.unknown";
}

/**
 * Cancel applies to a voucher that is stored `active`, whether or not its expiry
 * has passed (decision 5A). `expired` is a derived read of a stored `active`.
 */
export function canCancelVoucher(status: string): boolean {
  return status === "active" || status === "expired";
}

/** Minor units → the exact decimal string `formatMoney` takes (`12345`, 2 → `123.45`). */
export function minorToDecimal(amountMinor: number, digits: number): string {
  if (!Number.isSafeInteger(amountMinor)) return String(amountMinor);
  const sign = amountMinor < 0 ? "-" : "";
  const raw = Math.abs(amountMinor).toString();
  if (digits <= 0) return `${sign}${raw}`;
  const padded = raw.padStart(digits + 1, "0");
  return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/** The ISO 4217 minor-unit digits of a currency (EGP: 2); 2 when Intl does not know it. */
export function currencyDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits;
    return typeof digits === "number" ? digits : 2;
  } catch {
    return 2;
  }
}

/** `amount_minor` + `currency_code` → `1,250.00 EGP`. */
export function formatVoucherAmount(amountMinor: number, currency: string): string {
  return formatMoney(minorToDecimal(amountMinor, currencyDigits(currency)), currency);
}

/** Where a voucher is valid: every store, or a listed subset (named when the roster knows it). */
export type VoucherEligibility =
  | { kind: "all" }
  | { kind: "stores"; names: string[]; unnamed: number };

export function voucherEligibility(
  row: Pick<VoucherRow, "applies_to_all_stores" | "eligible_store_ids">,
  stores: readonly { id: string; name?: string }[],
): VoucherEligibility {
  if (row.applies_to_all_stores) return { kind: "all" };
  const names: string[] = [];
  let unnamed = 0;
  for (const id of row.eligible_store_ids) {
    const name = stores.find((s) => s.id === id)?.name;
    if (name) names.push(name);
    else unnamed += 1;
  }
  return { kind: "stores", names, unnamed };
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The codes file for one issued batch, built only from the 201 body, in memory.
 * Machine columns (no translated headers), so a spreadsheet or a printer job
 * reads it the same way in either locale. Amounts stay exact decimals.
 */
export function buildCodesCsv(batch: VoucherIssueResponse): string {
  const header = ["batch_id", "voucher_id", "code", "amount", "currency_code", "expires_at"];
  const lines = batch.vouchers.map((v) =>
    [
      batch.batch_id,
      v.voucher_id,
      v.code,
      minorToDecimal(v.amount_minor, currencyDigits(v.currency_code)),
      v.currency_code,
      v.expires_at ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}
