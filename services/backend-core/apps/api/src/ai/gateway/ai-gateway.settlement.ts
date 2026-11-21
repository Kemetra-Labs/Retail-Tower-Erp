/**
 * Gateway step 10 — settle the quota reservation (RT-664, AD-AI-ENT-001 D-3,
 * D-8). Every run that reserved ends in exactly one settlement:
 *
 *   - a validated `ok` commits (the customer meter is charged);
 *   - every fallback releases (never charged). Its ledger outcome says why:
 *     `not_attempted` when no request reached the provider, else the
 *     provider condition or the validation failure.
 *
 * A Tier-0 deterministic run (RT-1542) follows the same rule: a validated
 * output commits ONE request unit with the existing ledger shape (`ok`, no
 * provider, model, tokens or cost); everything else releases.
 *
 * The run metadata recorded on the ledger is business-class only (AI-09,
 * E-8): route, template and schema ids, provider and model, the evidence
 * refs the validated output cited, and token counts. Never prompt or
 * completion text.
 */
import type { ModelResult, ModelUsage } from "../ports/model-provider.port";
import type { AiFallbackReason, AiGatewayResult, AiRunTelemetry, AiUsageOutcome } from "./ai-gateway.types";

const OUTCOME_BY_REASON: Partial<Record<AiFallbackReason, AiUsageOutcome>> = {
  provider_timeout: "provider_unavailable",
  provider_unavailable: "provider_unavailable",
  provider_error: "provider_unavailable",
  provider_refused: "provider_refused",
  provider_truncated: "output_truncated",
  provider_rejected_input: "input_rejected",
  output_schema_invalid: "output_invalid",
  output_unknown_evidence_ref: "output_invalid",
};

/** The ledger outcome of a finished run. */
export function usageOutcome(result: Exclude<AiGatewayResult, { kind: "declined" }>): AiUsageOutcome {
  if (result.kind === "ok") return "ok";
  // RT-1542: a Tier-0 output that failed validation never requested a provider,
  // but it is still a validation failure, not an unattempted run. (A model run
  // that fails validation has always requested a provider.)
  if (!result.providerRequested) {
    return result.reason === "output_schema_invalid" || result.reason === "output_unknown_evidence_ref"
      ? "output_invalid"
      : "not_attempted";
  }
  return OUTCOME_BY_REASON[result.reason] ?? "provider_unavailable";
}

/** Token counts of a provider answer, when it reported or estimated any. */
export function usageTelemetry(usage: ModelUsage | undefined): Partial<AiRunTelemetry> {
  if (usage === undefined) return {};
  const counts = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
  };
  if (Object.keys(counts).length === 0) return {};
  return { ...counts, tokenCountSource: usage.reported ? "reported" : "estimated" };
}

/** The usage a provider result carries, if any. */
export function resultUsage(result: ModelResult): ModelUsage | undefined {
  return "usage" in result ? result.usage : undefined;
}
