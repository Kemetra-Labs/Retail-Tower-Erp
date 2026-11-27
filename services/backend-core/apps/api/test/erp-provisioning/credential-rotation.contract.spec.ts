/**
 * RT-1362 S1 — structural conformance of the `credential.rotate` contract delta in
 * `erpnext-connector/provisioning-feed.yaml` (1.2.0-draft). No app boot, no HTTP.
 *
 * Pins what the slice promises:
 *  - the new platform-admin "rotate now" operation (`platformRequestConnectorCredentialRotation`):
 *    contract-only marker, HUMAN `cookieAuth` only, path-tenant route, no body, 201 created / 200
 *    already open, its own closed 409 code set (the shared `Error` enum is NOT widened, so the
 *    pinned Connector contract stays green), a projection with no secret, and its rate-limit class;
 *  - the credential issue operation keeps its shape (no new response field, no body, no
 *    Idempotency-Key, the same response set) while its repeat rule now covers `credential.rotate`.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load as parseYaml } from "js-yaml";

import { allContracts, contractDocument, operationIdsExcept } from "../_helpers/openapi-contract";

const CONTRACT_ID = "provisioning-feed";
const OPERATION_ID = "platformRequestConnectorCredentialRotation";
const ROUTE = "/api/v1/platform/tenants/{tenant_id}/connector-instances/{id}/rotate-now";
const ISSUE_ROUTE = "/api/connector/v1/erpnext/provisioning/requests/{requestId}/credential";

interface Operation {
  readonly operationId?: string;
  readonly description?: string;
  readonly security?: ReadonlyArray<Record<string, unknown>>;
  readonly parameters?: ReadonlyArray<{ $ref?: string }>;
  readonly requestBody?: unknown;
  readonly responses?: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
  readonly "x-runtime-status"?: string;
  readonly "x-runtime-note"?: string;
}

interface Schema {
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
  readonly properties?: Record<string, { enum?: readonly string[]; format?: string }>;
}

interface Doc {
  readonly info?: { version?: string };
  readonly paths?: Record<string, Record<string, Operation>>;
  readonly components?: {
    readonly schemas?: Record<string, Schema>;
    readonly responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
  };
}

const contracts = allContracts();
const doc = contractDocument(contracts, CONTRACT_ID) as unknown as Doc;
const post = (route: string): Operation => {
  const found = doc.paths?.[route]?.["post"];
  if (!found) throw new Error(`${route} POST is not in ${CONTRACT_ID}.yaml`);
  return found;
};
const schema = (name: string): Schema => {
  const found = doc.components?.schemas?.[name];
  if (!found) throw new Error(`schema ${name} is not in ${CONTRACT_ID}.yaml`);
  return found;
};
const errorCodes = (name: string): readonly string[] =>
  (schema(name).properties?.["error"] as unknown as { properties: { code: { enum: string[] } } }).properties.code.enum;

describe("RT-1362 S1 platformRequestConnectorCredentialRotation contract", () => {
  it("is a new additive operation with a unique operationId and a bumped info.version", () => {
    expect(post(ROUTE).operationId).toBe(OPERATION_ID);
    expect(operationIdsExcept(contracts, CONTRACT_ID).has(OPERATION_ID)).toBe(false);
    expect(doc.info?.version).toBe("1.2.0-draft");
  });

  it("is marked contract-only with a runtime note naming RT-1362 S2", () => {
    expect(post(ROUTE)["x-runtime-status"]).toBe("contract-only");
    expect(post(ROUTE)["x-runtime-note"]).toMatch(/RT-1362 S2/);
  });

  it("is a POST with the HUMAN cookieAuth scheme only and an optional strict body carrying only hostLabel", () => {
    expect(Object.keys(doc.paths?.[ROUTE] ?? {})).toEqual(["post"]);
    expect(post(ROUTE).security).toEqual([{ cookieAuth: [] }]);
    expect(post(ROUTE).requestBody).toMatchObject({
      required: false,
      content: { "application/json": { schema: { $ref: "#/components/schemas/RequestConnectorCredentialRotation" } } },
    });
    const body = schema("RequestConnectorCredentialRotation");
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties ?? {})).toEqual(["hostLabel", "expectedHostBindingRevision"]);
    expect(body.required ?? []).toEqual([]);
    expect((post(ROUTE).parameters ?? []).map((p) => p.$ref)).toEqual([
      "#/components/parameters/TenantId",
      "#/components/parameters/ConnectorInstanceId",
    ]);
  });

  it("answers 201 created or 200 already open with the same no-store projection, and its own 409 code set", () => {
    const responses = post(ROUTE).responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(["200", "201", "400", "401", "403", "404", "409", "429", "500"]);
    expect(responses["201"]?.headers?.["Cache-Control"]).toBeDefined();
    expect(responses["200"]?.headers?.["Cache-Control"]).toBeDefined();
    expect(responses["409"]?.$ref).toBe("#/components/responses/RotationRefused");
    expect(doc.components?.responses?.["RotationRefused"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/RotationRefusedError",
    );
    expect(errorCodes("RotationRefusedError")).toEqual([
      "rotation_unavailable",
      "not_managed",
      "registration_disabled",
      "provisioning_in_progress",
      "site_not_bound",
      "host_mismatch",
      "host_not_bound",
      "host_binding_stale",
    ]);
  });

  it("identifies the rotated site by the stored binding, additively (owner decision RT-1362 c19104)", () => {
    const request = schema("ProvisioningRequest") as Schema & {
      properties?: Record<string, { type?: string; minLength?: number; maxLength?: number; pattern?: string }>;
    };
    const siteRef = request.properties?.["erpnextSiteRef"];
    expect(siteRef).toMatchObject({ type: "string", minLength: 1, maxLength: 255 });
    expect(siteRef?.pattern).toBeUndefined();
    expect(request.required).not.toContain("erpnextSiteRef");
    // The pinned Connector reads these by subscript: they stay required, and the siteName rule is unchanged.
    expect(request.required).toEqual(expect.arrayContaining(["siteName", "template", "locale", "connectorRegistrationId"]));
    expect(request.properties?.["siteName"]?.pattern).toBe("^t[0-9a-f]{20}[a-z0-9.-]*$");
  });

  it("does not widen the shared Error enum (the pinned Connector contract must stay green)", () => {
    const shared = (schema("Error").properties?.["error"] as unknown as { properties: { code: { enum: string[] } } }).properties.code.enum;
    for (const code of ["rotation_unavailable", "not_managed", "registration_disabled", "provisioning_in_progress", "site_not_bound", "host_mismatch", "host_not_bound", "host_binding_stale", "already_open"]) {
      expect(shared).not.toContain(code);
    }
  });

  it("answers with an explicit projection of the open credential.rotate request and no secret", () => {
    const body = schema("ConnectorRotationRequest");
    expect(body.additionalProperties).toBe(false);
    expect([...(body.required ?? [])].sort()).toEqual(
      ["hostBinding", "hostBindingRevision", "hostLabel", "instanceId", "kind", "outcome", "provisioningRequestId", "requestedAt", "tenantId", "trigger"],
    );
    expect(body.properties?.["hostBinding"]?.enum).toEqual(["provisional", "confirmed"]);
    expect(body.properties?.["outcome"]?.enum).toEqual(["requested", "already_open"]);
    expect(body.properties?.["kind"]?.enum).toEqual(["credential.rotate"]);
    expect(body.properties?.["trigger"]?.enum).toEqual(["forced", "scheduled"]);
    expect(Object.keys(body.properties ?? {}).join(" ")).not.toMatch(/secret|token|password|credential/i);
  });

  it("has its console rate-limit class entry", () => {
    const classes = parseYaml(
      readFileSync(
        resolve(__dirname, "..", "console-rate-limit", "classes", "erpnext-connector", "provisioning-feed.rate-limit.yaml"),
        "utf8",
      ),
    ) as Record<string, string>;
    expect(classes[OPERATION_ID]).toBe("incidentControl");
  });
});

describe("RT-1362 S1 connectorIssueProvisionedCredential keeps its shape", () => {
  it("still takes no body and no Idempotency-Key, and answers the same response set", () => {
    const issue = post(ISSUE_ROUTE);
    expect(issue.operationId).toBe("connectorIssueProvisionedCredential");
    expect(issue["x-runtime-status"]).toBeUndefined();
    expect(issue.requestBody).toBeUndefined();
    expect((issue.parameters ?? []).map((p) => p.$ref)).toEqual([
      "#/components/parameters/RequestId",
      "#/components/parameters/ProvisioningLeaseId",
    ]);
    expect(Object.keys(issue.responses ?? {}).sort()).toEqual(["201", "401", "403", "404", "500"]);
  });

  it("fences claims with an OPTIONAL lease id (header and ack field), so tenant.provision and the pinned Connector are unaffected", () => {
    const params = (doc as unknown as { components: { parameters: Record<string, { name?: string; in?: string; required?: boolean; schema?: { format?: string } }> } })
      .components.parameters;
    expect(params["ProvisioningLeaseId"]).toMatchObject({ name: "Provisioning-Lease-Id", in: "header", required: false, schema: { format: "uuid" } });
    for (const route of [
      "/api/connector/v1/erpnext/provisioning/requests/{requestId}/steps",
      "/api/connector/v1/erpnext/provisioning/requests/{requestId}/outcome",
    ]) {
      expect((post(route).parameters ?? []).map((p) => p.$ref)).toContain("#/components/parameters/ProvisioningLeaseId");
    }
    const ack = schema("StepAckResult");
    expect(ack.required).toEqual(["requestId", "step", "leaseExpiresAt"]);
    expect(ack.properties?.["leaseId"]?.format).toBe("uuid");
  });

  it("returns the same IssuedProvisionedCredential fields (no new field for the rotate branch)", () => {
    const issued = schema("IssuedProvisionedCredential");
    expect(issued.additionalProperties).toBe(false);
    expect([...(issued.required ?? [])].sort()).toEqual(
      ["credentialId", "expiresAt", "issuedAt", "registrationId", "rotated", "secret"],
    );
  });

  it("documents the OVERLAP credential.rotate rule (RT-1362 c19107) next to the unchanged tenant.provision rule", () => {
    const text = (post(ISSUE_ROUTE).description ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/tenant\.provision` request, a REPEAT call for a credential that has never been presented/);
    expect(text).toMatch(/`credential\.rotate` request \(1\.2\.0-draft, RT-1362, OVERLAP/);
    expect(text).toMatch(/issues one PENDING credential and leaves the current one valid/);
    expect(text).toMatch(/revokes the OLD credential server-side in the same transaction that first accepts a request authenticated with the pending one/);
    expect(text).toMatch(/at most two unrevoked credentials/);
    expect(text).not.toMatch(/exactly one unrevoked credential/);
    expect(schema("RequestKind").enum).toEqual(["tenant.provision", "store.provision", "credential.rotate"]);
  });

  it("states in the file description that posting never pauses and a failed rotation keeps the current credential", () => {
    const info = (doc as unknown as { info: { description: string } }).info.description.replace(/\s+/g, " ");
    expect(info).toMatch(/posting never pauses/);
    expect(info).toMatch(/revokes its pending credential \(if any\) in the same transaction, the current credential stays the only unrevoked one/);
    expect(info).toMatch(/a REPLAYED `claimed` acknowledgement .* is answered `409 lease_lost`/);
    expect(info).toMatch(/FINAL lease id/);
  });
});
