/**
 * RT-1458 (audit A-12): the `siteName` Backend-Core derives always satisfies the constraint the
 * contract states for the provisioning request, which is the one the Connector's provisioner
 * enforces (`_SITE_NAME`, `_MAX_SITE_NAME` in the Connector engine; `tools/contracts-check`
 * compares those two with the contract). The pattern and the length are read from the contract
 * itself, so this fails if either side moves without the other.
 */
import { DEPLOYMENT_ENVIRONMENTS } from "../../src/common/deployment-environment";
import { deriveSiteName } from "../../src/erp-provisioning/provisioning.config";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";

interface SiteNameSchema {
  readonly type?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

function contractSiteName(): SiteNameSchema {
  const doc = contractDocument(allContracts(), "provisioning-feed") as {
    components?: { schemas?: Record<string, { properties?: Record<string, SiteNameSchema> }> };
  };
  const schema = doc.components?.schemas?.["ProvisioningRequest"]?.properties?.["siteName"];
  if (!schema) throw new Error("ProvisioningRequest.siteName not found in provisioning-feed.yaml");
  return schema;
}

// A v7, a v4, the nil-adjacent edge, all-f, and an upper-case spelling (tenant ids arrive lower-case, but
// the derivation lower-cases them, so an upper-case id must still satisfy the lower-case pattern).
const TENANT_IDS = [
  "0190f000-0000-7000-8000-0000000000b1",
  "0b9a3f0e-6c5d-4e2a-8d52-3a6f1b9c7d10",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "0B9A3F0E-6C5D-4E2A-8D52-3A6F1B9C7D10",
];

describe("RT-1458 A-12 — deriveSiteName against the contract's siteName", () => {
  const schema = contractSiteName();

  it("the contract bounds siteName to a DNS label (63) and states the Connector's pattern", () => {
    expect(schema.maxLength).toBe(63);
    expect(schema.minLength).toBe(1);
    expect(schema.pattern).toBe("^t[0-9a-f]{20}[a-z0-9.-]*$");
  });

  it.each(TENANT_IDS.flatMap((tenant) => DEPLOYMENT_ENVIRONMENTS.map((env) => [tenant, env] as const)))(
    "tenant %s in %s derives a name that fits the contract",
    (tenant, env) => {
      const name = deriveSiteName(tenant, env);
      expect(name.length).toBeGreaterThanOrEqual(schema.minLength as number);
      expect(name.length).toBeLessThanOrEqual(schema.maxLength as number);
      expect(new RegExp(schema.pattern as string).test(name)).toBe(true);
    },
  );

  it("is `t`, the first 20 hex digits of the id, `-`, then the environment", () => {
    expect(deriveSiteName("0b9a3f0e-6c5d-4e2a-8d52-3a6f1b9c7d10", "pilot")).toBe("t0b9a3f0e6c5d4e2a8d52-pilot");
  });

  it("the longest possible name is far inside the limit", () => {
    const longest = Math.max(...DEPLOYMENT_ENVIRONMENTS.map((env) => deriveSiteName(TENANT_IDS[0] as string, env).length));
    expect(longest).toBeLessThanOrEqual(29);
    expect(longest).toBeLessThan(schema.maxLength as number);
  });
});
