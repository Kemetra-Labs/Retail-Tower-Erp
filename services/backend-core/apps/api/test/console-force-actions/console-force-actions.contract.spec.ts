/**
 * RT-1444 (C1 of RT-1437, `[GATED: contract]`): the Console force-action
 * contract. Structural / load-only, plus AJV runs of the contract's own
 * examples. No app boot and no HTTP. Pins:
 *
 *   1. Every new operation is cookieAuth, contract-only with a note naming its
 *      runtime slice, and has a unique operationId.
 *   2. Every write needs `Idempotency-Key`, a preview fingerprint and, for the
 *      deletion, a reason and a re-auth grant; the password is never in the
 *      deletion body.
 *   3. The contract examples satisfy the schemas (preview, list, closed shift,
 *      grant, deletion preview).
 *   4. The existing `softDeleteStore` gains only the 409; the readiness
 *      boundary gains only the optional `subject`.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { load as parseYaml } from "js-yaml";

import { loadOpenApiContracts } from "../../src/openapi/loader";

// Parsed OpenAPI documents are untyped by design here, as in the sibling contract specs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = Record<string, any>;

const FORCE_ID = "console-force-actions.openapi";
const STORES_ID = "stores.openapi";
const INVENTORY_PATH = resolve(
  __dirname,
  "..", "..", "..", "..",
  "packages", "contracts", "openapi", "inventory", "inventory.yaml",
); // nested directory: the flat loader does not read it

const contracts = loadOpenApiContracts();
const byId = (id: string): Node => {
  const found = contracts.find((c) => c.id === id);
  if (!found) throw new Error(`${id} not found`);
  return found.document as Node;
};
const force = byId(FORCE_ID);
const stores = byId(STORES_ID);

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(force, FORCE_ID);
ajv.addSchema(stores, STORES_ID);

function validator(id: string, name: string): ValidateFunction {
  const v = ajv.getSchema(`${id}#/components/schemas/${name}`);
  if (!v) throw new Error(`schema ${name} missing in ${id}`);
  return v;
}

function op(doc: Node, path: string, method: string): Node {
  return doc["paths"]?.[path]?.[method] ?? {};
}

const NEW_OPS: Array<[Node, string, string, string, string]> = [
  [force, "/api/v1/stores/{store_id}/open-shifts", "get", "consoleListOpenShifts", "RT-1445"],
  [force, "/api/v1/shifts/{shift_id}/force-close-preview", "get", "consoleGetForceClosePreview", "RT-1445"],
  [force, "/api/v1/shifts/{shift_id}/force-close", "post", "consoleForceCloseShift", "RT-1445"],
  [force, "/api/v1/auth/reauth", "post", "consoleReauthenticate", "RT-1439"],
  [stores, "/api/v1/stores/{store_id}/deletion-preview", "get", "previewStoreDeletion", "RT-1439"],
  [stores, "/api/v1/stores/{store_id}/deletion", "post", "consoleDeleteStore", "RT-1439"],
];

describe("console force actions contract (RT-1444)", () => {
  it("is 1.0.0-draft; stores moved to 1.3.0-draft", () => {
    expect(force["info"].version).toBe("1.0.0-draft");
    expect(stores["info"].version).toBe("1.3.0-draft");
  });

  it.each(NEW_OPS)("%#: is a contract-only cookieAuth operation naming its runtime slice", (doc, path, method, id, slice) => {
    const o = op(doc, path, method);
    expect(o["operationId"]).toBe(id);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(o["x-runtime-note"]).toContain(slice);
    expect(o["security"] ?? doc["security"]).toEqual([{ cookieAuth: [] }]);
  });

  it("operationIds are unique across every contract", () => {
    const seen = new Map<string, number>();
    for (const c of contracts) {
      for (const item of Object.values((c.document as Node)["paths"] ?? {}) as Node[]) {
        for (const o of Object.values(item) as Node[]) {
          const id = o?.["operationId"];
          if (typeof id === "string") seen.set(id, (seen.get(id) ?? 0) + 1);
        }
      }
    }
    for (const [, , , id] of NEW_OPS) expect(seen.get(id)).toBe(1);
  });

  it("both writes require Idempotency-Key and a preview fingerprint", () => {
    for (const [doc, path] of [
      [force, "/api/v1/shifts/{shift_id}/force-close"],
      [stores, "/api/v1/stores/{store_id}/deletion"],
    ] as Array<[Node, string]>) {
      const o = op(doc, path, "post");
      expect(o["parameters"]).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
      expect(doc["components"].parameters.IdempotencyKey.required).toBe(true);
      expect(o["x-idempotency"]).toBe("required");
    }
    expect([...force["components"].schemas.ConsoleForceCloseRequest.required].sort()).toEqual([
      "forcedReason",
      "previewFingerprint",
    ]);
    const del = stores["components"].schemas.StoreDeletionRequest;
    expect([...del.required].sort()).toEqual(["previewFingerprint", "reason", "reauthToken"]);
    expect(Object.keys(del.properties)).not.toContain("password");
    expect(del.additionalProperties).toBe(false);
  });

  it("the password lives only in the re-auth request and is write-only", () => {
    expect(force["components"].schemas.ReauthRequest.properties.password.writeOnly).toBe(true);
    expect(Object.keys(force["components"].schemas.ReauthGrant.properties)).not.toContain("password");
  });

  it("a Console close records its origin explicitly and carries no total", () => {
    const rec = force["components"].schemas.ConsoleForcedCloseRecord;
    expect(rec.properties.closedVia.enum).toEqual(["pos", "console"]);
    expect(rec.required).toContain("closedVia");
    for (const forbidden of ["countedCash", "expectedCash", "variance", "saleCount"]) {
      expect(Object.keys(rec.properties)).not.toContain(forbidden);
    }
    expect(rec.properties.cashCount.const).toBe("not_counted");
  });

  it("the preview never carries expected cash or variance", () => {
    const rec = force["components"].schemas.RecordedFacts;
    for (const forbidden of ["expectedCash", "variance", "countedCash"]) {
      expect(Object.keys(rec.properties)).not.toContain(forbidden);
    }
  });

  it("the contract examples satisfy their schemas", () => {
    const json = (o: Node) => o["content"]["application/json"];
    const cases: Array<[string, string, unknown]> = [
      [FORCE_ID, "OpenShiftList", json(op(force, "/api/v1/stores/{store_id}/open-shifts", "get").responses["200"]).examples.oneBlocked.value],
      [FORCE_ID, "ForceClosePreview", json(op(force, "/api/v1/shifts/{shift_id}/force-close-preview", "get").responses["200"]).examples.eligible.value],
      [FORCE_ID, "ConsoleForceClosedShift", json(op(force, "/api/v1/shifts/{shift_id}/force-close", "post").responses["201"]).examples.console.value],
      [FORCE_ID, "ConsoleForceCloseRequest", json(op(force, "/api/v1/shifts/{shift_id}/force-close", "post").requestBody).examples.forced.value],
      [FORCE_ID, "ReauthGrant", json(op(force, "/api/v1/auth/reauth", "post").responses["200"]).examples.granted.value],
      [STORES_ID, "StoreDeletionPreview", json(op(stores, "/api/v1/stores/{store_id}/deletion-preview", "get").responses["200"]).examples.blocked.value],
      [STORES_ID, "StoreDeletionRequest", json(op(stores, "/api/v1/stores/{store_id}/deletion", "post").requestBody).examples.delete.value],
      [STORES_ID, "StoreDeleted", json(op(stores, "/api/v1/stores/{store_id}/deletion", "post").responses["200"]).examples.deleted.value],
    ];
    for (const [id, schema, value] of cases) {
      const v = validator(id, schema);
      expect({ schema, ok: v(value), errors: v.errors }).toEqual({ schema, ok: true, errors: null });
    }
  });

  it("rejects a malformed grant", () => {
    const bad = { reauthToken: "short", purpose: "store_deletion", storeId: "x", expiresAt: "now" };
    expect(validator(FORCE_ID, "ReauthGrant")(bad)).toBe(false);
  });

  it("softDeleteStore keeps its 204 and gains only the 409; it stays a runtime operation", () => {
    const o = op(stores, "/api/v1/stores/{store_id}", "delete");
    expect(Object.keys(o["responses"]).sort()).toEqual(["204", "403", "404", "409", "429"]);
    expect(o["x-runtime-status"]).toBeUndefined();
  });

  it("the deletion guards are the four documented codes, in order", () => {
    expect(stores["components"].schemas.StoreDeletionBlocker.properties.code.enum).toEqual([
      "store_has_open_shift",
      "store_has_unretired_device",
      "store_device_queue_unsynced",
      "store_has_open_count_session",
    ]);
  });

  it("the readiness subject is optional and exactly one of deviceId / warehouseRef", () => {
    const inv = (parseYaml(readFileSync(INVENTORY_PATH, "utf8")) as Node)["components"].schemas;
    expect(inv.CountSessionsReadinessBoundary.required).toEqual(["code", "storeId", "message"]);
    expect(inv.CountSessionsReadinessBoundary.properties.subject.$ref).toBe(
      "#/components/schemas/CountSessionsReadinessSubject",
    );
    expect(inv.CountSessionsReadinessSubject.oneOf).toEqual([
      { required: ["deviceId"] },
      { required: ["warehouseRef"] },
    ]);
  });
});
