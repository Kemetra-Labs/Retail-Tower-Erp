/**
 * apps/api/test/inventory/safety/inventory-safety-feed.contract.spec.ts
 *
 * RT-449 PR 2 (RT-50 Gate 7 F2, G7-7; owner approval and rulings H1–H8 in
 * RT-449 comment 13434). The POS inventory safety feed, `[GATED]` contract
 * `packages/contracts/openapi/inventory/inventory-safety-feed.yaml`.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. What
 * this pins:
 *
 *   1. Two GET operations under `/api/pos/v1/inventory-safety/`, no write verb,
 *      no request body, no operationId collision.
 *   2. Security is the role-named `device` bearer scheme only (no JWT format).
 *   3. The query surface and the status set: 409 `snapshot_required` only on
 *      the delta; 401 / 404 non-disclosing.
 *   4. The revision is an int64 starting at 0, the TTL is 60–900 (H8), and the
 *      hold kinds are the database's.
 *   5. Strict response schemas: valid payloads pass, invalid ones fail.
 */
import "reflect-metadata";

import { TRACKING_HOLD_KINDS } from "@data-pulse-2/db";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ApiPath,
  type OpenApiDocument,
} from "../../_helpers/openapi-contract";

const CONTRACT_ID = "inventory-safety-feed";
const SNAPSHOT_PATH: ApiPath = "/api/pos/v1/inventory-safety/snapshot";
const DELTAS_PATH: ApiPath = "/api/pos/v1/inventory-safety/deltas";
const OPERATIONS: ReadonlyArray<readonly [ApiPath, string]> = [
  [SNAPSHOT_PATH, "posGetInventorySafetySnapshot"],
  [DELTAS_PATH, "posGetInventorySafetyDeltas"],
];
const PATHS: readonly ApiPath[] = OPERATIONS.map(([path]) => path);

type SchemaName = "InventorySafetySnapshotPage" | "InventorySafetyDeltaPage" | "SafetyHold" | "Error";

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

const op = (path: ApiPath) => contractReader(doc).get(path);

function validator(name: SchemaName): ValidateFunction {
  const compiled = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (compiled === undefined) throw new Error(`ajv cannot resolve ${name}`);
  return compiled;
}

const HOLD = {
  hold_id: "0190f5a2-3b4c-7d8e-9f01-00000000000a",
  kind: "recall_hold",
  tracking_identity_id: "0190f5a2-3b4c-7d8e-9f01-00000000000b",
  product_id: "0190f5a2-3b4c-7d8e-9f01-00000000000c",
  identity_kind: "batch",
  identity_code: "LOT-2026-07",
  expiry_date: "2027-01-31",
  reason_code: "supplier_notice",
  recall_id: "0190f5a2-3b4c-7d8e-9f01-00000000000d",
  placed_at: "2026-10-29T10:00:00.000Z",
};
const SNAPSHOT = {
  revision: 7,
  holds: [HOLD],
  next_page_token: null,
  safety_ttl_seconds: 900,
  served_at: "2026-10-29T10:00:01.000Z",
};
const DELTA = {
  from_revision: 7,
  revision: 9,
  upserts: [HOLD],
  removals: [{ hold_id: HOLD.hold_id, tracking_identity_id: HOLD.tracking_identity_id }],
  has_more: false,
  safety_ttl_seconds: 300,
  served_at: "2026-10-29T10:00:02.000Z",
};

describe("inventory-safety-feed — document and operations", () => {
  it("is an OpenAPI 3.1 draft with exactly two GET operations", () => {
    expect([doc.openapi, doc.info?.version]).toEqual(["3.1.0", "1.0.0-draft"]);
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([DELTAS_PATH, SNAPSHOT_PATH]);
    for (const [path, operationId] of OPERATIONS) {
      expect(Object.keys(doc.paths![path]!)).toEqual(["get"]);
      expect(op(path).operationId).toBe(operationId);
      expect(op(path).requestBody).toBeUndefined();
    }
  });

  it("is served by the RT-449 PR 2 runtime: no contract-only marker", () => {
    for (const path of PATHS) {
      expect(op(path)["x-runtime-status"]).toBeUndefined();
      expect(op(path)["x-runtime-note"]).toBeUndefined();
    }
  });

  it("collides with no operationId of any other contract", () => {
    for (const [, operationId] of OPERATIONS) {
      expect(otherOperationIds.has(operationId)).toBe(false);
    }
  });

  it("is a separate feed from the catalogue read-down (G7-7)", () => {
    expect(doc.info?.description).toMatch(/separate feed from the\s+catalogue read-down/);
  });
});

