/**
 * RT-1298: binding the promotion verifier from the environment. A fully blank
 * lane is silent and unbound (every workflow write is 401); a half-set or
 * malformed one is unbound with ONE warning that names a closed reason and never
 * a value; all five valid pins bind a verifier without any network call.
 */
import type { JWTVerifyGetKey } from "jose";

import { bindPromotionVerifier } from "../../src/pos-pilot-releases/promotion-oidc.binding";
import { PromotionOidcVerifier } from "../../src/pos-pilot-releases/promotion-oidc.verifier";

const PINS = {
  POS_PILOT_PROMOTION_OIDC_AUDIENCE: "retail-tower-backend-core",
  POS_PILOT_PROMOTION_OIDC_REPOSITORY: "Kemetra-Labs/Retail-Tower-Erp",
  POS_PILOT_PROMOTION_OIDC_ENVIRONMENT: "release-pos-pilot-promote",
  POS_PILOT_PROMOTION_OIDC_REF: "refs/heads/main",
  POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF:
    "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
};

/** Bind from an environment with a stub key source, and collect the warnings. */
function bind(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const keySource = jest.fn((): JWTVerifyGetKey => (async () => new Uint8Array()) as unknown as JWTVerifyGetKey);
  const verifier = bindPromotionVerifier(env, (message) => warnings.push(message), keySource);
  return { verifier, warnings, keySource };
}

describe("RT-1298 promotion verifier binding", () => {
  it("is silent and unbound when nothing is set, and never builds a key source", () => {
    const { verifier, warnings, keySource } = bind({});
    expect(verifier).toBeNull();
    expect(warnings).toEqual([]);
    expect(keySource).not.toHaveBeenCalled();
  });

  it("binds a verifier, silently, when all five pins are valid", () => {
    const { verifier, warnings, keySource } = bind(PINS);
    expect(verifier).toBeInstanceOf(PromotionOidcVerifier);
    expect(warnings).toEqual([]);
    expect(keySource).toHaveBeenCalledTimes(1);
  });

  it("warns once with the reason `incomplete` when a pin is blank", () => {
    const { verifier, warnings } = bind({ ...PINS, POS_PILOT_PROMOTION_OIDC_ENVIRONMENT: "" });
    expect(verifier).toBeNull();
    expect(warnings).toEqual(["pilot release promotion writes are off: incomplete"]);
  });

  it("warns once with the reason `invalid` when a pin has the wrong shape", () => {
    const { verifier, warnings } = bind({ ...PINS, POS_PILOT_PROMOTION_OIDC_REF: "main" });
    expect(verifier).toBeNull();
    expect(warnings).toEqual(["pilot release promotion writes are off: invalid"]);
  });

  it("never puts a pin in a warning", () => {
    const text = [
      bind({ ...PINS, POS_PILOT_PROMOTION_OIDC_AUDIENCE: "" }),
      bind({ ...PINS, POS_PILOT_PROMOTION_OIDC_REF: "main" }),
    ]
      .flatMap((result) => result.warnings)
      .join("\n");
    for (const value of Object.values(PINS)) expect(text).not.toContain(value);
  });
});
