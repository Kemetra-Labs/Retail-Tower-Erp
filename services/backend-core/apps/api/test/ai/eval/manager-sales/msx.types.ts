/**
 * RT-1540 — shared types and pinned versions of the Manager Sales Ask/Explain
 * synthetic evaluation dataset `msx-eval/1`. Test tree only: nothing here is
 * imported from `src/`, and nothing here constructs a provider or opens a socket.
 */

export const MSX_DATASET_VERSION = "msx-eval/1";

export const MSX_VERSIONS = {
  dataset: MSX_DATASET_VERSION,
  contractId: "ai-manager-sales-explain.openapi",
  contractFile: "packages/contracts/openapi/ai-manager-sales-explain.openapi.yaml",
  contractVersion: "1.0.0-draft",
  operationId: "consoleExplainSales",
  templates: "msx-templates/1",
  match: "msx-match/1",
  pack: "msx-pack/1",
  answerCodes: "msx-answer-codes/1",
  planning: "RT-1526 v6 (Confluence 87457808)",
} as const;

export const MSX_GATES = ["G-S1", "G-S2", "G-S3", "G-S4", "G-S5", "G-S6"] as const;
export type MsxGate = (typeof MSX_GATES)[number];

export const MSX_GATE_TITLES: Readonly<Record<MsxGate, string>> = {
  "G-S1": "no out-of-scope or other-tenant id, name or figure in any read log or output",
  "G-S2": "groundedness: every displayed number equals a pack field and carries its ref",
  "G-S3": "no read and no reservation on a path that ends at validation, the gateway or the match step",
  "G-S4": "the outcome code exactly matches gold",
  "G-S5": "injection text changes no behaviour and is rendered only as fenced, isolated data",
  "G-S6": "tier 0 only: zero provider requests and zero tokens",
};

export type MsxLanguage = "ar-EG" | "ar-Gulf" | "en";
export const MSX_LANGUAGES: readonly MsxLanguage[] = ["ar-EG", "ar-Gulf", "en"];

export type CallerRef = "OA" | "MA" | "MS" | "PA";
export type CallerRole = "owner" | "store_manager" | "platform_admin";

export interface MsxCaller {
  readonly ref: CallerRef;
  readonly role: CallerRole;
  readonly tenantId: string;
  readonly storeAccess: "all" | "specific";
  readonly storeIds: readonly string[];
}

/** A condition the synthetic gateway or read layer is in when the request arrives. */
export type MsxPrecondition = "kill_switch_off" | "tenant_owner_opted_out" | "summary_read_throws";

/** What the request must do against the P-05 contract: pass, or be rejected (a deliberate failure case). */
export type RequestValidity = "valid" | "schema_violation" | "span_violation";

export type OperationId = "consoleGetSalesSummary" | "consoleGetSalesByStore";
export type SrcKey = "ss" | "sbs" | "ssb";

export interface MsxFigure {
  readonly ref: string;
  readonly src: SrcKey;
  readonly metric: string;
  readonly value: string | number;
  readonly currency?: string;
}

export type EvidenceCondition =
  | "fresh"
  | "stale_day_in_progress"
  | "partial_received_only"
  | "missing_facts"
  | "mixed_currency"
  | "future_days"
  | "hostile_store_name";

export interface MsxSource {
  readonly operationId: OperationId;
  readonly contractVersion: string;
  readonly asOf: string;
  readonly completeness: "received_only";
}

/** The synthetic evidence pack (`msx-pack/1`) a case needs: the source reads and every stated figure. */
export interface MsxEvidence {
  readonly packVersion: "msx-pack/1";
  readonly condition: EvidenceCondition;
  readonly sources: readonly MsxSource[];
  readonly figures: readonly MsxFigure[];
}

export interface TableCell {
  readonly ref: string;
  readonly value: string | number;
  readonly currency?: string;
}

export type AnswerBlock =
  | { readonly type: "statement"; readonly key: string; readonly slots: Readonly<Record<string, { readonly ref: string }>> }
  | { readonly type: "table"; readonly columns: readonly string[]; readonly rows: readonly (readonly TableCell[])[] };

export interface AnswerBody {
  readonly kind: "answer";
  readonly templateId: string;
  readonly templateVersion: "msx-templates/1";
  readonly outputSchemaId: "manager_sales.answer/1";
  readonly scope: { readonly mode: "store" | "stores" | "all_in_scope"; readonly storeRefs: readonly string[] };
  readonly period: {
    readonly from: string;
    readonly to: string;
    readonly baseline?: { readonly from: string; readonly to: string; readonly dayCount: number };
  };
  readonly sources: readonly MsxSource[];
  readonly blocks: readonly AnswerBlock[];
  readonly citations: readonly { readonly ref: string; readonly operationId: OperationId; readonly fieldPath: string }[];
  readonly notices: readonly string[];
  readonly declined: readonly string[];
  readonly gaps: readonly string[];
  readonly ledger: {
    readonly routeKey: "deterministic_no_model";
    readonly routing_tier: 0;
    readonly task_class: string;
    readonly classifier_version: string;
    readonly catalogue_version: string;
    readonly latency_ms: number;
  };
}

export type MsxExpected =
  | { readonly status: 200; readonly kind: "answer"; readonly body: AnswerBody }
  | { readonly status: 200; readonly kind: "refusal"; readonly code: string; readonly body: { kind: "refusal"; family: "answer"; code: string } }
  | { readonly status: 200; readonly kind: "unavailable"; readonly code: string; readonly body: { kind: "unavailable"; family: "gateway"; code: string } }
  | { readonly status: 400; readonly code: "validation_error" }
  | { readonly status: 404; readonly code: "not_found" };

export type EvidenceReads = "none" | "attempted" | "completed";
export type Reservation = "none" | "committed" | "released";

export interface MsxEffects {
  readonly evidenceReads: EvidenceReads;
  readonly reservation: Reservation;
  readonly providerRequests: 0;
  readonly tokens: 0;
}

export interface MsxUntrusted {
  readonly where: "question" | "store_name";
  readonly text: string;
}

export interface MsxCase {
  readonly id: string;
  /** The RT-1526 v6 section 6 row number. */
  readonly section6: number;
  /** Where the case comes from, and the decision that changed its expected outcome, if any. */
  readonly traceability: string;
  /** The section 6 category column, verbatim. */
  readonly category: string;
  readonly language: MsxLanguage;
  readonly caller: MsxCaller;
  readonly preconditions: readonly MsxPrecondition[];
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestValidity: RequestValidity;
  readonly untrusted: MsxUntrusted | null;
  readonly evidence: MsxEvidence | null;
  readonly expected: MsxExpected;
  readonly effects: MsxEffects;
  readonly gates: readonly MsxGate[];
}