describe("inventory-safety-feed — device authentication only", () => {
  it("secures both operations with the device bearer scheme and nothing else", () => {
    expect(doc.security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["device"]);
    for (const path of PATHS) {
      expect(op(path).security).toEqual([{ device: [] }]);
    }
  });

  it("declares an opaque bearer, never a JWT", () => {
    const scheme = doc.components!.securitySchemes!["device"]!;
    expect([scheme["type"], scheme["scheme"], scheme["bearerFormat"]]).toEqual(["http", "bearer", undefined]);
  });

  it("takes no tenant or store authority from the query: branch_id is checked, never trusted", () => {
    const names = (path: ApiPath) => contractReader(doc).params(path).map((p) => p.name);
    expect(names(SNAPSHOT_PATH)).toEqual(["branch_id", "page_token", "limit"]);
    expect(names(DELTAS_PATH)).toEqual(["since", "branch_id", "limit"]);
    expect(contractReader(doc).param(DELTAS_PATH, "since").required).toBe(true);
    expect(contractReader(doc).param(SNAPSHOT_PATH, "branch_id").required).toBe(false);
  });
});

describe("inventory-safety-feed — responses", () => {
  const statuses = (path: ApiPath) => Object.keys(op(path).responses ?? {}).sort();

  it("answers snapshot 200/400/401/404/500 and deltas the same plus 409", () => {
    expect(statuses(SNAPSHOT_PATH)).toEqual(["200", "400", "401", "404", "500"]);
    expect(statuses(DELTAS_PATH)).toEqual(["200", "400", "401", "404", "409", "500"]);
    expect(op(DELTAS_PATH).responses?.["409"]).toEqual({ $ref: "#/components/responses/SnapshotRequired" });
  });

  it("names the closed error code set of the surface", () => {
    for (const code of ["validation_error", "unauthorized", "not_found", "snapshot_required", "internal_error"]) {
      expect(doc.info?.description).toContain(code);
    }
    expect(contractReader(doc).responseDescription("Unauthorized")).toContain("store_context_required");
  });

  it("sends the device-token rotation hints on every 200", () => {
    for (const path of PATHS) {
      const ok = op(path).responses?.["200"];
      expect(Object.keys(ok?.headers ?? {})).toEqual(["X-Device-Token-Rotate-After", "X-Device-Token-Rotate-Stage"]);
    }
  });
});

describe("inventory-safety-feed — schemas", () => {
  const schema = (name: string) => contractReader(doc).schema(name) as Record<string, unknown>;

  it("counts the revision from 0 as an int64", () => {
    expect(schema("FeedRevision")).toMatchObject({ type: "integer", format: "int64", minimum: 0 });
  });

  it("bounds the Safety TTL to 60-900 seconds (H8)", () => {
    expect(schema("SafetyTtlSeconds")).toMatchObject({ type: "integer", minimum: 60, maximum: 900 });
  });

  it("projects the database's hold kinds", () => {
    const kind = (schema("SafetyHold")["properties"] as Record<string, { enum?: string[] }>)["kind"];
    expect(kind?.enum).toEqual([...TRACKING_HOLD_KINDS]);
  });

  it("accepts a valid snapshot page, delta page and hold", () => {
    expect(validator("InventorySafetySnapshotPage")(SNAPSHOT)).toBe(true);
    expect(validator("InventorySafetyDeltaPage")(DELTA)).toBe(true);
    expect(validator("SafetyHold")({ ...HOLD, kind: "quality_hold", recall_id: null, expiry_date: null })).toBe(
      true,
    );
  });

  it.each([
    ["an unknown field", { ...SNAPSHOT, tenant_id: HOLD.product_id }],
    ["a negative revision", { ...SNAPSHOT, revision: -1 }],
    ["a TTL above 900", { ...SNAPSHOT, safety_ttl_seconds: 901 }],
    ["a TTL below 60", { ...SNAPSHOT, safety_ttl_seconds: 59 }],
    ["a missing next_page_token", (({ next_page_token: _, ...rest }) => rest)(SNAPSHOT)],
    ["an unknown hold kind", { ...SNAPSHOT, holds: [{ ...HOLD, kind: "sell_hold" }] }],
  ])("refuses a snapshot page with %s", (_label, payload) => {
    expect(validator("InventorySafetySnapshotPage")(payload)).toBe(false);
  });

  it.each([
    ["a removal with extra fields", { ...DELTA, removals: [{ ...DELTA.removals[0], kind: "quality_hold" }] }],
    ["a missing has_more", (({ has_more: _, ...rest }) => rest)(DELTA)],
  ])("refuses a delta page with %s", (_label, payload) => {
    expect(validator("InventorySafetyDeltaPage")(payload)).toBe(false);
  });

  it("accepts the canonical error envelope", () => {
    expect(validator("Error")({ error: { code: "snapshot_required", message: "snapshot_required" } })).toBe(true);
  });
});
