/**
 * apps/api/test/inventory/contract/inventory.contract.spec.ts
 *
 * Slice 009-CONTRACT (T010 + T011) — OpenAPI conformance test for
 * `packages/contracts/openapi/inventory/inventory.yaml`.
 *
 * Mirrors `apps/api/test/catalog/sales/contract/sales.contract.spec.ts`:
 *
 *   * Loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts` uses `readdirSync(dir)`
 *     with no recursive flag). The nested `inventory/` sub-directory is
 *     therefore NOT picked up by the umbrella `loadOpenApiContracts()` call, so
 *     it must be loaded explicitly here. T011 is consequently a no-op: there is
 *     no central YAML registry to extend (same verdict as 005 T504 / 008 T011).
 *
 *   * Asserts presence of the five 009 operationIds (plus RT-432's listStockLocations
 *     and RT-448's listTrackingIdentities) and their uniqueness against
 *     the existing top-level contracts (stop condition: "if any operationId
 *     collides with or renames a shipped 005/007/008 operationId").
 *
 *   * Asserts the AUTH SPLIT (plan §4.2): the five operator operations are
 *     secured with `cookieAuth` (NOT a `/api/pos/v1/` device-token surface —
 *     a 009 stop condition). The retired sale-linked backfill and its
 *     `platformAdmin` scheme are gone (RT-1099).
 *
 *   * Asserts the write operations declare the REQUIRED `Idempotency-Key`
 *     header (FR-030); the read does not.
 *
 *   * Verifies structural conventions: OpenAPI 3.1 of record, the `cookieAuth`
 *     `dp2_session` scheme (mirrors `auth.openapi.yaml` / `outbox.openapi.yaml`),
 *     the canonical `Error` envelope, the on-hand projection carrying the
 *     `negativeBalance` flag (FR-024), strict command schemas (no
 *     mass-assignment, FR-052), and the ABSENCE of any PII / money / payment /
 *     tender field name (§XIV).
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * controller / service are authored in the 009-US1-ONHAND slice onward.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import {
  INVENTORY_REASON_CODES,
  INVENTORY_STATUSES,
  RETURN_LANDING_STATUSES,
  SAFETY_REASON_CODE_PATTERN,
  TRACKING_HOLD_KINDS,
} from "@data-pulse-2/db";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "inventory";

const OPERATION_IDS = [
  "createStockMovement",
  "getOnHand",
  "listStockMovements",
  "createStockTransfer",
  "recordStockCount",
  "listStockLocations",
  "listTrackingIdentities",
  // RT-435: status moves, relocations and the return landing policy.
  "createStatusMove",
  "createRelocation",
  "getReturnLandingPolicy",
  "setReturnLandingPolicy",
  // RT-449: tracking holds, recall and the identity expiry correction.
  "placeQualityHold",
  "getTrackingHold",
  "releaseTrackingHold",
  "createInventoryRecall",
  "getInventoryRecall",
  "correctTrackingIdentityExpiry",
  // RT-449 PR 2: the Safety TTL setting and the computed safety findings.
  "getSafetyTtlSetting",
  "setSafetyTtlSetting",
  "listInventorySafetyFindings",
  // RT-1081: the tracking Console reads.
  "listTrackingHolds",
  "listInventoryRecalls",
  "getTrackingIdentity",
  "getTrackingIdentityPositions",
  "listTrackingIdentityExpiryCorrections",
  // RT-451 Step 0 (contract-only): the Tracking Resolution queue, its bind and
  // the sale-line findings.
  "listTrackingResolutionQueue",
  "bindTrackingResolution",
  "listSaleLineFindings",
  // RT-451 S2 (contract-only): the tenant's tracked-selling on/off setting.
  "getTrackedSellingSetting",
  "setTrackedSellingSetting",
] as const;

// Operator-surface ops use cookieAuth.
const OPERATOR_OPERATION_IDS = [
  "createStockMovement",
  "getOnHand",
  "listStockMovements",
  "createStockTransfer",
  "recordStockCount",
  "listStockLocations",
  "listTrackingIdentities",
  "createStatusMove",
  "createRelocation",
  "getReturnLandingPolicy",
  "setReturnLandingPolicy",
  "placeQualityHold",
  "getTrackingHold",
  "releaseTrackingHold",
  "createInventoryRecall",
  "getInventoryRecall",
  "correctTrackingIdentityExpiry",
  "getSafetyTtlSetting",
  "setSafetyTtlSetting",
  "listInventorySafetyFindings",
  // RT-1081: the tracking Console reads.
  "listTrackingHolds",
  "listInventoryRecalls",
  "getTrackingIdentity",
  "getTrackingIdentityPositions",
  "listTrackingIdentityExpiryCorrections",
  "listTrackingResolutionQueue",
  "bindTrackingResolution",
  "listSaleLineFindings",
  "getTrackedSellingSetting",
  "setTrackedSellingSetting",
];

// Write ops that MUST carry a required Idempotency-Key.
const WRITE_OPERATION_IDS = [
  "createStockMovement",
  "createStockTransfer",
  "recordStockCount",
  "createStatusMove",
  "createRelocation",
  "placeQualityHold",
  "createInventoryRecall",
  "correctTrackingIdentityExpiry",
  "bindTrackingResolution",
];
// releaseTrackingHold is naturally idempotent (a released hold is final; a
// second release writes nothing), so it carries no Idempotency-Key.
// setReturnLandingPolicy, setSafetyTtlSetting and setTrackedSellingSetting are
// PUTs of the whole value: repeating one is naturally idempotent, so it carries
// no Idempotency-Key (and is in neither list).
const READ_OPERATION_IDS = [
  "getOnHand",
  "listStockMovements",
  "listStockLocations",
  "listTrackingIdentities",
  "getReturnLandingPolicy",
  "getTrackingHold",
  "getInventoryRecall",
  "releaseTrackingHold",
  "getSafetyTtlSetting",
  "listInventorySafetyFindings",
  // RT-1081: the tracking Console reads.
  "listTrackingHolds",
  "listInventoryRecalls",
  "getTrackingIdentity",
  "getTrackingIdentityPositions",
  "listTrackingIdentityExpiryCorrections",
  "listTrackingResolutionQueue",
  "listSaleLineFindings",
  "getTrackedSellingSetting",
];

const MOVEMENTS_PATH = "/api/inventory/v1/stores/{storeId}/movements";
const ON_HAND_PATH = "/api/inventory/v1/on-hand/{storeId}/{productId}";
const TRANSFERS_PATH = "/api/inventory/v1/transfers";
const COUNTS_PATH = "/api/inventory/v1/stores/{storeId}/counts";
const LOCATIONS_PATH = "/api/inventory/v1/stores/{storeId}/locations";
const TRACKING_IDENTITIES_PATH = "/api/inventory/v1/products/{productId}/tracking-identities";
const STATUS_MOVES_PATH = "/api/inventory/v1/stores/{storeId}/status-moves";
const RELOCATIONS_PATH = "/api/inventory/v1/stores/{storeId}/relocations";
const RETURN_LANDING_PATH = "/api/inventory/v1/settings/return-landing";
const HOLDS_PATH = "/api/inventory/v1/tracking-holds";
const HOLD_PATH = "/api/inventory/v1/tracking-holds/{holdId}";
const HOLD_RELEASE_PATH = "/api/inventory/v1/tracking-holds/{holdId}/release";
const RECALLS_PATH = "/api/inventory/v1/recalls";
const RECALL_PATH = "/api/inventory/v1/recalls/{recallId}";
const EXPIRY_CORRECTIONS_PATH = "/api/inventory/v1/tracking-identities/{identityId}/expiry-corrections";
const SAFETY_TTL_PATH = "/api/inventory/v1/settings/safety-ttl";
const SAFETY_FINDINGS_PATH = "/api/inventory/v1/safety/findings";
const IDENTITY_PATH = "/api/inventory/v1/tracking-identities/{identityId}";
const IDENTITY_POSITIONS_PATH = "/api/inventory/v1/tracking-identities/{identityId}/positions";
const SALE_LINE_FINDINGS_PATH = "/api/inventory/v1/safety/sale-line-findings";
const RESOLUTION_QUEUE_PATH = "/api/inventory/v1/tracking-resolutions";
const RESOLUTION_BIND_PATH = "/api/inventory/v1/tracking-resolutions/{saleId}/bind";
const TRACKED_SELLING_PATH = "/api/inventory/v1/settings/tracked-selling";

// Field-name substrings forbidden anywhere in the contract (§XIV — no PII /
// money / payment / tender on the inventory ledger in v1).
const FORBIDDEN_FIELD_SUBSTRINGS = [
  "currency",
  "money",
  "amount",
  "price",
  "tender",
  "payment",
  "card",
  "cash",
  "customer",
  "email",
  "phone",
  "address",
];

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    $ref?: string;
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: Record<string, unknown>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  pattern?: string;
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, Record<string, unknown>>;
    responses?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

let inventoryDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

/**
 * Resolve the inventory contract directory from this spec file's location.
 *
 * Layout:
 *   apps/api/test/inventory/contract/inventory.contract.spec.ts
 *   →  ../../../../..  = <repo root>
 *   →  <repo root>/packages/contracts/openapi/inventory
 */
