/**
 * RT-1109 issue form: pure draft → `VoucherIssueRequest`. A fail-fast guard
 * for what the contract constrains; the server stays authoritative.
 *
 * - `count`: an integer from 1 to 100 (decision 3A).
 * - value: typed in major units («50» or «50.25», Arabic-Indic digits and «٫»
 *   accepted), sent as integer minor units of the tenant currency. More decimals
 *   than the currency has is refused rather than rounded.
 * - expiry: optional, a local date-time that must be in the future; sent as UTC.
 * - eligibility: all stores, or a non-empty subset of at most 100 stores.
 * - note: optional, at most 200 characters.
 *
 * Errors are message keys (plus params), translated at render time.
 */
import type { MessageKey, Params } from "@/i18n";
import type { VoucherIssueBody } from "@/lib/client";
import { normalizeLevel } from "@/stock-levels/stockLevelLogic";

export const MAX_COUNT = 100;
const MAX_STORES = 100;
const NOTE_MAX = 200;

export interface VoucherIssueDraft {
  count: string;
  amount: string;
  /** `datetime-local` value (`2026-12-31T23:59`), or "" for no expiry. */
  expiresAt: string;
  scope: "all" | "stores";
  storeIds: readonly string[];
  note: string;
}

interface VoucherFieldError {
  messageKey: MessageKey;
  params?: Params;
}

type VoucherDraftField = "count" | "amount" | "expiresAt" | "storeIds" | "note";
export type VoucherDraftErrors = Partial<Record<VoucherDraftField, VoucherFieldError>>;

export type VoucherDraftResult =
  | { ok: true; body: VoucherIssueBody }
  | { ok: false; errors: VoucherDraftErrors };

function parseCount(raw: string): number | VoucherFieldError {
  const value = normalizeLevel(raw);
  if (!/^\d{1,3}$/.test(value))
    return { messageKey: "vouchers.form.countInvalid", params: { max: MAX_COUNT } };
  const count = Number.parseInt(value, 10);
  return count >= 1 && count <= MAX_COUNT
    ? count
    : { messageKey: "vouchers.form.countInvalid", params: { max: MAX_COUNT } };
}

/** «50.25» with 2 currency digits → 5025. Exact: string arithmetic, no float. */
function parseAmount(raw: string, digits: number): number | VoucherFieldError {
  const value = normalizeLevel(raw);
  if (value === "") return { messageKey: "vouchers.form.amountRequired" };
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(value);
  if (!match) return { messageKey: "vouchers.form.amountInvalid" };
  const [, int, frac = ""] = match;
  if (frac.length > digits) {
    return { messageKey: "vouchers.form.amountPrecision", params: { digits } };
  }
  const minor = Number.parseInt(`${int}${frac.padEnd(digits, "0")}`, 10);
  if (!Number.isSafeInteger(minor)) return { messageKey: "vouchers.form.amountInvalid" };
  return minor >= 1 ? minor : { messageKey: "vouchers.form.amountInvalid" };
}

function parseExpiry(raw: string, now: Date): string | null | VoucherFieldError {
  if (raw.trim() === "") return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { messageKey: "vouchers.form.expiryInvalid" };
  return at.getTime() > now.getTime()
    ? at.toISOString()
    : { messageKey: "vouchers.form.expiryPast" };
}

function isError(value: unknown): value is VoucherFieldError {
  return typeof value === "object" && value !== null && "messageKey" in value;
}

/**
 * Validate the draft and build the request body. `digits` is the tenant
 * currency's minor-unit count (2 for EGP); `now` is injectable for tests.
 */
export function buildIssueBody(
  draft: VoucherIssueDraft,
  digits: number,
  now: Date = new Date(),
): VoucherDraftResult {
  const errors: VoucherDraftErrors = {};
  const count = parseCount(draft.count);
  if (isError(count)) errors.count = count;
  const amount = parseAmount(draft.amount, digits);
  if (isError(amount)) errors.amount = amount;
  const expiresAt = parseExpiry(draft.expiresAt, now);
  if (isError(expiresAt)) errors.expiresAt = expiresAt;

  const storeIds = [...new Set(draft.storeIds)];
  if (draft.scope === "stores") {
    if (storeIds.length === 0) errors.storeIds = { messageKey: "vouchers.form.storesRequired" };
    else if (storeIds.length > MAX_STORES) {
      errors.storeIds = { messageKey: "vouchers.form.storesTooMany", params: { max: MAX_STORES } };
    }
  }

  const note = draft.note.trim();
  if (note.length > NOTE_MAX) {
    errors.note = { messageKey: "vouchers.form.noteTooLong", params: { max: NOTE_MAX } };
  }

  if (isError(count) || isError(amount) || isError(expiresAt) || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const body: VoucherIssueBody = {
    count,
    amount_minor: amount,
    expires_at: expiresAt,
    applies_to_all_stores: draft.scope === "all",
    note: note === "" ? null : note,
  };
  if (draft.scope === "stores") body.eligible_store_ids = storeIds;
  return { ok: true, body };
}
