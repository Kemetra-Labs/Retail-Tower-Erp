/**
 * Gateway steps 8-9 — interpret the provider result (RT-655, RT-643 §5/§9.1).
 *
 * Backend-Core is always authoritative: every output is re-validated against a
 * strict Zod schema, every cited evidence ref must be in the pack that was
 * sent, and only the validated object is returned. Anything else becomes a
 * deterministic fallback that carries no provider output, usage or evidence.
 */
import type {
  EvidencePack,
  ModelResult,
  ModelRouteDescriptor,
} from "../ports/model-provider.port";
import type { AiFeatureDefinition, AiRegisteredFeature } from "./ai-feature";
import { fallback, type Fallback } from "./ai-gateway.result";
import type { AiGatewayResult } from "./ai-gateway.types";

type OkResult = Extract<ModelResult, { kind: "ok" }>;
type Validatable = Pick<AiRegisteredFeature, "outputSchema" | "extractEvidenceRefs">;

/** An output that passed the strict schema and the evidence-ref check. */
export interface ValidatedOutput {
  readonly output: unknown;
  readonly refs: readonly string[];
}

/** The refs the validated output cites, or null if the feature hook misbehaves. */
function citedRefs(feature: Validatable, output: unknown): readonly string[] | null {
  let refs: unknown;
  try {
    refs = feature.extractEvidenceRefs(output);
  } catch {
    return null;
  }
  const wellFormed = Array.isArray(refs) && refs.every((ref) => typeof ref === "string");
  return wellFormed ? (refs as readonly string[]) : null;
}

/**
 * The ONE validation of a feature's output, shared by model output (provider
 * requested) and Tier-0 deterministic output (RT-1542, none requested): strict
 * schema, then every cited ref must be in the pack that was built.
 */
export function validateOutput(
  rawOutput: unknown,
  feature: Validatable,
  pack: EvidencePack,
  providerRequested: boolean,
): ValidatedOutput | Fallback {
  const parsed = feature.outputSchema.safeParse(rawOutput);
  if (!parsed.success) return fallback("output_schema_invalid", providerRequested);

  const refs = citedRefs(feature, parsed.data);
  if (refs === null) return fallback("output_schema_invalid", providerRequested);

  const known = new Set(pack.items.map((item) => item.ref));
  if (!refs.every((ref) => known.has(ref))) return fallback("output_unknown_evidence_ref", providerRequested);
  return { output: parsed.data, refs };
}

function validateOk(
  result: OkResult,
  feature: AiFeatureDefinition,
  route: ModelRouteDescriptor,
  pack: EvidencePack,
): Exclude<AiGatewayResult, { kind: "declined" }> {
  const validated = validateOutput(result.rawOutput, feature, pack, true);
  if ("kind" in validated) return validated;
  const { output, refs } = validated;

  return {
    kind: "ok",
    output,
    evidenceRefs: refs,
    routeKey: route.routeKey,
    usage: result.usage,
  };
}

export function interpretResult(
  result: ModelResult,
  feature: AiFeatureDefinition,
  route: ModelRouteDescriptor,
  pack: EvidencePack,
): Exclude<AiGatewayResult, { kind: "declined" }> {
  switch (result.kind) {
    case "refused":
      return fallback("provider_refused", true);
    case "truncated":
      return fallback("provider_truncated", true);
    case "rejected_input":
      return fallback("provider_rejected_input", true);
    case "unavailable":
      return fallback(result.cause === "timeout" ? "provider_timeout" : "provider_unavailable", true);
    case "ok":
      return validateOk(result, feature, route, pack);
  }
}
