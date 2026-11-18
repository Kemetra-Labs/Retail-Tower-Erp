/**
 * RT-1298: the pins of the pilot promotion credential (GitHub OIDC, owner
 * decision D-5a). The writes are enabled only when ALL seven settings are set
 * (RT-1459 added the two immutable numeric ids of the repository and its owner);
 * any blank value disables them (fail closed): no token is then accepted.
 * A refusal names a closed reason, never a value.
 */
import { resolvePromotionOidcConfig } from "../../src/pos-pilot-releases/promotion-oidc.config";

const FULL = {
  POS_PILOT_PROMOTION_OIDC_AUDIENCE: "retail-tower-backend-core",
  POS_PILOT_PROMOTION_OIDC_REPOSITORY: "Kemetra-Labs/Retail-Tower-Erp",
  POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID: "1430288487",
  POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID: "340160100",
  POS_PILOT_PROMOTION_OIDC_ENVIRONMENT: "release-pos-pilot-promote",
  POS_PILOT_PROMOTION_OIDC_REF: "refs/heads/main",
  POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF:
    "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
};

describe("RT-1298 promotion OIDC config", () => {
  it("is enabled with all seven pins, trimmed", () => {
    const padded = Object.fromEntries(Object.entries(FULL).map(([name, value]) => [name, ` ${value} `]));
    expect(resolvePromotionOidcConfig(padded)).toEqual({
      enabled: true,
      audience: "retail-tower-backend-core",
      repository: "Kemetra-Labs/Retail-Tower-Erp",
      repositoryId: "1430288487",
      repositoryOwnerId: "340160100",
      environment: "release-pos-pilot-promote",
      ref: "refs/heads/main",
      workflowRef: "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
    });
  });

  it.each([
    ["a branch", "@refs/heads/main"],
    ["a tag", "@refs/tags/v1.2.3"],
    ["a commit sha", `@${"a".repeat(40)}`],
  ])("accepts a workflow ref pinned to %s", (_label, suffix) => {
    const workflowRef = `Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml${suffix}`;
    expect(resolvePromotionOidcConfig({ ...FULL, POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF: workflowRef })).toMatchObject({
      enabled: true,
      workflowRef,
    });
  });

  it.each(["@main", `@${"A".repeat(40)}`, `@${"a".repeat(39)}`, "@"])("refuses the workflow ref suffix %p", (suffix) => {
    const workflowRef = `Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml${suffix}`;
    expect(resolvePromotionOidcConfig({ ...FULL, POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF: workflowRef })).toEqual({
      enabled: false,
      reason: "invalid",
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
    ["the repository id", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "Kemetra-Labs/Retail-Tower-Erp"],
    ["the repository id (a negative number)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "-1"],
    ["the repository id (a decimal)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "1430288487.0"],
    ["the repository id (hex)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "0x55486d67"],
    ["the repository id (with an inner space)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "1430 288487"],
    ["the repository id (zero)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "0"],
    ["the repository id (leading zero)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "01430288487"],
    ["the repository id (over 20 digits)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID", "1".repeat(21)],
    ["the repository owner id", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID", "Kemetra-Labs"],
    ["the repository owner id (a negative number)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID", "-340160100"],
    ["the repository owner id (a decimal)", "POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID", "340160100.5"],
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
