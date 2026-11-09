/**
 * RT-1298: the pins of the pilot promotion credential (GitHub OIDC, owner
 * decision D-5a). The writes are enabled only when ALL five settings are set;
 * any blank value disables them (fail closed): no token is then accepted.
 * A refusal names a closed reason, never a value.
 */
import { resolvePromotionOidcConfig } from "../../src/pos-pilot-releases/promotion-oidc.config";

const FULL = {
  POS_PILOT_PROMOTION_OIDC_AUDIENCE: "retail-tower-backend-core",
  POS_PILOT_PROMOTION_OIDC_REPOSITORY: "Kemetra-Labs/Retail-Tower-Erp",
  POS_PILOT_PROMOTION_OIDC_ENVIRONMENT: "release-pos-pilot-promote",
  POS_PILOT_PROMOTION_OIDC_REF: "refs/heads/main",
  POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF:
    "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
};

describe("RT-1298 promotion OIDC config", () => {
  it("is enabled with all five pins, trimmed", () => {
    const padded = Object.fromEntries(Object.entries(FULL).map(([name, value]) => [name, ` ${value} `]));
    expect(resolvePromotionOidcConfig(padded)).toEqual({
      enabled: true,
      audience: "retail-tower-backend-core",
      repository: "Kemetra-Labs/Retail-Tower-Erp",
      environment: "release-pos-pilot-promote",
      ref: "refs/heads/main",
      workflowRef: "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
    });
  });

  it("is disabled, quietly, when nothing is set", () => {
    expect(resolvePromotionOidcConfig({})).toEqual({ enabled: false, reason: "not_configured" });
    expect(resolvePromotionOidcConfig({ POS_PILOT_PROMOTION_OIDC_AUDIENCE: "  " })).toEqual({
      enabled: false,
      reason: "not_configured",
    });
  });

  it.each(Object.keys(FULL))("is disabled as incomplete when only %s is missing or blank", (name) => {
    for (const value of [undefined, "", "   "]) {
      expect(resolvePromotionOidcConfig({ ...FULL, [name]: value })).toEqual({ enabled: false, reason: "incomplete" });
    }
  });

  it("is disabled as incomplete when only one pin is set", () => {
    expect(resolvePromotionOidcConfig({ POS_PILOT_PROMOTION_OIDC_REPOSITORY: FULL.POS_PILOT_PROMOTION_OIDC_REPOSITORY })).toEqual(
      { enabled: false, reason: "incomplete" },
    );
  });

  it.each([
    ["the repository", "POS_PILOT_PROMOTION_OIDC_REPOSITORY", "Kemetra-Labs"],
    ["the ref", "POS_PILOT_PROMOTION_OIDC_REF", "main"],
    ["the workflow ref", "POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF", "promote-pos-pilot.yml"],
  ])("is disabled as invalid when %s is not in the shape GitHub puts in a token", (_label, name, value) => {
    expect(resolvePromotionOidcConfig({ ...FULL, [name]: value })).toEqual({ enabled: false, reason: "invalid" });
  });

  it("never carries a value in a refusal", () => {
    const refusal = resolvePromotionOidcConfig({ ...FULL, POS_PILOT_PROMOTION_OIDC_REF: "main" });
    expect(Object.keys(refusal).sort()).toEqual(["enabled", "reason"]);
  });
});
