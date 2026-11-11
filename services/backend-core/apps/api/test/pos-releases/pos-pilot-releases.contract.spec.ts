/**
 * apps/api/test/pos-releases/pos-pilot-releases.contract.spec.ts
 *
 * RT-1292 (RT-1290 slice P1): `pos-pilot-releases.openapi.yaml`. Structural /
 * load-only, plus AJV fixtures against the contract schemas. No app boot and
 * no HTTP. Pinned here:
 *
 *   1. The six operations: paths, methods, one operationId each, none carries
 *      a contract-only marker (RT-1298 lifted it from the three registry
 *      writes), their audit actions, and their closed statuses.
 *   2. The resolver answer is one of two closed shapes: `available:false` has
 *      no other key; the download has exactly the documented keys.
 *   3. The registry accepts only signing class `pilot` on the wire it will
 *      serve (lab and production are listed only so they are refused as 422).
 *   4. The documented rules: no fallback, no reason, the lab markers, the URL
 *      lifetime, and the audit actions.
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const LATEST = "/api/v1/pos-pilot-releases/latest";
const TENANT = "/api/v1/platform/pos-pilot-tenants/{tenantId}";
const REGISTER = "/api/v1/platform/pos-pilot-releases";
const WITHDRAW = "/api/v1/platform/pos-pilot-releases/{releaseId}/withdraw";
const ACTIVATE = "/api/v1/platform/pos-pilot-releases/{releaseId}/activate";
const LIST_TENANTS = "/api/v1/platform/pos-pilot-tenants";

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("pos-pilot-releases.openapi");
});

/** The contract's info description text. */
const info = (): string => String((contract.document["info"] as JsonObject)["description"]);
/** The sorted property names of a contract schema. */
const keysOf = (name: Capitalize<string>): string[] =>
  Object.keys((contract.schema(name)["properties"] ?? {}) as JsonObject).sort();
/** The sorted response status codes of an operation. */
const statuses = (method: "get" | "post" | "put" | "delete", path: `/${string}`): string[] =>
  Object.keys(contract.operation(method, path)["responses"] as JsonObject).sort();

const DOWNLOAD = {
  available: true,
  version: "1.4.0",
  sha256: "a".repeat(64),
  sizeBytes: 185483052,
  fileName: "POS-Pulse-Setup-1.4.0.exe",
  expectedPublisher: "CN=Kemetra POS PILOT",
  downloadUrl: "https://bucket.example/obj?sig=abc",
  expiresAt: "2026-11-08T12:05:00.000Z",
};

describe("RT-1292 pilot releases contract: operations", () => {
  it.each([
    ["get", LATEST, "consolePilotGetLatestPosRelease"],
    ["put", TENANT, "platformAddPilotTenant"],
    ["delete", TENANT, "platformRemovePilotTenant"],
    ["post", REGISTER, "platformRegisterPilotRelease"],
    ["post", WITHDRAW, "platformWithdrawPilotRelease"],
    ["post", ACTIVATE, "platformActivatePilotRelease"],
    ["get", REGISTER, "platformListPilotReleases"],
    ["get", LIST_TENANTS, "platformListPilotTenants"],
  ] as const)("declares %s %s as %s", (method, path, operationId) => {
    expect(contract.operation(method, path)["operationId"]).toBe(operationId);
  });

  it("serves all eight operations: no contract-only marker (RT-1298 lifted the registry writes, RT-1328 added the two reads)", () => {
    const all = [
      ["get", LATEST],
      ["put", TENANT],
      ["delete", TENANT],
      ["post", REGISTER],
      ["post", WITHDRAW],
      ["post", ACTIVATE],
      ["get", REGISTER],
      ["get", LIST_TENANTS],
    ] as const;
    for (const [method, path] of all) {
      const operation = contract.operation(method, path);
      expect(operation["x-runtime-status"]).toBeUndefined();
      expect(operation["x-runtime-note"]).toBeUndefined();
    }
  });

  it("names an audit action per audited operation", () => {
    expect(contract.operation("get", LATEST)["x-audit-action"]).toBe("pos.pilot_release.download_link_issued");
    expect(contract.operation("put", TENANT)["x-audit-action"]).toBe("pos.pilot_tenant.added");
    expect(contract.operation("delete", TENANT)["x-audit-action"]).toBe("pos.pilot_tenant.removed");
    expect(contract.operation("post", REGISTER)["x-audit-action"]).toBe("pos.pilot_release.registered");
    expect(contract.operation("post", WITHDRAW)["x-audit-action"]).toBe("pos.pilot_release.withdrawn");
    expect(contract.operation("post", ACTIVATE)["x-audit-action"]).toBe("pos.pilot_release.activated");
  });

  it("lists the closed statuses of each served operation", () => {
    expect(statuses("get", LATEST)).toEqual(["200", "400", "401", "403", "404", "429", "500"]);
    expect(statuses("put", TENANT)).toEqual(["200", "201", "400", "401", "403", "404", "429", "500"]);
    expect(statuses("delete", TENANT)).toEqual(["204", "400", "401", "403", "429", "500"]);
    expect(statuses("post", REGISTER)).toEqual(["200", "201", "400", "401", "403", "409", "422", "500"]);
    expect(statuses("post", WITHDRAW)).toEqual(["200", "400", "401", "403", "404", "500"]);
    expect(statuses("post", ACTIVATE)).toEqual(["200", "400", "401", "403", "404", "409", "429", "500"]);
    expect(statuses("get", REGISTER)).toEqual(["200", "400", "401", "403", "429", "500"]);
    expect(statuses("get", LIST_TENANTS)).toEqual(["200", "400", "401", "403", "429", "500"]);
  });
});

