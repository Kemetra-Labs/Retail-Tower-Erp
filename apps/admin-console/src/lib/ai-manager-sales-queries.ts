/**
 * RT-1541 (W8 P-08) data layer: one typed wrapper over the generated `apiClient` for the single
 * operation of the Manager Sales Ask/Explain contract (RT-1538 contract, P-05; the runtime is
 * RT-1539, P-06):
 *
 *   - `consoleExplainSales`: POST /api/v1/ai/manager-sales/explain
 *
 * Read-only and deterministic (tier 0, no model). The request carries its scope from the panel's
 * controls only, never from the question text (M-2). `Idempotency-Key` is required on every call:
 * the caller passes a fresh one per submit. No hand-rolled fetch and no Authorization header: the
 * cookie transport is on the generated client. The body is never logged here.
 */
import { apiClient } from "@/generated/client";
import type { AiManagerSalesExplainSchema } from "@/generated/schema";

type Schemas = AiManagerSalesExplainSchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

/**
 * The request body. openapi-typescript collapses the schema's `anyOf` (one of `templateId` /
 * `question`) and its `if/then` (`currency` for the by-store templates) to `unknown`, so the
 * object part is spelled out here from the generated property types. The server enforces the
 * two conditional rules; `validateAsk` and `buildExplainRequest` satisfy them before sending.
 */
export type ManagerSalesExplainRequest = {
  templateId?: Schemas["TemplateId"];
  question?: string;
  storeIds: string[];
  from: Schemas["BusinessDate"];
  to: Schemas["BusinessDate"];
  currency?: Schemas["CurrencyCode"];
  compare?: "previous_period" | "none";
  locale: Schemas["Locale"];
};
export type ManagerSalesExplainResponse = Schemas["ManagerSalesExplainResponse"];
export type ManagerSalesAnswer = Schemas["ManagerSalesAnswer"];
export type ManagerSalesRefusal = Schemas["ManagerSalesRefusal"];
export type ManagerSalesUnavailable = Schemas["ManagerSalesUnavailable"];
export type AnswerBlock = Schemas["AnswerBlock"];
export type StatementBlock = Schemas["StatementBlock"];
export type TableBlock = Schemas["TableBlock"];
export type TableCell = Schemas["TableCell"];
export type Citation = Schemas["Citation"];
export type AnswerSource = Schemas["AnswerSource"];
export type AnswerNotice = Schemas["AnswerNotice"];
export type AnswerDecline = Schemas["AnswerDecline"];
export type SourceGap = Schemas["SourceGap"];
export type AnswerRefusalCode = Schemas["AnswerRefusalCode"];
export type GatewayUnavailableCode = Schemas["GatewayUnavailableCode"];
export type TemplateId = Schemas["TemplateId"];
// --- Typed operation wrapper --------------------------------------------------

/** POST /api/v1/ai/manager-sales/explain. A refusal or an unavailable outcome is a 200 body. */
export async function consoleExplainSales(
  body: ManagerSalesExplainRequest,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/ai/manager-sales/explain", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body,
  });
  return { status: response.status, data, error };
}
