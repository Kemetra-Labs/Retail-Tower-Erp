/**
 * Default collaborators — RT-655. Every default DENIES or yields nothing, so an
 * AiModule with no overrides can never reach a provider.
 */
import type { AiBudgetDecision, AiBudgetInput, AiBudgetPort, AiEvidencePackBuilder } from "./ai-gateway.types";
import type { EvidencePack } from "../ports/model-provider.port";

/**
 * Fail-closed budget (the internal spend cap and the platform free-credit
 * pool, layer 7). Neither is sized yet (RT-645) and no store holds them, so
 * the budget state is unknown, and AD-AI-ENT-001 D-3 says unknown means deny.
 * The quota itself is the entitlement port's reservation (RT-664).
 */
export class FailClosedAiBudget implements AiBudgetPort {
  check(input?: AiBudgetInput): Promise<AiBudgetDecision> {
    // RT-1542: a deterministic Tier-0 run spends nothing from the (unsized)
    // spend cap or credit pool, so there is no unknown budget state to fail on;
    // its quota is still reserved and can still deny. Every model route has
    // provider cost, stays "unknown", and is denied.
    if (input?.providerCost === "zero") return Promise.resolve({ allowed: true });
    return Promise.resolve({ allowed: false, reason: "entitlement_unavailable" });
  }
}

/** No evidence builder is registered yet (RT-647); an empty pack means no request. */
export class EmptyEvidencePackBuilder implements AiEvidencePackBuilder {
  build(): Promise<EvidencePack> {
    return Promise.resolve({ items: [] });
  }
}
