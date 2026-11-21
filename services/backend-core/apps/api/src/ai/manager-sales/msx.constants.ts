/**
 * RT-1539 (W8 P-06) — the pinned versions and closed vocabularies of the Manager Sales Ask/Explain
 * deterministic Tier-0 feature (RT-1526 v6, contract `ai-manager-sales-explain.openapi.yaml`
 * 1.0.0-draft). Every set here mirrors the contract's enums; a spec cross-checks them.
 */

/** The AI feature id: the entitlement catalogue key (`^ai(\.[a-z][a-z0-9_]{0,39}){1,4}$`). */
export const MSX_FEATURE_ID = "ai.manager_sales.ask_explain";

export const MSX_TEMPLATES_VERSION = "msx-templates/1";
export const MSX_MATCH_VERSION = "msx-match/1";
export const MSX_PACK_VERSION = "msx-pack/1";
export const MSX_OUTPUT_SCHEMA_ID = "manager_sales.answer/1";
/** Ledger metadata of the repo-owned deterministic answer template (`manager_sales.answer/1`). */
export const MSX_PROMPT_TEMPLATE_ID = "manager_sales.answer";
export const MSX_PROMPT_TEMPLATE_VERSION = "1";
export const MSX_TASK_CLASS = "manager_sales_deterministic_answer";

/** The closed catalogue `msx-templates/1`. T-11 is not used (reserved for ERP posting status). */
export const MSX_TEMPLATE_IDS = ["T-01", "T-02", "T-03", "T-04", "T-05", "T-06", "T-07", "T-08", "T-09", "T-10", "T-12"] as const;
export type MsxTemplateId = (typeof MSX_TEMPLATE_IDS)[number];

/** The by-store templates: `currency` is required when the request names one of them as `templateId`. */
export const MSX_CURRENCY_TEMPLATES: readonly MsxTemplateId[] = ["T-04", "T-05", "T-06", "T-07", "T-08", "T-09", "T-12"];

/** `msx-answer-codes/1` that refuse (a successful outcome of the feature, not a gateway fallback). */
export const MSX_REFUSAL_CODES = ["finance_source_absent", "forecast_not_supported", "write_action_not_supported", "unsupported_question"] as const;
export type MsxRefusalCode = (typeof MSX_REFUSAL_CODES)[number];

export const MSX_DECLINES = ["partial_data_not_conclusive", "causal_not_supported"] as const;
export type MsxDecline = (typeof MSX_DECLINES)[number];

export const MSX_NOTICES = [
  "received_only",
  "day_in_progress",
  "day_not_begun",
  "multi_currency",
  "scope_relative_ratio",
  "parameters_from_controls_only",
] as const;
export type MsxNotice = (typeof MSX_NOTICES)[number];

export const MSX_GAPS = ["G-1", "G-2", "G-3", "G-4", "G-5", "G-6", "G-7"] as const;
export type MsxGap = (typeof MSX_GAPS)[number];

/** The gateway reasons a tier-0 request can reach as a 200 `unavailable` (the contract's closed subset). */
export const MSX_UNAVAILABLE_CODES = [
  "feature_disabled_system",
  "tenant_inactive",
  "not_entitled",
  "trial_expired",
  "grace_read_only",
  "feature_disabled_tenant",
  "entitlement_unavailable",
  "quota_exhausted",
  "spend_cap_reached",
  "free_credit_exhausted",
  "evidence_unavailable",
] as const;
export type MsxUnavailableCode = (typeof MSX_UNAVAILABLE_CODES)[number];

export const MSX_OPERATIONS = ["consoleGetSalesSummary", "consoleGetSalesByStore"] as const;
export type MsxOperationId = (typeof MSX_OPERATIONS)[number];
