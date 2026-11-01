/**
 * RT-625 D3 / precondition P3 (acceptance test 20) — the TRUST_PROXY boot
 * check refuses a value that defeats the IP-keyed sign-in lockout in a
 * deployed environment: `true` always, and `false` unless the deployment
 * declares itself direct (`TRUST_PROXY_DIRECT_DEPLOYMENT=true`). It extends
 * the RT-624 check (trust-proxy.spec.ts); outside a deployed environment, and
 * for a hop count, nothing changes.
 */
import {
  checkTrustProxyConfig,
  TRUST_PROXY_FALSE_REFUSED,
  TRUST_PROXY_TRUE_REFUSED,
} from "../../src/common/trust-proxy";

type Env = NodeJS.ProcessEnv;

const deployed: Array<[string, Env]> = [
  ["NODE_ENV=production", { NODE_ENV: "production" }],
  ["DEPLOYMENT_ENVIRONMENT=prod", { DEPLOYMENT_ENVIRONMENT: "prod" }],
  ["DEPLOYMENT_ENVIRONMENT=pilot", { DEPLOYMENT_ENVIRONMENT: "pilot" }],
  ["DEPLOYMENT_ENVIRONMENT=staging", { DEPLOYMENT_ENVIRONMENT: "staging" }],
];

const notDeployed: Array<[string, Env]> = [
  ["empty env", {}],
  ["NODE_ENV=test", { NODE_ENV: "test" }],
  ["DEPLOYMENT_ENVIRONMENT=dev", { DEPLOYMENT_ENVIRONMENT: "dev" }],
];

describe.each(deployed)("RT-625 test 20: deployed (%s)", (_label, base) => {
  it.each(["", "true", "false"])("refuses TRUST_PROXY=true, whatever TRUST_PROXY_REQUIRED=%p says", (required) => {
    expect(() =>
      checkTrustProxyConfig({ ...base, TRUST_PROXY: "true", TRUST_PROXY_REQUIRED: required }),
    ).toThrow(TRUST_PROXY_TRUE_REFUSED);
  });

  it("refuses TRUST_PROXY=true even for a declared direct deployment", () => {
    expect(() =>
      checkTrustProxyConfig({ ...base, TRUST_PROXY: "true", TRUST_PROXY_DIRECT_DEPLOYMENT: "true" }),
    ).toThrow(TRUST_PROXY_TRUE_REFUSED);
  });

  it.each([undefined, "", "false", "TRUE", "1"])(
    "refuses TRUST_PROXY=false behind a proxy (TRUST_PROXY_DIRECT_DEPLOYMENT=%p)",
    (direct) => {
      const env: Env = direct === undefined ? { ...base } : { ...base, TRUST_PROXY_DIRECT_DEPLOYMENT: direct };
      expect(() => checkTrustProxyConfig({ ...env, TRUST_PROXY: "false" })).toThrow(TRUST_PROXY_FALSE_REFUSED);
    },
  );

  it("accepts TRUST_PROXY=false for a declared direct deployment", () => {
    expect(
      checkTrustProxyConfig({ ...base, TRUST_PROXY: "false", TRUST_PROXY_DIRECT_DEPLOYMENT: "true" }),
    ).toEqual({ warn: false });
  });

  it.each(["1", "2"])("accepts a hop count (%p)", (hops) => {
    expect(checkTrustProxyConfig({ ...base, TRUST_PROXY: hops })).toEqual({ warn: false });
  });

  it("leaves an unset TRUST_PROXY on the RT-624 path (a warning, not a refusal)", () => {
    expect(checkTrustProxyConfig({ ...base })).toMatchObject({ warn: true });
  });
});

describe.each(notDeployed)("RT-625: not deployed (%s)", (_label, base) => {
  it.each(["true", "false"])("TRUST_PROXY=%p still boots", (raw) => {
    expect(checkTrustProxyConfig({ ...base, TRUST_PROXY: raw })).toEqual({ warn: false });
  });
});

describe("RT-625: the refusal messages name the fix, never a value from the environment", () => {
  it("both name the hop count and say why", () => {
    expect(TRUST_PROXY_TRUE_REFUSED).toMatch(/hop count/);
    expect(TRUST_PROXY_FALSE_REFUSED).toMatch(/hop count/);
    expect(TRUST_PROXY_FALSE_REFUSED).toMatch(/TRUST_PROXY_DIRECT_DEPLOYMENT=true/);
  });
});