function inventoryContractsDir(): string {
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    "inventory",
  );
}

beforeAll(() => {
  const inventoryContracts = loadOpenApiContracts({ dir: inventoryContractsDir() });
  const newContract = inventoryContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = inventoryContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${inventoryContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  inventoryDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the *existing* top-level contracts so
  // the uniqueness check can reject any collision/rename. The default-dir
  // loader exercises the same surface production startup uses.
  const topLevelContracts = loadOpenApiContracts();
  topLevelOperationIds = new Set<string>();
  for (const contract of topLevelContracts) {
    const doc = contract.document as OpenApiDocument;
    if (!doc.paths) continue;
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") {
          topLevelOperationIds.add(op.operationId);
        }
      }
    }
  }
});

function inventoryOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = inventoryDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return inventoryOperations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("inventory/inventory.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(inventoryDoc).toBeDefined();
    expect(typeof inventoryDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(inventoryDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(inventoryDoc.info?.title).toEqual(expect.any(String));
    expect(inventoryDoc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares the cookieAuth dp2_session scheme (mirrors auth/outbox contracts)", () => {
    const schemes = inventoryDoc.components?.securitySchemes ?? {};
    const cookie = schemes["cookieAuth"] as
      | { type?: string; in?: string; name?: string }
      | undefined;
    expect(cookie?.type).toBe("apiKey");
    expect(cookie?.in).toBe("cookie");
    expect(cookie?.name).toBe("dp2_session");
  });

  it("declares no platformAdmin scheme: the retired backfill was its only user (RT-1099)", () => {
    const schemes = inventoryDoc.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(["cookieAuth"]);
  });
});

// ===========================================================================
// 2. Operations present, uniquely named, correctly secured
// ===========================================================================
describe("inventory/inventory.yaml — operations", () => {
  it("declares exactly the six 009 operationIds, RT-432's listStockLocations, RT-448's listTrackingIdentities, RT-435's four, RT-449's nine, RT-451's five and RT-1081's five", () => {
    const ids = inventoryOperations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps each operationId to its expected path + method", () => {
    expect(inventoryDoc.paths?.[MOVEMENTS_PATH]?.["post"]?.operationId).toBe(
      "createStockMovement",
    );
    expect(inventoryDoc.paths?.[MOVEMENTS_PATH]?.["get"]?.operationId).toBe(
      "listStockMovements",
    );
    expect(inventoryDoc.paths?.[ON_HAND_PATH]?.["get"]?.operationId).toBe("getOnHand");
    expect(inventoryDoc.paths?.[TRANSFERS_PATH]?.["post"]?.operationId).toBe(
      "createStockTransfer",
    );
    expect(inventoryDoc.paths?.[COUNTS_PATH]?.["post"]?.operationId).toBe(
      "recordStockCount",
    );
    expect(inventoryDoc.paths?.[LOCATIONS_PATH]?.["get"]?.operationId).toBe(
      "listStockLocations",
    );
    expect(inventoryDoc.paths?.[TRACKING_IDENTITIES_PATH]?.["get"]?.operationId).toBe(
      "listTrackingIdentities",
    );
    expect(inventoryDoc.paths?.[STATUS_MOVES_PATH]?.["post"]?.operationId).toBe("createStatusMove");
    expect(inventoryDoc.paths?.[RELOCATIONS_PATH]?.["post"]?.operationId).toBe("createRelocation");
    expect(inventoryDoc.paths?.[RETURN_LANDING_PATH]?.["get"]?.operationId).toBe(
      "getReturnLandingPolicy",
    );
    expect(inventoryDoc.paths?.[RETURN_LANDING_PATH]?.["put"]?.operationId).toBe(
      "setReturnLandingPolicy",
    );
  });

  it.each([
    [HOLDS_PATH, "post", "placeQualityHold"],
    [HOLD_PATH, "get", "getTrackingHold"],
    [HOLD_RELEASE_PATH, "post", "releaseTrackingHold"],
    [RECALLS_PATH, "post", "createInventoryRecall"],
    [RECALL_PATH, "get", "getInventoryRecall"],
    [EXPIRY_CORRECTIONS_PATH, "post", "correctTrackingIdentityExpiry"],
    [SAFETY_TTL_PATH, "get", "getSafetyTtlSetting"],
    [SAFETY_TTL_PATH, "put", "setSafetyTtlSetting"],
    [SAFETY_FINDINGS_PATH, "get", "listInventorySafetyFindings"],
    [HOLDS_PATH, "get", "listTrackingHolds"],
    [RECALLS_PATH, "get", "listInventoryRecalls"],
    [IDENTITY_PATH, "get", "getTrackingIdentity"],
    [IDENTITY_POSITIONS_PATH, "get", "getTrackingIdentityPositions"],
    [EXPIRY_CORRECTIONS_PATH, "get", "listTrackingIdentityExpiryCorrections"],
  ])("RT-449 / RT-1081: maps %s %s to %s", (path, method, operationId) => {
    expect(inventoryDoc.paths?.[path]?.[method]?.operationId).toBe(operationId);
  });

  it("does NOT collide with or rename any shipped top-level operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(topLevelOperationIds.has(id)).toBe(false);
    }
  });

  it("secures every operator operation with cookieAuth", () => {
    for (const id of OPERATOR_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      expect(op?.security).toContainEqual({ cookieAuth: [] });
    }
  });


  it("models NO operation as a /api/pos/v1/ device-token route (009 is a cookieAuth surface)", () => {
    const paths = Object.keys(inventoryDoc.paths ?? {});
    for (const p of paths) {
      expect(p.startsWith("/api/pos/")).toBe(false);
      expect(p.startsWith("/api/inventory/v1/")).toBe(true);
    }
  });
});

