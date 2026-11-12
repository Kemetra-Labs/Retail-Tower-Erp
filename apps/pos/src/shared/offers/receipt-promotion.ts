/**
 * RT-1339 (RT-286 S7) — the receipt view of a frozen sale-line `promotion`.
 *
 * Only the offer's Arabic name, its percent and the line's discount reach the slip
 * and the preview bridge; the offer id, version and Pack revision stay in main.
 */
import type { ReceiptLinePromotion } from '../receipts/types.js';

/** The receipt view of a frozen `promotion`, or null when it is not a valid one. */
export function readReceiptLinePromotion(value: unknown): ReceiptLinePromotion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { offer_name_ar, percent_off, discount_minor } = value as Record<string, unknown>;
  if (
    typeof offer_name_ar !== 'string' ||
    offer_name_ar.length < 1 ||
    offer_name_ar.length > 120 ||
    typeof percent_off !== 'number' ||
    !Number.isInteger(percent_off) ||
    percent_off < 1 ||
    percent_off > 100 ||
    typeof discount_minor !== 'number' ||
    !Number.isSafeInteger(discount_minor) ||
    discount_minor < 0
  ) {
    return null;
  }
  return { offer_name_ar, percent_off, discount_minor };
}