describe("RT-1328 pilot releases contract: the platform-admin reads", () => {
  /** The security scheme names of an operation. */
  const schemesOf = (method: "get", path: `/${string}`): string[] =>
    (contract.operation(method, path)["security"] as JsonObject[]).flatMap((requirement) => Object.keys(requirement));

  const RELEASE = {
    releaseId: "0190f5a2-3b4c-7d8e-9f01-000000002929",
    version: "1.4.0",
    sha256: "b".repeat(64),
    sizeBytes: 133865024,
    publisher: "CN=Kemetra POS PILOT",
    signingClass: "pilot",
    attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/123456",
    sourceSha: "c".repeat(40),
    approved: true,
    approvedBy: "kemetra-owner",
    approvedAt: "2026-11-08T12:00:00.000Z",
    promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/987654321",
    artifactVersionId: "verid",
    registeredAt: "2026-11-08T12:00:01.000Z",
    withdrawnAt: null,
    withdrawnBy: null,
    activatedAt: null,
    activatedByUserId: null,
  };
  const ENTRY = {
    tenantId: "0190f5a2-3b4c-7d8e-9f01-00000000aaaa",
    addedAt: "2026-11-08T12:00:00.000Z",
    addedByUserId: "0190f5a2-3b4c-7d8e-9f01-00000000bbbb",
  };

  it("authenticates both reads by the session cookie only, and audits neither", () => {
    expect(schemesOf("get", REGISTER)).toEqual(["cookieAuth"]);
    expect(schemesOf("get", LIST_TENANTS)).toEqual(["cookieAuth"]);
    expect(contract.operation("get", REGISTER)["x-audit-action"]).toBeUndefined();
    expect(contract.operation("get", LIST_TENANTS)["x-audit-action"]).toBeUndefined();
  });

  it("takes no parameter on either read", () => {
    expect(contract.operation("get", REGISTER)["parameters"]).toBeUndefined();
    expect(contract.operation("get", LIST_TENANTS)["parameters"]).toBeUndefined();
  });

  it("answers `{ items }` of stored releases, and refuses an extra key or a presigned URL", () => {
    expect(contract.accepts("PilotReleaseList", { items: [] })).toBe(true);
    expect(contract.accepts("PilotReleaseList", { items: [RELEASE] })).toBe(true);
    expect(contract.accepts("PilotReleaseList", { items: [RELEASE], next: "x" })).toBe(false);
    expect(contract.accepts("PilotReleaseList", { items: [{ ...RELEASE, downloadUrl: "https://b.example/o?sig=1" }] })).toBe(false);
    expect(contract.accepts("PilotReleaseList", {})).toBe(false);
  });

  it("answers `{ items }` of allowlist entries, and refuses an extra key", () => {
    expect(contract.accepts("PilotTenantList", { items: [] })).toBe(true);
    expect(contract.accepts("PilotTenantList", { items: [ENTRY] })).toBe(true);
    expect(contract.accepts("PilotTenantList", { items: [{ ...ENTRY, email: "a@b.example" }] })).toBe(false);
    expect(contract.accepts("PilotTenantList", { items: [ENTRY], total: 1 })).toBe(false);
  });
});

