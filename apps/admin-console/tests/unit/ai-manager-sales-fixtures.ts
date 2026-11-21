import type {
  ManagerSalesAnswer,
  ManagerSalesRefusal,
  ManagerSalesUnavailable,
} from "@/lib/ai-manager-sales-queries";

/** RT-1541 fixtures: bodies shaped as the RT-1538 contract's `ManagerSalesExplainResponse`. */
export const TENANT_ID = "0190f000-0000-7000-8000-000000000001";
export const STORE_A = "0190f000-0000-7000-8000-0000000000a1";
export const STORE_B = "0190f000-0000-7000-8000-0000000000b2";
export const REQUEST_ID = "0190f000-0000-7000-8000-00000000e154";

export const STORES = [
  { id: STORE_A, name: "Maadi", timezone: "Africa/Cairo" },
  { id: STORE_B, name: "Nasr City", timezone: "Africa/Cairo" },
];

const REF_NAME_A = "sbs:0190f000-0000-7000-8000-0000000000a1:range:storeName";
const REF_TOTAL_A = "sbs:0190f000-0000-7000-8000-0000000000a1:range:receivedSales.total:EGP";
const REF_COUNT_A = "sbs:0190f000-0000-7000-8000-0000000000a1:range:receivedSales.count:EGP";
const REF_SHARE_A = "sbs:0190f000-0000-7000-8000-0000000000a1:range:ranking.share:EGP";
const REF_NAME_B = "sbs:0190f000-0000-7000-8000-0000000000b2:range:storeName";
const REF_TOTAL_B = "sbs:0190f000-0000-7000-8000-0000000000b2:range:receivedSales.total:EGP";
const REF_COUNT_B = "sbs:0190f000-0000-7000-8000-0000000000b2:range:receivedSales.count:EGP";
const REF_SHARE_B = "sbs:0190f000-0000-7000-8000-0000000000b2:range:ranking.share:EGP";

const cite = (ref: string, operationId: "consoleGetSalesByStore" | "consoleGetSalesSummary") => ({
  ref,
  operationId,
  fieldPath: `$.stores[].${ref.split(":").slice(-2)[0]}`,
});

/** T-04 store ranking: a statement and a table, one source read, `received_only`. */
export function answerBody(over: Partial<ManagerSalesAnswer> = {}): ManagerSalesAnswer {
  return {
    kind: "answer",
    templateId: "T-04",
    templateVersion: "msx-templates/1",
    outputSchemaId: "manager_sales.answer/1",
    scope: { mode: "stores", storeRefs: [STORE_A, STORE_B] },
    period: { from: "2026-11-01", to: "2026-11-07" },
    sources: [
      {
        operationId: "consoleGetSalesByStore",
        contractVersion: "1.0.0-draft",
        asOf: "2026-11-07T14:30:00Z",
        completeness: "received_only",
      },
    ],
    blocks: [
      { type: "statement", key: "store_ranking", slots: { received_sales: { ref: REF_TOTAL_A } } },
      {
        type: "table",
        columns: ["store", "received_sales", "count", "share"],
        rows: [
          [
            { ref: REF_NAME_A, value: "Maadi" },
            { ref: REF_TOTAL_A, value: "1250.5000", currency: "EGP" },
            { ref: REF_COUNT_A, value: 12 },
            { ref: REF_SHARE_A, value: "0.6250" },
          ],
          [
            { ref: REF_NAME_B, value: "Nasr City" },
            { ref: REF_TOTAL_B, value: "750.0000", currency: "EGP" },
            { ref: REF_COUNT_B, value: 7 },
            { ref: REF_SHARE_B, value: "0.3750" },
          ],
        ],
      },
    ],
    citations: [
      cite(REF_NAME_A, "consoleGetSalesByStore"),
      cite(REF_TOTAL_A, "consoleGetSalesByStore"),
      cite(REF_COUNT_A, "consoleGetSalesByStore"),
      cite(REF_SHARE_A, "consoleGetSalesByStore"),
      cite(REF_NAME_B, "consoleGetSalesByStore"),
      cite(REF_TOTAL_B, "consoleGetSalesByStore"),
      cite(REF_COUNT_B, "consoleGetSalesByStore"),
      cite(REF_SHARE_B, "consoleGetSalesByStore"),
    ],
    notices: ["received_only"],
    declined: [],
    gaps: [],
    ledger: {
      routeKey: "deterministic_no_model",
      routing_tier: 0,
      task_class: "manager_sales",
      classifier_version: "msx-match/1",
      catalogue_version: "msx-templates/1",
      latency_ms: 12,
    },
    ...over,
  };
}

export const refusalBody = (code: ManagerSalesRefusal["code"]): ManagerSalesRefusal => ({
  kind: "refusal",
  family: "answer",
  code,
});

export const unavailableBody = (
  code: ManagerSalesUnavailable["code"],
): ManagerSalesUnavailable => ({
  kind: "unavailable",
  family: "gateway",
  code,
});

export const apiError = (code: string, requestId: string = REQUEST_ID) => ({
  error: { code, message: "x", request_id: requestId },
});
