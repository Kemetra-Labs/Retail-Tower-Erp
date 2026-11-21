/**
 * AiFeatureDefinition — RT-655. One registered AI feature: repo-owned,
 * versioned, and provider-neutral (RT-643 §8 anti-lock-in: prompts and schemas
 * never depend on a vendor feature). Registered in code; there is no
 * tenant-supplied feature, prompt, route or model.
 */
import { z } from "zod";

import type { EvidencePack, ModelCapability } from "../ports/model-provider.port";

/**
 * The reserved route key of Tier 0 (RT-1542, RT-1527 D-1R section 2): a
 * deterministic run with no model, no provider and no provider cost. It is NOT
 * a `ModelRouteDescriptor`: no allowlist entry can use it and no model feature
 * can name it. The ledger records it verbatim as `route_key`.
 */
export const DETERMINISTIC_ROUTE_KEY = "deterministic_no_model";

/**
 * A MODEL feature (Tier 1 and above): resolved to an allowlisted provider route
 * and answered by a provider call. Unchanged by RT-1542. `tier` is absent or
 * "model"; the deterministic variant below is the only other tier.
 */
export interface AiFeatureDefinition<T = unknown> {
  readonly tier?: "model";
  /** e.g. "sync_doctor.explain_sale" (the D0 E1 route). */
  readonly featureId: string;
  /** Key into the static route allowlist. */
  readonly routeKey: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: string;
  /** Renders the system prompt from the repo-owned template. Never tenant text. */
  readonly renderSystemPrompt: () => string;
  /** Zod schema id + version, sent to the adapter for traceability. */
  readonly outputSchemaId: string;
  /** MUST be a strict object schema: extra fields are rejected, not stripped. */
  readonly outputSchema: z.ZodType<T>;
  /** The evidence refs the validated output cites; each must be in the pack sent. */
  readonly extractEvidenceRefs: (output: T) => readonly string[];
  /** Capabilities the route must declare (conformance-verified, never assumed). */
  readonly requiredCapabilities: readonly ModelCapability[];
}

/**
 * A Tier-0 feature (RT-1542): a pure, synchronous executor replaces the
 * provider call. It runs after authorize, kill switch, entitlement, budget
 * pre-check, the quota reservation and the evidence build, and its output is
 * validated by the same strict schema and evidence-ref check as model output.
 * There is no prompt, route descriptor, capability or provider.
 */
export interface AiDeterministicFeatureDefinition<T = unknown> {
  readonly tier: "deterministic_no_model";
  readonly featureId: string;
  readonly routeKey: typeof DETERMINISTIC_ROUTE_KEY;
  /** Ledger metadata: the repo-owned template id and version of the deterministic answer. */
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: string;
  readonly outputSchemaId: string;
  /** MUST be a strict object schema, exactly as for a model feature. */
  readonly outputSchema: z.ZodType<T>;
  readonly extractEvidenceRefs: (output: T) => readonly string[];
  /**
   * Pure and synchronous: `(evidencePack, input) => output`. `input` is the
   * caller's already-validated `AiRunScope.params`. A throw, or an output that
   * fails validation, ends in a fallback and releases the reservation.
   */
  readonly execute: (pack: EvidencePack, input: Readonly<Record<string, unknown>>) => unknown;
}

/** Any feature the gateway can register. */
export type AiRegisteredFeature = AiFeatureDefinition | AiDeterministicFeatureDefinition;

export function isDeterministicFeature(
  feature: AiRegisteredFeature,
): feature is AiDeterministicFeatureDefinition {
  return feature.tier === "deterministic_no_model";
}

/**
 * Boot-time guard: a non-strict schema would silently accept (or strip) fields
 * a model invented, which defeats "Backend-Core validation is authoritative".
 * A programmer error, so it throws at construction, not at request time.
 */
export function assertStrictOutputSchema(
  feature: Pick<AiRegisteredFeature, "featureId" | "outputSchema">,
): void {
  const schema = feature.outputSchema;
  if (!(schema instanceof z.ZodObject) || schema._def.unknownKeys !== "strict") {
    throw new Error(
      `AI feature "${feature.featureId}": outputSchema must be a strict object schema ` +
        `(z.object({...}).strict()) so unknown fields are rejected.`,
    );
  }
}