describe("RT-1298 pilot releases contract: the promotion credential", () => {
  /** The security scheme names of an operation. */
  const schemes = (path: `/${string}`): string[] =>
    (contract.operation("post", path)["security"] as JsonObject[]).flatMap((requirement) => Object.keys(requirement));

  it("authenticates register and withdraw by the promotion workflow's GitHub OIDC token, activate by the session cookie", () => {
    expect(schemes(REGISTER)).toEqual(["promotionWriter"]);
    expect(schemes(WITHDRAW)).toEqual(["promotionWriter"]);
    expect(schemes(ACTIVATE)).toEqual(["cookieAuth"]);
  });

  it("describes promotionWriter as a bearer JWT with the pins and the 401 / 403 split", () => {
    const schemesDoc = (contract.document["components"] as JsonObject)["securitySchemes"] as JsonObject;
    const scheme = schemesDoc["promotionWriter"] as JsonObject;
    expect(scheme["type"]).toBe("http");
    expect(scheme["scheme"]).toBe("bearer");
    expect(scheme["bearerFormat"]).toBe("JWT");
    const text = String(scheme["description"]);
    for (const part of ["GitHub OIDC", "token.actions.githubusercontent.com", "repository", "environment", "job_workflow_ref", "401", "403"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("OPEN");
    expect(text).not.toContain("Not served");
  });

  it("accepts a stored pilot release and refuses an extra key or another class", () => {
    const release = {
      releaseId: "0190f5a2-3b4c-7d8e-9f01-000000002929",
      version: "1.4.0",
      sha256: "b".repeat(64),
      sizeBytes: 133865024,
      publisher: "CN=Kemetra POS PILOT",
      signingClass: "pilot",
      attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/123456",
      sourceSha: "c".repeat(40),
      approved: true,
      approvedBy: "kemetra-owner",
      approvedAt: "2026-11-08T12:00:00.000Z",
      promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/987654321",
      artifactVersionId: "verid",
      registeredAt: "2026-11-08T12:00:01.000Z",
      withdrawnAt: null,
      withdrawnBy: null,
      activatedAt: null,
      activatedByUserId: null,
    };
    expect(contract.accepts("PilotRelease", release)).toBe(true);
    expect(contract.accepts("PilotRelease", { ...release, artifactKey: "k" })).toBe(false);
    expect(contract.accepts("PilotRelease", { ...release, signingClass: "lab" })).toBe(false);
  });
});

describe("RT-1292 pilot releases contract: the resolver answer", () => {
  it("accepts the full download and the bare unavailable answer", () => {
    expect(contract.accepts("LatestPilotRelease", DOWNLOAD)).toBe(true);
    expect(contract.accepts("LatestPilotRelease", { available: false })).toBe(true);
  });

  it("refuses a reason or any extra key on `available:false`", () => {
    expect(contract.accepts("LatestPilotRelease", { available: false, reason: "not_allowlisted" })).toBe(false);
    expect(contract.accepts("PilotReleaseUnavailable", { available: false, version: "1.4.0" })).toBe(false);
  });

  it("refuses an extra key, or a missing one, on the download", () => {
    expect(contract.accepts("LatestPilotRelease", { ...DOWNLOAD, bucket: "b" })).toBe(false);
    expect(contract.accepts("LatestPilotRelease", { ...DOWNLOAD, artifactKey: "k" })).toBe(false);
    const { downloadUrl: _omitted, ...withoutUrl } = DOWNLOAD;
    expect(contract.accepts("LatestPilotRelease", withoutUrl)).toBe(false);
  });

  it("returns exactly the documented download keys", () => {
    expect(keysOf("PilotReleaseDownload")).toEqual(Object.keys(DOWNLOAD).sort());
  });

  it("refuses a bad file name, digest or size", () => {
    expect(contract.accepts("LatestPilotRelease", { ...DOWNLOAD, fileName: "setup.exe" })).toBe(false);
    expect(contract.accepts("LatestPilotRelease", { ...DOWNLOAD, sha256: "A".repeat(64) })).toBe(false);
    expect(contract.accepts("LatestPilotRelease", { ...DOWNLOAD, sizeBytes: 0 })).toBe(false);
  });
});

describe("RT-1292 pilot releases contract: the registry write", () => {
  const REGISTRATION = {
    version: "1.4.0",
    sha256: "b".repeat(64),
    sizeBytes: 133865024,
    publisher: "CN=Kemetra POS PILOT",
    signingClass: "pilot",
    attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/123456",
    sourceSha: "c".repeat(40),
    approvedBy: "kemetra-owner",
    approvedAt: "2026-11-08T12:00:00.000Z",
    promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/987654321",
    artifactVersionId: "3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY",
  };

  it("accepts a well-formed pilot registration and refuses an extra key", () => {
    expect(contract.accepts("PilotReleaseRegistration", REGISTRATION)).toBe(true);
    expect(contract.accepts("PilotReleaseRegistration", { ...REGISTRATION, tag: "pos/v1.4.0" })).toBe(false);
  });

  it("lists lab and production only so they are refused as 422, not 400", () => {
    const classes = (contract.schema("PilotSigningClass")["enum"] as string[]).slice().sort();
    expect(classes).toEqual(["lab", "pilot", "production"]);
    expect(statuses("post", REGISTER)).toContain("422");
  });

  it("never carries an object key, a bucket or a URL in the registration", () => {
    expect(keysOf("PilotReleaseRegistration")).not.toEqual(expect.arrayContaining(["artifactKey"]));
    expect(keysOf("PilotReleaseRegistration")).not.toEqual(expect.arrayContaining(["downloadUrl"]));
  });
});

describe("RT-1292 pilot releases contract: the documented rules", () => {
  it("states the lane's invariants in the info description", () => {
    const text = info();
    expect(text).toContain("`{ \"available\": false }`");
    expect(text).toContain("no fallback");
    expect(text).toContain("LAB TEST");
    expect(text).toContain("NOT FOR PRODUCTION");
    expect(text).toContain("900 seconds");
    expect(text).toContain("pos.pilot_release.download_link_issued");
  });
});
