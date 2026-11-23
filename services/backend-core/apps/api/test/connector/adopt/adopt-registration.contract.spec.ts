/**
 * RT-1557 — structural conformance of `platformAdoptConnectorRegistration` in
 * `erpnext-connector/provisioning-feed.yaml` (1.1.0-draft). No app boot, no HTTP.
 *
 * Pins what the operation promises: the HUMAN `cookieAuth` scheme only, the path-tenant
 * route (the registration table has no platform-admin RLS branch), a unique operationId,
 * a closed 409 code set that does NOT widen the shared `Error` enum (a widened response
 * enum would turn the pinned Connector contract check red), a response projection with
 * no secret, and the console rate-limit class entry.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load as parseYaml } from "js-yaml";

import { allContracts, contractDocument, operationIdsExcept } from "../../_helpers/openapi-contract";

const CONTRACT_ID = "provisioning-feed";
const OPERATION_ID = "platformAdoptConnectorRegistration";
const ROUTE = "/api/v1/platform/tenants/{tenant_id}/connector-instances/{id}/adopt";

interface Operation {
  readonly operationId?: string;
  readonly security?: ReadonlyArray<Record<string, unknown>>;
  readonly parameters?: ReadonlyArray<{ $ref?: string }>;
  readonly requestBody?: unknown;
  readonly responses?: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
  readonly tags?: readonly string[];
}

interface Schema {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Record<string, { enum?: readonly string[]; format?: string }>;
}

interface Doc {
  readonly info?: { version?: string };
  readonly paths?: Record<string, Record<string, Operation>>;
  readonly components?: {
    readonly schemas?: Record<string, Schema & { properties?: Record<string, unknown> }>;
    readonly parameters?: Record<string, { name?: string; in?: string; required?: boolean; schema?: { format?: string } }>;
    readonly responses?: Record<string, unknown>;
  };
}

const contracts = allContracts();
const doc = contractDocument(contracts, CONTRACT_ID) as unknown as Doc;
const op = (): Operation => {
  const found = doc.paths?.[ROUTE]?.["post"];
  if (!found) throw new Error(`${ROUTE} POST is not in ${CONTRACT_ID}.yaml`);
  return found;
};

describe("RT-1557 platformAdoptConnectorRegistration contract", () => {
  it("is a new additive operation with a unique operationId and a bumped info.version", () => {
    expect(op().operationId).toBe(OPERATION_ID);
    expect(operationIdsExcept(contracts, CONTRACT_ID).has(OPERATION_ID)).toBe(false);
    expect(doc.info?.version).toBe("1.1.0-draft");
  });

  it("is a POST with the HUMAN cookieAuth scheme only and no request body", () => {
    expect(Object.keys(doc.paths?.[ROUTE] ?? {})).toEqual(["post"]);
    expect(op().security).toEqual([{ cookieAuth: [] }]);
    expect(op().requestBody).toBeUndefined();
  });

  it("carries the tenant and the registration id as uuid path parameters", () => {
    expect((op().parameters ?? []).map((p) => p.$ref)).toEqual([
      "#/components/parameters/TenantId",
      "#/components/parameters/ConnectorInstanceId",
    ]);
    const params = doc.components?.parameters ?? {};
    expect(params["TenantId"]).toMatchObject({ name: "tenant_id", in: "path", required: true, schema: { format: "uuid" } });
    expect(params["ConnectorInstanceId"]).toMatchObject({ name: "id", in: "path", required: true, schema: { format: "uuid" } });
  });

  it("declares 200, 400, 401, 403, 404, 409, 429 and 500, and a 409 with its own closed code set", () => {
    expect(Object.keys(op().responses ?? {}).sort()).toEqual(["200", "400", "401", "403", "404", "409", "429", "500"]);
    expect(op().responses?.["409"]?.$ref).toBe("#/components/responses/AdoptRefused");
    const refused = doc.components?.schemas?.["AdoptRefusedError"] as Schema | undefined;
    const error = refused?.properties?.["error"] as unknown as { properties: { code: { enum: string[] } } };
    expect(error.properties.code.enum).toEqual(["registration_disabled", "already_managed"]);
  });

  it("does not widen the shared Error enum (the pinned Connector contract must stay green)", () => {
    const error = doc.components?.schemas?.["Error"] as unknown as { properties: { error: { properties: { code: { enum: string[] } } } } };
    const codes = error.properties.error.properties.code.enum;
    expect(codes).not.toContain("registration_disabled");
    expect(codes).not.toContain("already_managed");
  });

  it("answers with an explicit projection: outcome, ids, managedBy, environment, site ref, and no secret", () => {
    const body = doc.components?.schemas?.["AdoptedConnectorRegistration"] as Schema;
    expect(body.additionalProperties).toBe(false);
    expect([...(body.required ?? [])].sort()).toEqual(["environment", "erpnextSiteRef", "instanceId", "managedBy", "outcome", "tenantId"]);
    expect(body.properties?.["outcome"]?.enum).toEqual(["adopted", "already_adopted"]);
    expect(body.properties?.["managedBy"]?.enum).toEqual(["provisioner"]);
    expect(Object.keys(body.properties ?? {}).join(" ")).not.toMatch(/secret|token|password|credential/i);
  });

  it("has its console rate-limit class entry", () => {
    const classes = parseYaml(
      readFileSync(
        resolve(__dirname, "..", "..", "console-rate-limit", "classes", "erpnext-connector", "provisioning-feed.rate-limit.yaml"),
        "utf8",
      ),
    ) as Record<string, string>;
    expect(classes[OPERATION_ID]).toBe("incidentControl");
  });
});
