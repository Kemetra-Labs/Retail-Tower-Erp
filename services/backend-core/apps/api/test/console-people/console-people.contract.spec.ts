/**
 * RT-1063 — the console people-name read contract
 * (`console-people.openapi.yaml`, RT-968), now served.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. One GET at `/api/v1/console/people`, `listPeopleNames`, with its audit
 *      action; no longer marked contract-only.
 *   2. `cookieAuth` only; 404 (never 403); no tenant id from the request.
 *   3. `ids`: comma-separated, 1 to 200 UUIDs, the bounds the runtime uses.
 *   4. PII: the body is `{ user_id, display_name }` only, closed.
 *   5. AJV fixtures: valid payloads pass, each invalid one fails.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { PEOPLE_IDS_MAX } from "../../src/console-people/console-people.query";
import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ContractReader,
  type OpenApiDocument,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "console-people.openapi";
const PATH = "/api/v1/console/people";
const OPERATION_ID = "listPeopleNames";
const A = "0a000000-0000-7000-8000-000000000001";
const B = "0a000000-0000-7000-8000-000000000002";

let doc: OpenApiDocument;
let api: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  api = contractReader(doc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: "PeopleNames" | "Error"): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

describe("console-people — document and operation", () => {
  it("declares exactly one read", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(Object.keys(doc.paths![PATH]!)).toEqual(["get"]);
    expect(api.get(PATH).operationId).toBe(OPERATION_ID);
    expect(api.get(PATH).requestBody).toBeUndefined();
  });

  it("is served: not marked contract-only (RT-1063 runtime)", () => {
    expect(api.get(PATH)["x-runtime-status"]).toBeUndefined();
    expect(api.get(PATH)["x-runtime-note"]).toBeUndefined();
  });

  it("names its audit action", () => {
    expect(api.get(PATH)["x-audit-action"]).toBe("people.names_read");
  });

  it("collides with no operationId in any other contract", () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });
});

describe("console-people — auth and scope", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    expect(api.get(PATH).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
  });

  it("answers 200 / 400 / 401 / 404 / 429 / 500 only: the refusal is 404, never 403", () => {
    expect(Object.keys(api.get(PATH).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "429", "500"]);
    expect(api.get(PATH).responses!["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
  });

  it("takes no tenant id and no header parameter", () => {
    expect(api.params(PATH).map((p) => p.name)).toEqual(["ids"]);
    expect(api.params(PATH).filter((p) => p.in === "header")).toEqual([]);
  });

  it("bounds ids at the runtime's 1 to 200, comma-separated", () => {
    const ids = api.param(PATH, "ids");
    expect(ids).toMatchObject({ in: "query", required: true, style: "form", explode: false });
    expect(ids.schema).toMatchObject({ type: "array", minItems: 1, maxItems: PEOPLE_IDS_MAX });
  });
});

describe("console-people — PII and body shape", () => {
  it("returns user_id and display_name only, closed", () => {
    expect(api.schema("PersonName")).toMatchObject({
      additionalProperties: false,
      required: ["user_id", "display_name"],
    });
    expect(Object.keys((api.schema("PersonName")["properties"] ?? {}) as object).sort()).toEqual([
      "display_name",
      "user_id",
    ]);
    const shape = JSON.stringify(api.shape(api.schema("PeopleNames")));
    for (const field of ["email", "role", "membership_id", "store", "revoked", "deleted", "is_platform_admin"]) {
      expect(shape).not.toContain(`"${field}`);
    }
  });

  it.each([
    ["an empty page", { items: [] }],
    ["names and a null", { items: [{ user_id: A, display_name: "Ada" }, { user_id: B, display_name: null }] }],
  ])("accepts %s", (_label, body) => {
    expect(validator("PeopleNames")(body)).toBe(true);
  });

  it.each([
    ["an extra field", { items: [{ user_id: A, display_name: "Ada", email: "a@example.test" }] }],
    ["a blank name", { items: [{ user_id: A, display_name: "" }] }],
    ["a missing name", { items: [{ user_id: A }] }],
    ["a non-uuid id", { items: [{ user_id: "nope", display_name: null }] }],
    ["no items", {}],
  ])("refuses %s", (_label, body) => {
    expect(validator("PeopleNames")(body)).toBe(false);
  });
});
