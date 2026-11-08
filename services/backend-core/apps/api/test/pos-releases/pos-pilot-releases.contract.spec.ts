/**
 * apps/api/test/pos-releases/pos-pilot-releases.contract.spec.ts
 *
 * RT-1292 (RT-1290 slice P1): `pos-pilot-releases.openapi.yaml`. Structural /
 * load-only, plus AJV fixtures against the contract schemas. No app boot and
 * no HTTP. Pinned here:
 *
 *   1. The six operations: paths, methods, one operationId each, the served
 *      ones carry no contract-only marker, and the three registry writes carry
 *      exactly that marker with a note.
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
  ] as const)("declares %s %s as %s", (method, path, operationId) => {
    expect(contract.operation(method, path)["operationId"]).toBe(operationId);
  });

  it("serves the resolver and the allowlist routes: no contract-only marker", () => {
    for (const [method, path] of [["get", LATEST], ["put", TENANT], ["delete", TENANT]] as const) {
      expect(contract.operation(method, path)["x-runtime-status"]).toBeUndefined();
    }
  });

  it("marks register, withdraw and activate contract-only, each with a runtime note", () => {
    for (const path of [REGISTER, WITHDRAW, ACTIVATE] as const) {
      const operation = contract.operation("post", path);
      expect(operation["x-runtime-status"]).toBe("contract-only");
      expect(String(operation["x-runtime-note"]).length).toBeGreaterThan(10);
    }
  });

  it("names an audit action per audited operation", () => {
    expect(contract.operation("get", LATEST)["x-audit-action"]).toBe("pos.pilot_release.download_link_issued");
    expect(contract.operation("put", TENANT)["x-audit-action"]).toBe("pos.pilot_tenant.added");
    expect(contract.operation("delete", TENANT)["x-audit-action"]).toBe("pos.pilot_tenant.removed");
  });

  it("lists the closed statuses of each served operation", () => {
    expect(statuses("get", LATEST)).toEqual(["200", "400", "401", "403", "404", "429", "500"]);
    expect(statuses("put", TENANT)).toEqual(["200", "201", "400", "401", "403", "404", "429", "500"]);
    expect(statuses("delete", TENANT)).toEqual(["204", "400", "401", "403", "429", "500"]);
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
