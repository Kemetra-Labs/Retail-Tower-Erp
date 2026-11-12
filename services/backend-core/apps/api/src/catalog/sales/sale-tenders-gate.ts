/**
 * RT-77 deployment gate for tender acceptance on `captureSale`.
 *
 * The posting-feed INVARIANT (RT-76, RT-77 comment 10414): a work item for a
 * tender-bearing sale must never be offered to a Connector that cannot settle
 * it — a pre-RT-78 Connector posts it UNPAID and acks `posted`, which is
 * terminal. So tenders are accepted only once the API runs with
 * `POS_SALE_TENDERS_ENABLED=true`, a deploy step AFTER RT-78 is deployed.
 * Until then the capture pipe validates with the pre-RT-77 strict schema and a
 * body carrying `tenders` is the same 400 it is today — nothing is recorded.
 * Read per request (the `isPosReturnsEnabled` convention); accepts "1",
 * "true" or "yes", case-insensitive, trimmed.
 */
export function isPosSaleTendersEnabled(): boolean {
  return isEnvFlagOn("POS_SALE_TENDERS_ENABLED");
}

/**
 * RT-360 deployment gate for same-method split tenders (contract RT-359).
 *
 * The posting feed MUST NOT offer a sale carrying two tenders of one method
 * until the Connector has shown it settles such a sale exactly in ERPNext
 * (RT-361). So capture accepts them only once the API runs with
 * `POS_SALE_TENDERS_SAME_METHOD_ENABLED=true`, a deploy step AFTER RT-361, and
 * only while `POS_SALE_TENDERS_ENABLED` is on too. Until then at most one
 * tender per method is accepted, as before. Same parsing as above.
 */
export function isPosSaleTendersSameMethodEnabled(): boolean {
  return isEnvFlagOn("POS_SALE_TENDERS_SAME_METHOD_ENABLED");
}

/**
 * RT-1114 (RT-1098 R-4a) deployment gate for `voucher` tenders on `captureSale`.
 *
 * The posting-feed INVARIANT (RT-10 c10413): a voucher-tendered sale must never
 * be offered to a Connector that cannot settle it. A Connector without the
 * R-4b (RT-1330) voucher Mode of Payment refuses it, or worse, a pre-RT-1114
 * one could post it unpaid. So capture accepts a `voucher` tender only once the
 * API runs with `POS_SALE_VOUCHER_TENDER_ENABLED=true`, a deploy step AFTER
 * R-4b is deployed, and only while `POS_SALE_TENDERS_ENABLED` is on too. Until
 * then a `voucher` tender is the same 400 as any unknown method, and nothing
 * is recorded. Default OFF: RT-1114 builds this guard and does not turn it on
 * (acceptance criterion 2). Same parsing as above.
 */
export function isPosSaleVoucherTenderEnabled(): boolean {
  return isEnvFlagOn("POS_SALE_VOUCHER_TENDER_ENABLED");
}

/** A deployment flag: "1", "true" or "yes", case-insensitive, trimmed; anything else is off. */
export function isEnvFlagOn(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
