/**
 * RT-1539 — the Manager Sales Ask/Explain feature definition (`AiDeterministicFeatureDefinition`,
 * Tier 0 `deterministic_no_model`, RT-1526 v6 / RT-1542).
 *
 *   preflight : the deterministic intent match. A product refusal (finance, forecast, write,
 *               unsupported) ends the run HERE, after the kill switch and the entitlement check and
 *               before the budget pre-check and the quota reservation: nothing is read or charged.
 *   execute   : the pure renderer over the evidence pack.
 *
 * ENTITLEMENT: the production plan catalogue `core@1` grants no AI feature, so in production this
 * feature answers `unavailable / not_entitled` until a later, gated migration adds a catalogue version
 * granting `ai.manager_sales.ask_explain` with exactly one request meter. No migration is part of
 * RT-1539. Tests seed their own catalogue.
 */
import { DETERMINISTIC_ROUTE_KEY, type AiDeterministicFeatureDefinition } from "../gateway/ai-feature";
import {
  MSX_FEATURE_ID,
  MSX_OUTPUT_SCHEMA_ID,
  MSX_PROMPT_TEMPLATE_ID,
  MSX_PROMPT_TEMPLATE_VERSION,
} from "./msx.constants";
import { matchRequest } from "./msx.matcher";
import { citedRefsOf, ManagerSalesAnswerSchema, type ManagerSalesAnswer } from "./msx.output";
import { renderAnswer } from "./msx.render";
import { ManagerSalesExplainRequestSchema } from "./msx.request";

export const managerSalesFeature: AiDeterministicFeatureDefinition = {
  tier: "deterministic_no_model",
  featureId: MSX_FEATURE_ID,
  routeKey: DETERMINISTIC_ROUTE_KEY,
  promptTemplateId: MSX_PROMPT_TEMPLATE_ID,
  promptTemplateVersion: MSX_PROMPT_TEMPLATE_VERSION,
  outputSchemaId: MSX_OUTPUT_SCHEMA_ID,
  outputSchema: ManagerSalesAnswerSchema,
  extractEvidenceRefs: (output) => citedRefsOf(output as ManagerSalesAnswer),
  execute: (pack) => renderAnswer(pack),
  preflight: (input) => {
    const parsed = ManagerSalesExplainRequestSchema.safeParse(input);
    // The route validated the request; anything else is a programming error, not a refusal.
    if (!parsed.success) throw new Error("the Manager Sales request reached the gateway unvalidated");
    const request = parsed.data;
    const outcome = matchRequest({
      ...(request.templateId === undefined ? {} : { templateId: request.templateId }),
      ...(request.question === undefined ? {} : { question: request.question }),
      storeCount: request.storeIds.length,
      from: request.from,
      to: request.to,
    });
    return outcome.kind === "refusal" ? { code: outcome.code } : null;
  },
};