// ===========================================================================
// 3. Idempotency — required Idempotency-Key on every write
// ===========================================================================
describe("inventory/inventory.yaml — idempotency", () => {
  it("requires the Idempotency-Key header on every write operation", () => {
    for (const id of WRITE_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      const params = op?.parameters ?? [];
      const hasIdempotencyRef = params.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(hasIdempotencyRef).toBe(true);
    }
    const idemParam = inventoryDoc.components?.parameters?.["IdempotencyKey"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(idemParam?.name).toBe("Idempotency-Key");
    expect(idemParam?.in).toBe("header");
    expect(idemParam?.required).toBe(true);
  });

  it("does NOT require an Idempotency-Key on read operations", () => {
    for (const id of READ_OPERATION_IDS) {
      const params = findOp(id)?.parameters ?? [];
      const hasIdempotencyRef = params.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(hasIdempotencyRef).toBe(false);
    }
  });
});

// ===========================================================================
// 4. Projections + envelope conventions
// ===========================================================================
describe("inventory/inventory.yaml — projections + envelope", () => {
  it("declares the canonical Error envelope (error.code + error.message)", () => {
    const err = inventoryDoc.components?.schemas?.["Error"];
    expect(err).toBeDefined();
    expect(err?.required).toContain("error");
  });

  it("movement projection carries the acting principal createdBy (FR-004)", () => {
    const mv = inventoryDoc.components?.schemas?.["StockMovement"];
    expect(mv).toBeDefined();
    expect(mv?.required).toContain("createdBy");
    const props = (mv?.properties ?? {}) as Record<string, { format?: string }>;
    expect(props["createdBy"]).toBeDefined();
  });

  it("on-hand projection carries the negativeBalance flag (FR-024)", () => {
    const onHand = inventoryDoc.components?.schemas?.["OnHand"];
    expect(onHand).toBeDefined();
    expect(onHand?.required).toContain("negativeBalance");
    const props = (onHand?.properties ?? {}) as Record<
      string,
      { type?: string | string[] }
    >;
    expect(props["negativeBalance"]?.type).toBe("boolean");
  });

  it("bounds DecimalQuantity to the numeric(19,4) Zod shape", () => {
    // inventory.controller.ts DecimalQtySchema: ≤15 integer digits, ≤4 fraction digits.
    expect(inventoryDoc.components?.schemas?.["DecimalQuantity"]?.pattern).toBe(
      "^-?\\d{1,15}(\\.\\d{1,4})?$",
    );
  });

  it("command schemas are strict (additionalProperties: false — mass-assignment ban, FR-052)", () => {
    const commandSchemas = [
      "CreateStockMovementCommand",
      "CreateStockTransferCommand",
      "RecordStockCountCommand",
      "CreateStatusMoveCommand",
      "CreateRelocationCommand",
      "SetReturnLandingPolicyCommand",
      "SetSafetyTtlSettingCommand",
      "SetTrackedSellingSettingCommand",
      "PlaceQualityHoldCommand",
      "ReleaseTrackingHoldCommand",
      "CreateInventoryRecallCommand",
      "CorrectTrackingIdentityExpiryCommand",
    ];
    for (const name of commandSchemas) {
      const schema = inventoryDoc.components?.schemas?.[name];
      expect(schema).toBeDefined();
      expect(schema?.additionalProperties).toBe(false);
    }
  });
});

// ===========================================================================
// 5. No PII / money / payment / tender field names anywhere (§XIV)
// ===========================================================================
describe("inventory/inventory.yaml — §XIV no PII/payment", () => {
  it("declares no field name matching a PII / money / payment / tender substring", () => {
    const offenders: string[] = [];
    const schemas = inventoryDoc.components?.schemas ?? {};
    for (const [schemaName, schema] of Object.entries(schemas)) {
      const props = schema.properties ?? {};
      for (const fieldName of Object.keys(props)) {
        const lower = fieldName.toLowerCase();
        for (const bad of FORBIDDEN_FIELD_SUBSTRINGS) {
          if (lower.includes(bad)) {
            offenders.push(`${schemaName}.${fieldName} (matched "${bad}")`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// 6. RT-425 — Inventory Effects Journal read fields (additive, 1.1.0-draft)
// ===========================================================================
describe("inventory/inventory.yaml — RT-425 effect projection", () => {
  const props = (): Record<string, { type?: unknown; enum?: unknown[]; format?: string }> =>
    (inventoryDoc.components?.schemas?.["StockMovement"]?.properties ?? {}) as Record<
      string,
      { type?: unknown; enum?: unknown[]; format?: string }
    >;

  it("projects the effect origin as a required retail | erp_external enum (G2-2)", () => {
    expect(props()["origin"]?.enum).toEqual(["retail", "erp_external"]);
    expect(inventoryDoc.components?.schemas?.["StockMovement"]?.required).toContain("origin");
  });

  it("projects the nullable integration state with exactly the RT-289 G2-3 states plus RT-435's erp_neutral", () => {
    expect(props()["integrationState"]?.type).toEqual(["string", "null"]);
    expect(props()["integrationState"]?.enum).toEqual([
      "not_posted",
      "pending",
      "confirmed",
      "rejected",
      "reconciliation_required",
      "external",
      "erp_neutral",
      null,
    ]);
  });

  it("projects erpConfirmedAt as a nullable date-time (G2-4)", () => {
    expect(props()["erpConfirmedAt"]?.type).toEqual(["string", "null"]);
    expect(props()["erpConfirmedAt"]?.format).toBe("date-time");
  });

  it("keeps the new read fields optional for older consumers (only origin is required)", () => {
    const required = inventoryDoc.components?.schemas?.["StockMovement"]?.required ?? [];
    expect(required).not.toContain("integrationState");
    expect(required).not.toContain("erpConfirmedAt");
  });

  it("no longer models the retired sale-linked backfill (RT-289 Q3, removed by RT-1099)", () => {
    expect(findOp("backfillSaleLinkedMovements")).toBeUndefined();
    expect(Object.keys(inventoryDoc.paths ?? {})).not.toContain(
      "/api/inventory/v1/admin/sale-linked-backfill",
    );
    const schemas = Object.keys(inventoryDoc.components?.schemas ?? {});
    for (const name of ["SaleLinkedBackfillCommand", "SaleLinkedBackfillItem", "SaleLinkedBackfillResult"]) {
      expect(schemas).not.toContain(name);
    }
    expect(Object.keys(inventoryDoc.components?.responses ?? {})).not.toContain("RateLimited");
    expect((inventoryDoc.tags ?? []).map((t) => t.name)).not.toContain("inventory-admin");
  });
});

// ===========================================================================
// 7. RT-432 — inventory position grain (additive, 1.2.0-draft)
// ===========================================================================
describe("inventory/inventory.yaml — RT-432 position grain", () => {
  type Prop = { type?: unknown; enum?: unknown[]; format?: string; $ref?: string; allOf?: Array<{ $ref?: string }> };
  const schema = (name: string): { properties?: Record<string, Prop>; required?: string[]; enum?: unknown[] } =>
    (inventoryDoc.components?.schemas?.[name] ?? {}) as {
      properties?: Record<string, Prop>;
      required?: string[];
      enum?: unknown[];
    };
  const STATUS_REF = "#/components/schemas/InventoryStatus";

  it("declares the closed InventoryStatus enum of RT-290 G4-2, matching the schema", () => {
    expect(schema("InventoryStatus").enum).toEqual([...INVENTORY_STATUSES]);
  });

  it("projects every movement's required stock location, status and positionInterpreted flag", () => {
    const mv = schema("StockMovement");
    expect(mv.properties?.["stockLocationId"]?.format).toBe("uuid");
    expect(mv.properties?.["inventoryStatus"]?.$ref).toBe(STATUS_REF);
    expect(mv.properties?.["positionInterpreted"]?.type).toBe("boolean");
    expect(mv.required).toEqual(
      expect.arrayContaining(["stockLocationId", "inventoryStatus", "positionInterpreted"]),
    );
  });

  it("lets a manual movement name an optional location and status, nothing else new", () => {
    const cmd = schema("CreateStockMovementCommand");
    expect(cmd.properties?.["stockLocationId"]?.format).toBe("uuid");
    expect(cmd.properties?.["inventoryStatus"]?.allOf?.[0]?.$ref).toBe(STATUS_REF);
    expect(cmd.required).toEqual(["movementType", "quantity", "stockingUnit"]);
  });

  it("keeps OnHand.quantity the physical total and adds the per-status breakdown", () => {
    const oh = schema("OnHand");
    expect(oh.required).toEqual(
      expect.arrayContaining(["quantity", "sellableQuantity", "statusQuantities"]),
    );
    expect(oh.properties?.["quantity"]?.$ref).toBe("#/components/schemas/DecimalQuantity");
  });

  it("lists a store's locations read-only, behind cookieAuth, with no Idempotency-Key", () => {
    const paths = inventoryDoc.paths?.[LOCATIONS_PATH] ?? {};
    expect(Object.keys(paths).filter((m) => m !== "parameters")).toEqual(["get"]);
    expect(schema("StockLocation").properties?.["kind"]?.enum).toEqual(["primary", "storage"]);
  });

  it("returns erp_neutral from 1.6.0-draft, when RT-435 assigns it (Q10)", () => {
    expect(schema("StockMovement").properties?.["integrationState"]?.enum).toContain(
      "erp_neutral",
    );
  });
});

// ===========================================================================
// 8. RT-448 — tracking foundation (additive, 1.3.0-draft)
// ===========================================================================
describe("inventory/inventory.yaml — RT-448 tracking foundation", () => {
  type Prop = { type?: unknown; enum?: unknown[]; format?: string; maxLength?: number };
  const schema = (
    name: string,
  ): {
    properties?: Record<string, Prop>;
    required?: string[];
    additionalProperties?: unknown;
  } =>
    (inventoryDoc.components?.schemas?.[name] ?? {}) as {
      properties?: Record<string, Prop>;
      required?: string[];
      additionalProperties?: unknown;
    };

  it("projects every movement's nullable trackingIdentityId", () => {
    const mv = schema("StockMovement");
    expect(mv.properties?.["trackingIdentityId"]?.type).toEqual(["string", "null"]);
    expect(mv.properties?.["trackingIdentityId"]?.format).toBe("uuid");
    expect(mv.required).toContain("trackingIdentityId");
  });

  it("adds no tracking field to the movement command (tracked selling is not active)", () => {
    expect(schema("CreateStockMovementCommand").properties?.["trackingIdentityId"]).toBeUndefined();
  });

  it("lists a product's identities read-only, with no Idempotency-Key", () => {
    const paths = inventoryDoc.paths?.[TRACKING_IDENTITIES_PATH] ?? {};
    expect(Object.keys(paths).filter((m) => m !== "parameters")).toEqual(["get"]);
  });

  it("pages the identity list: bounded limit, opaque cursor, nextCursor", () => {
    const params = findOp("listTrackingIdentities")?.parameters ?? [];
    const limit = params.find((p) => p.name === "limit");
    expect(limit?.schema).toMatchObject({ maximum: 200 });
    expect(params.some((p) => p.name === "cursor")).toBe(true);
    const list = schema("TrackingIdentityList") as { required?: string[]; properties?: Record<string, { maxItems?: number }> };
    expect(list.required).toEqual(["items", "nextCursor"]);
    expect(list.properties?.["items"]?.maxItems).toBe(200);
  });

  it("projects a strict TrackingIdentity: typed kind, bounded code, ERP-born origin", () => {
    const ti = schema("TrackingIdentity");
    expect(ti.additionalProperties).toBe(false);
    expect(ti.required).toEqual(
      expect.arrayContaining(["id", "productId", "kind", "code", "expiryDate", "origin"]),
    );
    expect(ti.properties?.["kind"]?.enum).toEqual(["batch", "serial"]);
    expect(ti.properties?.["code"]?.maxLength).toBe(128);
    expect(ti.properties?.["expiryDate"]?.format).toBe("date");
    expect(ti.properties?.["origin"]?.enum).toEqual(["erp_external"]);
  });

  it("never projects an ERPNext document name (M-9)", () => {
    const names = Object.keys(schema("TrackingIdentity").properties ?? {}).map((n) =>
      n.toLowerCase(),
    );
    expect(names.some((n) => n.includes("erp"))).toBe(false);
  });
});

// ===========================================================================
// 9. RT-435 — status moves, relocations, return landing policy (1.6.0-draft)
// ===========================================================================
describe("inventory/inventory.yaml — RT-435 position events", () => {
  type Prop = { type?: unknown; enum?: unknown[]; format?: string; maxLength?: number; $ref?: string };
  const schema = (
    name: string,
  ): { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: unknown } =>
    (inventoryDoc.components?.schemas?.[name] ?? {}) as {
      properties?: Record<string, Prop>;
      required?: string[];
      additionalProperties?: unknown;
    };

  it("declares the governed Reason Codes of D1, matching the schema", () => {
    expect(schema("InventoryReasonCode") as { enum?: unknown[] }).toMatchObject({
      enum: [...INVENTORY_REASON_CODES],
    });
  });

  it("status move: required statuses and reason code, optional location and note, no tracking field", () => {
    const cmd = schema("CreateStatusMoveCommand");
    expect(cmd.required).toEqual(
      expect.arrayContaining(["tenantProductRef", "quantity", "stockingUnit", "fromStatus", "toStatus", "reasonCode"]),
    );
    expect(cmd.required).not.toContain("stockLocationId");
    expect(cmd.properties?.["quantity"]?.$ref).toBe("#/components/schemas/PositiveDecimalQuantity");
    expect(cmd.properties?.["note"]?.maxLength).toBe(500);
    expect(cmd.properties?.["trackingIdentityId"]).toBeUndefined();
  });

  it("relocation: two required locations, optional status and reason code, no tracking field", () => {
    const cmd = schema("CreateRelocationCommand");
    expect(cmd.required).toEqual(
      expect.arrayContaining(["tenantProductRef", "quantity", "stockingUnit", "fromLocationId", "toLocationId"]),
    );
    expect(cmd.required).not.toContain("reasonCode");
    expect(cmd.properties?.["trackingIdentityId"]).toBeUndefined();
  });

  it("projects the event with both effects and a nullable tracking identity", () => {
    const ev = schema("InventoryPositionEvent");
    expect(ev.properties?.["kind"]?.enum).toEqual(["status_move", "relocation"]);
    expect(ev.required).toEqual(expect.arrayContaining(["fromEffect", "toEffect", "trackingIdentityId"]));
    expect(ev.properties?.["trackingIdentityId"]?.type).toEqual(["string", "null"]);
  });

  it("the return landing policy is sellable | return_inspection, strict on write", () => {
    expect(schema("ReturnLandingStatus") as { enum?: unknown[] }).toMatchObject({
      enum: [...RETURN_LANDING_STATUSES],
    });
    expect(schema("SetReturnLandingPolicyCommand").additionalProperties).toBe(false);
  });

  it("documents the 409 conflict codes of a position event", () => {
    const conflict = inventoryDoc.components?.responses?.["PositionEventConflict"] as
      | { description?: string }
      | undefined;
    for (const code of ["idempotency_key_conflict", "erp_transfer_intent_required", "tracking_identity_required"]) {
      expect(conflict?.description).toContain(code);
    }
    expect(findOp("createStatusMove")?.responses?.["409"]).toEqual({
      $ref: "#/components/responses/PositionEventConflict",
    });
  });
});

// ===========================================================================
// RT-449 — tracking holds, recall and the Inventory Safety Revision
// ===========================================================================
describe("inventory/inventory.yaml — RT-449 holds, recall and safety revision", () => {
  type Prop = { type?: unknown; enum?: unknown[]; format?: string; maxItems?: number; minItems?: number; uniqueItems?: boolean; $ref?: string };
  const schema = (name: string): { properties?: Record<string, Prop>; required?: string[]; pattern?: string } =>
    (inventoryDoc.components?.schemas?.[name] ?? {}) as {
      properties?: Record<string, Prop>;
      required?: string[];
      pattern?: string;
    };

  it("bounds reason codes to the 0072 machine-code shape, matching the db pattern", () => {
    expect(schema("SafetyReasonCode").pattern).toBe(SAFETY_REASON_CODE_PATTERN.source);
  });

  it("answers every command with the Safety Revision it produced", () => {
    for (const name of ["TrackingHoldResult", "InventoryRecallResult", "TrackingIdentityExpiryCorrectionResult"]) {
      expect(schema(name).required).toContain("safetyRevision");
      expect(schema(name).properties?.["safetyRevision"]?.$ref).toBe("#/components/schemas/SafetyRevision");
    }
  });

  it("projects a hold with its typed kind, recall and release", () => {
    const hold = schema("TrackingHold");
    expect(hold.properties?.["kind"]?.enum).toEqual([...TRACKING_HOLD_KINDS]);
    expect(hold.required).toEqual(expect.arrayContaining(["recallId", "releasedAt", "active"]));
  });

  it("bounds a recall to 1-100 distinct identities", () => {
    const ids = schema("CreateInventoryRecallCommand").properties?.["trackingIdentityIds"];
    expect(ids).toMatchObject({ minItems: 1, maxItems: 100, uniqueItems: true });
  });

  it("takes the expiry correction as a required, nullable date", () => {
    const cmd = schema("CorrectTrackingIdentityExpiryCommand");
    expect(cmd.required).toContain("expiryDate");
    expect(cmd.properties?.["expiryDate"]).toMatchObject({ type: ["string", "null"], format: "date" });
  });

  it("documents the 409 conflict codes of a safety command", () => {
    const conflict = inventoryDoc.components?.responses?.["SafetyConflict"] as { description?: string } | undefined;
    for (const code of ["hold_already_active", "expiry_unchanged", "idempotency_key_conflict"]) {
      expect(conflict?.description).toContain(code);
    }
    for (const id of ["placeQualityHold", "createInventoryRecall", "correctTrackingIdentityExpiry"]) {
      expect(findOp(id)?.responses?.["409"]).toEqual({ $ref: "#/components/responses/SafetyConflict" });
    }
  });
});

// ===========================================================================
// RT-449 PR 2 — the Safety TTL setting and the computed safety findings
// ===========================================================================
describe("inventory/inventory.yaml — RT-449 PR 2 Safety TTL and findings", () => {
  type Prop = { type?: unknown; enum?: unknown[]; const?: unknown; minimum?: number; maximum?: number; $ref?: string };
  type Schema = {
    properties?: Record<string, Prop>;
    required?: string[];
    additionalProperties?: unknown;
    oneOf?: Array<{ $ref?: string }>;
    discriminator?: { propertyName?: string; mapping?: Record<string, string> };
  };
  const schema = (name: string): Schema => (inventoryDoc.components?.schemas?.[name] ?? {}) as Schema;
  const FINDINGS = [
    "ActiveTrackingHoldFinding",
    "ExpiredLotSellableFinding",
    "ExpiringLotFinding",
    "TrackingConsistencyFinding",
  ];

  it("was introduced at 1.8.0-draft (version moved on in RT-451 Step 0)", () => {
    expect(inventoryDoc.info?.description).toContain("**1.8.0-draft (RT-449 PR 2, additive;");
  });

  it("bounds the Safety TTL to 60-900 seconds, null meaning the default (H8)", () => {
    const cmd = schema("SetSafetyTtlSettingCommand").properties?.["safetyTtlSeconds"];
    expect(cmd).toMatchObject({ type: ["integer", "null"], minimum: 60, maximum: 900 });
    const setting = schema("SafetyTtlSetting");
    expect(setting.additionalProperties).toBe(false);
    expect(setting.required).toEqual(["safetyTtlSeconds", "effectiveSafetyTtlSeconds", "updatedAt"]);
    expect(setting.properties?.["effectiveSafetyTtlSeconds"]).toMatchObject({ type: "integer", minimum: 60, maximum: 900 });
  });

  it("answers a PUT of the Safety TTL with 400 on a refused value", () => {
    expect(findOp("setSafetyTtlSetting")?.responses?.["400"]).toEqual({
      $ref: "#/components/responses/ValidationFailure",
    });
  });

  it("lists findings as a closed, discriminated union of four strict kinds", () => {
    const finding = schema("InventorySafetyFinding");
    expect(finding.oneOf?.map((o) => o.$ref)).toEqual(FINDINGS.map((n) => `#/components/schemas/${n}`));
    expect(finding.discriminator?.propertyName).toBe("kind");
    expect(Object.keys(finding.discriminator?.mapping ?? {})).toEqual([
      "active_tracking_hold",
      "expired_lot_sellable",
      "expiring_lot",
      "tracking_consistency",
    ]);
    for (const name of FINDINGS) {
      expect(schema(name).additionalProperties).toBe(false);
      expect(schema(name).required).toEqual(expect.arrayContaining(["kind", "severity", "trackingIdentityId"]));
    }
  });

  it("rates an active hold and an expired sellable lot critical, a reserved expiring lot a warning", () => {
    expect(schema("ActiveTrackingHoldFinding").properties?.["severity"]?.const).toBe("critical");
    expect(schema("ExpiredLotSellableFinding").properties?.["severity"]?.const).toBe("critical");
    expect(schema("ExpiringLotFinding").properties?.["severity"]?.const).toBe("warning");
    expect(schema("ActiveTrackingHoldFinding").properties?.["holdKind"]?.enum).toEqual([...TRACKING_HOLD_KINDS]);
  });

  it("documents that expiring_lot is never emitted until RT-50 B1", () => {
    expect(findOp("listInventorySafetyFindings")).toBeDefined();
    const op = inventoryDoc.paths?.[SAFETY_FINDINGS_PATH]?.["get"] as { description?: string } | undefined;
    expect(op?.description).toMatch(/never emitted in 1\.8\.0/);
    expect(op?.description).toMatch(/RT-50 B1/);
  });
});

// ===========================================================================
// RT-1081 — the tracking Console reads and TR-5 (1.10.0-draft)
// ===========================================================================
describe("inventory/inventory.yaml — RT-1081 tracking Console reads and TR-5", () => {
  type Prop = {
    type?: unknown;
    enum?: unknown[];
    const?: unknown;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
    $ref?: string;
  };
  type Schema = {
    properties?: Record<string, Prop>;
    required?: string[];
    additionalProperties?: unknown;
    enum?: unknown[];
  };
  type Op = {
    description?: string;
    responses?: Record<string, unknown>;
    parameters?: Array<{ name?: string; schema?: Record<string, unknown> }>;
  };
  const schema = (name: string): Schema => (inventoryDoc.components?.schemas?.[name] ?? {}) as Schema;
  const op = (id: string): Op => (findOp(id) ?? {}) as Op;
  const KEYSET_LISTS = ["listTrackingHolds", "listInventoryRecalls", "listTrackingIdentityExpiryCorrections"];

  it("records 1.10.0-draft in the version history (RT-1099 moved the version on to 1.11.0)", () => {
    expect(inventoryDoc.info?.description).toContain("**1.10.0-draft (RT-1081;");
  });

  it("ships its runtime with the contract: none of RT-1081's operations keeps an x-runtime-status marker", () => {
    const rt1081 = ["listTrackingHolds", "listInventoryRecalls", "getTrackingIdentity", "getTrackingIdentityPositions",
      "listTrackingIdentityExpiryCorrections"];
    for (const { op: o } of inventoryOperations()) {
      if (!rt1081.includes(o.operationId ?? "")) continue;
      expect((o as Record<string, unknown>)["x-runtime-status"]).toBeUndefined();
    }
  });

  it.each(KEYSET_LISTS)("%s pages by an opaque cursor with limit 1-200 (default 50)", (id) => {
    const params = op(id).parameters ?? [];
    expect(params.find((p) => p.name === "limit")?.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(params.find((p) => p.name === "cursor")?.schema).toMatchObject({ minLength: 1, maxLength: 1024 });
    expect(op(id).responses?.["400"]).toEqual({ $ref: "#/components/responses/ValidationFailure" });
  });

  it.each(["TrackingHoldList", "InventoryRecallSummaryList", "TrackingIdentityExpiryCorrectionList"])(
    "%s is strict with a required, nullable nextCursor",
    (name) => {
      expect(schema(name).additionalProperties).toBe(false);
      expect(schema(name).required).toEqual(["items", "nextCursor"]);
      expect(schema(name).properties?.["nextCursor"]?.type).toEqual(["string", "null"]);
    },
  );

  it("filters the hold list by status (default all), kind, identity and product", () => {
    const params = op("listTrackingHolds").parameters ?? [];
    expect(params.find((p) => p.name === "status")?.schema).toMatchObject({
      enum: ["active", "released", "all"],
      default: "all",
    });
    expect(params.find((p) => p.name === "kind")?.schema).toMatchObject({ enum: [...TRACKING_HOLD_KINDS] });
    expect(params.map((p) => p.name)).toEqual(expect.arrayContaining(["trackingIdentityId", "productId"]));
  });

  it("summarizes a recall with its hold counts, not its holds", () => {
    const summary = schema("InventoryRecallSummary");
    expect(summary.additionalProperties).toBe(false);
    expect(summary.properties?.["holds"]).toBeUndefined();
    expect(summary.properties?.["holdCount"]).toMatchObject({ minimum: 1, maximum: 100 });
    expect(summary.properties?.["activeHoldCount"]).toMatchObject({ minimum: 0, maximum: 100 });
  });

  it("answers the hold, recall and correction reads 403 for a role; the identity reads 404 (403 only for a support session)", () => {
    for (const id of KEYSET_LISTS) expect(op(id).responses?.["403"]).toBeDefined();
    for (const id of ["getTrackingIdentity", "getTrackingIdentityPositions"]) {
      expect(op(id).responses?.["403"]).toEqual({ $ref: "#/components/responses/SupportSessionRefused" });
      expect(op(id).responses?.["404"]).toEqual({ $ref: "#/components/responses/NotFoundOrCrossTenant" });
    }
    expect(op("listTrackingIdentityExpiryCorrections").responses?.["404"]).toBeDefined();
  });

  it("splits an identity's position per store into the six statuses, summed over locations (OD-6)", () => {
    const pos = schema("TrackingIdentityStorePosition");
    expect(pos.additionalProperties).toBe(false);
    expect(pos.required).toEqual(["storeId", "stockingUnit", "quantity", "sellableQuantity", "statusQuantities"]);
    expect(pos.properties?.["statusQuantities"]).toMatchObject({ minItems: 6, maxItems: 6 });
    expect(op("getTrackingIdentityPositions").description).toMatch(/summed over the\s+store's locations/);
  });

  it("reserves the critical tracking_consistency finding with its four checks (OD-8)", () => {
    const finding = schema("TrackingConsistencyFinding");
    expect(finding.additionalProperties).toBe(false);
    expect(finding.properties?.["severity"]?.const).toBe("critical");
    expect(finding.properties?.["check"]?.enum).toEqual([
      "identity_without_edge_map",
      "untracked_effect_on_tracked_product",
      "serial_position_out_of_range",
      "profile_erp_flag_mismatch",
    ]);
    expect(op("listInventorySafetyFindings").description).toMatch(/1\.10\.0 emits none/);
  });

  it("TR-5: the three commands take the fixed reason list; projections keep the pattern", () => {
    expect(schema("SafetyReasonCodeInput").enum).toEqual([
      "supplier_notice",
      "authority_notice",
      "label_misprint",
      "other",
    ]);
    for (const name of ["PlaceQualityHoldCommand", "CreateInventoryRecallCommand", "CorrectTrackingIdentityExpiryCommand"]) {
      expect(schema(name).properties?.["reasonCode"]?.$ref).toBe("#/components/schemas/SafetyReasonCodeInput");
    }
    for (const name of ["TrackingHold", "InventoryRecall", "InventoryRecallSummary", "TrackingIdentityExpiryCorrection"]) {
      expect(schema(name).properties?.["reasonCode"]?.$ref).toBe("#/components/schemas/SafetyReasonCode");
    }
  });
});

// ===========================================================================
// RT-451 Step 0 — Tracking Resolution queue, bind and sale-line findings
// (1.9.0-draft, contract-only; RT-455 OD-1, OD-2, OD-9)
// ===========================================================================
describe("inventory/inventory.yaml — RT-451 Step 0 Tracking Resolution", () => {
  type Prop = { type?: unknown; enum?: unknown[]; const?: unknown; minLength?: number; $ref?: string };
  type Schema = { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: unknown };
  type Op = OperationObject & { "x-runtime-status"?: string; "x-runtime-note"?: string; description?: string };
  const schema = (name: string): Schema => (inventoryDoc.components?.schemas?.[name] ?? {}) as Schema;
  const op = (path: string, method: string): Op => (inventoryDoc.paths?.[path]?.[method] ?? {}) as Op;
  const STEP0: Array<[string, string, string]> = [
    [RESOLUTION_QUEUE_PATH, "get", "listTrackingResolutionQueue"],
    [RESOLUTION_BIND_PATH, "post", "bindTrackingResolution"],
    [SALE_LINE_FINDINGS_PATH, "get", "listSaleLineFindings"],
  ];

  it("was introduced at 1.9.0-draft and its note cites the owner decisions (version moved on in RT-1081)", () => {
    expect(inventoryDoc.info?.description).toContain("**1.9.0-draft (RT-451 Step 0, additive, contract-only;");
    expect(inventoryDoc.info?.description).toContain("RT-455 comment 15233, OD-1, OD-2 and OD-9");
  });

  it.each(STEP0)("maps %s %s to %s, marked contract-only for RT-451", (path, method, operationId) => {
    const o = op(path, method);
    expect(o.operationId).toBe(operationId);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(o["x-runtime-note"]).toContain("RT-451");
    expect(o.security).toEqual([{ cookieAuth: [] }]);
    expect(o.responses?.["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
  });

  it("pages both reads with an RT-731 keyset cursor, limit 1-200 and a required nullable nextCursor", () => {
    for (const [path, , ] of STEP0.filter(([, m]) => m === "get")) {
      const params = (op(path, "get").parameters ?? []) as Array<{ name?: string; schema?: Record<string, unknown> }>;
      expect(params.find((p) => p.name === "cursor")?.schema).toMatchObject({ type: "string", maxLength: 1024 });
      expect(params.find((p) => p.name === "limit")?.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    }
    for (const name of ["TrackingResolutionQueue", "SaleLineFindingList"]) {
      expect(schema(name).required).toEqual(expect.arrayContaining(["items", "nextCursor"]));
      expect(schema(name).properties?.["nextCursor"]?.type).toEqual(["string", "null"]);
    }
  });

  it("gives the queue a store_manager count (OD-9) and keeps every projection strict", () => {
    expect(schema("TrackingResolutionQueue").required).toContain("unresolvedCount");
    expect(op(RESOLUTION_QUEUE_PATH, "get").description).toContain("A store_manager gets only the count");
    for (const name of [
      "TrackingResolutionQueue",
      "TrackingResolutionQueueItem",
      "UnresolvedTrackedLine",
      "BindTrackingResolutionCommand",
      "TrackingResolutionLineBinding",
      "TrackingResolution",
      "SaleLineFinding",
      "SaleLineFindingList",
    ]) {
      expect(schema(name).additionalProperties).toBe(false);
    }
    expect(schema("UnresolvedTrackedLine").properties?.["reason"]?.enum).toEqual([
      "tracking_missing",
      "identity_unknown",
      "identity_other_product",
    ]);
  });

  it("makes the bind an idempotent, owner-only, whole-sale command with a required reason and note", () => {
    const bind = op(RESOLUTION_BIND_PATH, "post");
    expect(bind.description).toContain("Owner only");
    expect(bind.description).toContain("EVERY unresolved line of the sale");
    expect(bind.responses?.["404"]).toEqual({ $ref: "#/components/responses/NotFoundOrCrossTenant" });
    expect(bind.responses?.["409"]).toEqual({ $ref: "#/components/responses/TrackingResolutionConflict" });
    const cmd = schema("BindTrackingResolutionCommand");
    expect(cmd.required).toEqual(["reasonCode", "note", "lines"]);
    expect(cmd.properties?.["reasonCode"]?.$ref).toBe("#/components/schemas/SafetyReasonCode");
    expect(cmd.properties?.["note"]?.minLength).toBe(1);
    const conflict = inventoryDoc.components?.responses?.["TrackingResolutionConflict"] as { description?: string };
    for (const code of [
      "tracking_resolution_identity_mismatch",
      "tracking_resolution_identity_held",
      "tracking_resolution_identity_expired",
      "tracking_resolution_already_resolved",
    ]) {
      expect(conflict.description).toContain(code);
    }
  });

  it("filters sale-line findings by the three event kinds, all critical", () => {
    const params = (op(SALE_LINE_FINDINGS_PATH, "get").parameters ?? []) as Array<{ name?: string }>;
    expect(params.map((p) => p.name)).toEqual(["kind", "storeId", "cursor", "limit"]);
    expect((inventoryDoc.components?.schemas?.["SaleLineFindingKind"] as Prop).enum).toEqual([
      "unvalidated_tracked_line",
      "sold_under_hold",
      "erp_intent_held",
    ]);
    expect(schema("SaleLineFinding").properties?.["severity"]?.const).toBe("critical");
    expect(schema("SaleLineFinding").required).toEqual(expect.arrayContaining(["saleLineId", "kind", "cause"]));
    expect(op(SALE_LINE_FINDINGS_PATH, "get").description).toContain("one per line, kind and cause");
  });

  it("does not add the event kinds to the computed findings list (OD-2)", () => {
    const mapping = (inventoryDoc.components?.schemas?.["InventorySafetyFinding"] as unknown as {
      discriminator?: { mapping?: Record<string, string> };
    }).discriminator?.mapping;
    for (const kind of ["unvalidated_tracked_line", "sold_under_hold", "erp_intent_held", "tracking_unresolved_sale"]) {
      expect(Object.keys(mapping ?? {})).not.toContain(kind);
    }
  });
});

// ===========================================================================
// RT-1099 — the retired sale-linked backfill removed (1.11.0-draft)
// ===========================================================================
describe("inventory/inventory.yaml — RT-1099 sale-linked backfill removal", () => {
  it("records 1.11.0-draft in the version history (version moved on in RT-451 S2)", () => {
    expect(inventoryDoc.info?.description).toContain("**1.11.0-draft (RT-1099;");
  });
});

// ===========================================================================
// RT-451 S2 — the tenant's tracked-selling on/off setting (1.12.0-draft,
// contract-only; owner decisions OD-T1..OD-T5, RT-451 comments 16215, 16216)
// ===========================================================================
describe("inventory/inventory.yaml — RT-451 S2 tracked-selling setting", () => {
  type Prop = {
    type?: unknown;
    enum?: unknown[];
    format?: string;
    uniqueItems?: boolean;
    maxItems?: number;
    items?: { $ref?: string };
  };
  type Schema = { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: unknown; enum?: unknown[] };
  type Op = OperationObject & { "x-runtime-status"?: string; "x-runtime-note"?: string; description?: string };
  const schema = (name: string): Schema => (inventoryDoc.components?.schemas?.[name] ?? {}) as Schema;
  const op = (method: string): Op => (inventoryDoc.paths?.[TRACKED_SELLING_PATH]?.[method] ?? {}) as Op;
  const S2: Array<[string, string]> = [
    ["get", "getTrackedSellingSetting"],
    ["put", "setTrackedSellingSetting"],
  ];

  it("is the 1.12.0 draft, with a version note citing the owner decisions", () => {
    expect(inventoryDoc.info?.version).toBe("1.12.0-draft");
    expect(inventoryDoc.info?.description).toContain("**1.12.0-draft (RT-451 S2, additive, contract-only;");
    expect(inventoryDoc.info?.description).toContain("RT-451 comments 16215 and 16216");
  });

  it.each(S2)("maps %s to %s, marked contract-only for RT-451", (method, operationId) => {
    const o = op(method);
    expect(o.operationId).toBe(operationId);
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(o["x-runtime-note"]).toContain("RT-451");
    expect(o.security).toEqual([{ cookieAuth: [] }]);
    expect(o.responses?.["403"]).toEqual({ $ref: "#/components/responses/ForbiddenOrOriginRejected" });
    expect(o.responses?.["404"]).toEqual({ $ref: "#/components/responses/NotFoundOrCrossTenant" });
    expect(o.responses?.["429"]).toEqual({ $ref: "#/components/responses/TooManyRequests" });
  });

  it("restricts both operations to the owner or tenant_admin and hides them behind the deployment gate", () => {
    for (const [method] of S2) {
      expect(op(method).description).toContain("Owner or tenant_admin");
      expect(op(method).description).toContain("POS_TRACKED_SELLING_ENABLED");
    }
  });

  it("projects a strict setting: on/off, last change, and the Q13 preconditions as evaluated now", () => {
    const setting = schema("TrackedSellingSetting");
    expect(setting.additionalProperties).toBe(false);
    expect(setting.required).toEqual(["enabled", "changedAt", "changedBy", "preconditionsMet", "unmetPreconditions"]);
    expect(setting.properties?.["enabled"]?.type).toBe("boolean");
    expect(setting.properties?.["changedAt"]).toMatchObject({ type: ["string", "null"], format: "date-time" });
    expect(setting.properties?.["changedBy"]).toMatchObject({ type: ["string", "null"], format: "uuid" });
    expect(setting.properties?.["preconditionsMet"]?.type).toBe("boolean");
    expect(setting.properties?.["unmetPreconditions"]).toMatchObject({
      type: "array",
      uniqueItems: true,
      maxItems: 6,
      items: { $ref: "#/components/schemas/TrackedSellingPrecondition" },
    });
  });

  it("names exactly the six RT-50 Q13 preconditions", () => {
    expect(schema("TrackedSellingPrecondition").enum).toEqual([
      "sale_effects_active",
      "status_moves_available",
      "erp_tracking_import",
      "erp_batch_posting_verified",
      "identity_anchor",
      "tracking_grain_reconciliation",
    ]);
  });

  it("takes only the on/off value on write", () => {
    const cmd = schema("SetTrackedSellingSettingCommand");
    expect(cmd.additionalProperties).toBe(false);
    expect(cmd.required).toEqual(["enabled"]);
    expect(Object.keys(cmd.properties ?? {})).toEqual(["enabled"]);
    expect(cmd.properties?.["enabled"]?.type).toBe("boolean");
  });

  it("refuses switching on with a fixed 409 code while a precondition is unmet; switching off is always accepted", () => {
    const put = op("put");
    expect(put.responses?.["400"]).toEqual({ $ref: "#/components/responses/ValidationFailure" });
    expect(put.responses?.["409"]).toEqual({ $ref: "#/components/responses/TrackedSellingConflict" });
    const conflict = inventoryDoc.components?.responses?.["TrackedSellingConflict"] as { description?: string };
    expect(conflict.description).toContain("tracked_selling_preconditions_unmet");
    expect(put.description).toContain("always accepted");
    expect(op("get").responses?.["409"]).toBeUndefined();
  });

  it("keeps the Tracking Resolution queue resolvable while switched off (OD-T4)", () => {
    expect(op("put").description).toMatch(/stay listed and can still be\s+resolved/);
  });
});
