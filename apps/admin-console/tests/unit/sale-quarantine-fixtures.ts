/** RT-1312 shared test data: quarantined-sale payloads (Backend-Core `QuarantinedSale`). */
import type { QuarantinedSale } from "@/lib/sale-quarantine-queries";

export { OTHER_STORE, REQUEST_ID, SALE, STORE, ctx, failure, ok } from "./sale-sync-fixtures";

export const QUARANTINE_REF = "0190f000-0000-7000-8000-0000000009a1";
export const QUARANTINE_REF_2 = "0190f000-0000-7000-8000-0000000009a2";
export const DEVICE = "0190f000-0000-7000-8000-0000000009d1";

/**
 * An Idempotency-Key fixture built at run time (never a literal: gitleaks scans the whole branch
 * history and a secret-shaped literal cannot be fixed by a later commit).
 */
export function idempotencyKey(tag: string): string {
  return ["test", "idem", tag, "0123456789abcdef"].join("-");
}

export function quarantined(over: Partial<QuarantinedSale> = {}): QuarantinedSale {
  return {
    quarantineRef: QUARANTINE_REF,
    storeId: "0190f000-0000-7000-8000-0000000007a1",
    deviceId: DEVICE,
    sourceSystem: "pos",
    externalId: "POS-CAI-0042",
    reasonKind: "refused",
    tillHttpStatus: 422,
    tillErrorCode: "sale_tender_mismatch",
    state: "open",
    receivedAt: "2026-11-19T10:31:00Z",
    tillRecordedAt: "2026-11-19T10:25:00Z",
    previousTerminalId: null,
    repairCount: 0,
    lastRepair: null,
    uploadConflictCount: 0,
    saleRef: null,
    summary: {
      occurredAt: "2026-11-19T10:24:00Z",
      posTotal: "1250.50",
      currencyCode: "EGP",
      lineCount: 3,
    },
    writeOff: null,
    ...over,
  };
}
