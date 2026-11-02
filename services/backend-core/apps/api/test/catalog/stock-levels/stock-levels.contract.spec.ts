/**
 * apps/api/test/catalog/stock-levels/stock-levels.contract.spec.ts
 *
 * RT-1066: `catalog/stock-levels.yaml` (RT-1064 `[GATED]` contract,
 * `1.0.0-draft`), now served by the RT-1066 runtime
 * (`stock-levels.http.integration.spec.ts`). Structural / load-only, plus AJV
 * fixtures against the request schemas. No app boot and no HTTP. Pins:
 *
 *   1. The five operations at their paths and methods, served: none carries
 *      `x-runtime-status` / `x-runtime-note` (the runtime lift drops only the
 *      markers); no operationId collision.
 *   2. Auth and scope: `cookieAuth` only; 403 only `origin_rejected`; the
 *      `Idempotency-Key` required on the two sets and absent on the read and
 *      the retires; one audit action per write, none on the read.
 *   3. The refusal codes the runtime answers (422 `critical_above_reorder`,
 *      409 `stale_write` / `product_retired` / `idempotency_key_conflict`).
 *   4. AJV fixtures: the runtime's `LEVEL_QUANTITY` agrees with the
 *      contract's `LevelQuantity` pattern on every fixture.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { LEVEL_QUANTITY } from "../../../src/catalog/stock-levels/stock-levels.bodies";
import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
} from "../../_helpers/openapi-contract";

const CONTRACT_ID = "stock-levels";
const LEVELS = "/api/v1/catalog/products/{productId}/stock-levels";
const STORE_LEVEL = `${LEVELS}/stores/{storeId}`;

type Method = "get" | "put" | "post";
interface Op {
  readonly id: string;
  readonly method: Method;
  readonly path: string;
  readonly audit: string | null;
  readonly idempotent: boolean;
  readonly responses: readonly string[];
}

const OPS: readonly Op[] = [
  {
    id: "consoleGetProductStockLevels",
    method: "get",
    path: LEVELS,
    audit: null,
    idempotent: false,
    responses: ["200", "400", "401", "404", "429", "500"],
  },
  {
    id: "consoleSetTenantStockLevel",
    method: "put",
    path: LEVELS,
    audit: "catalog.stock_level.set",
    idempotent: true,
    responses: ["200", "400", "401", "403", "404", "409", "422", "425", "429", "500"],
  },
  {
    id: "consoleRetireTenantStockLevel",
    method: "post",
    path: `${LEVELS}/retire`,
    audit: "catalog.stock_level.retire",
    idempotent: false,
    responses: ["200", "400", "401", "403", "404", "409", "429", "500"],
  },
  {
    id: "consoleSetStoreStockLevel",
    method: "put",
    path: STORE_LEVEL,
    audit: "catalog.store_stock_level.set",
    idempotent: true,
    responses: ["200", "400", "401", "403", "404", "409", "422", "425", "429", "500"],
  },
  {
    id: "consoleRetireStoreStockLevel",
    method: "post",
    path: `${STORE_LEVEL}/retire`,
    audit: "catalog.store_stock_level.retire",
    idempotent: false,
    responses: ["200", "400", "401", "403", "404", "409", "429", "500"],
  },
];

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

function op(o: Op): OperationObject & Record<string, unknown> {
  const found = (doc.paths?.[o.path] as Record<string, OperationObject> | undefined)?.[o.method];
  if (!found) throw new Error(`${o.method.toUpperCase()} ${o.path} not declared`);
  return found as OperationObject & Record<string, unknown>;
}

function parameterNames(o: Op): string[] {
  return (op(o).parameters ?? []).map((p) => {
    const name = p.$ref ? p.$ref.replace("#/components/parameters/", "") : p.name;
    return String(name);
  });
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function responseDescription(name: string): string {
  return String(doc.components?.responses?.[name]?.description ?? "");
}

describe("stock-levels contract — operations (RT-1066 runtime)", () => {
  it("declares the five operations at their paths and methods", () => {
    for (const o of OPS) expect(op(o).operationId).toBe(o.id);
    const declared = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => m !== "parameters")
        .map((m) => `${m} ${path}`),
    );
    expect(declared.sort()).toEqual(OPS.map((o) => `${o.method} ${o.path}`).sort());
  });

  it("serves every operation: no x-runtime-status / x-runtime-note marker remains", () => {
    for (const o of OPS) {
      expect(op(o)["x-runtime-status"]).toBeUndefined();
      expect(op(o)["x-runtime-note"]).toBeUndefined();
    }
  });

  it("keeps the 1.0.0-draft version and the no-ERP boundary", () => {
    expect(doc.info?.version).toBe("1.0.0-draft");
    expect(doc.info?.description).toMatch(/no operation calls ERPNext, Frappe or the connector/);
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPS.map((o) => o.id).filter((id) => otherOperationIds.has(id))).toEqual([]);
  });
});

describe("stock-levels contract — auth, idempotency and audit", () => {
  it("is cookieAuth only", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    for (const o of OPS) expect(op(o).security).toBeUndefined();
  });

  it("declares exactly the runtime's response statuses", () => {
    for (const o of OPS) expect(Object.keys(op(o).responses ?? {}).sort()).toEqual([...o.responses].sort());
  });

  it("requires an Idempotency-Key on the two sets only", () => {
    for (const o of OPS) {
      expect({ id: o.id, header: parameterNames(o).includes("IdempotencyKey") }).toEqual({ id: o.id, header: o.idempotent });
      expect({ id: o.id, x: op(o)["x-idempotency"] }).toEqual({ id: o.id, x: o.idempotent ? "required" : undefined });
    }
  });

  it("names one audit action per write and none on the read", () => {
    for (const o of OPS) expect({ id: o.id, audit: op(o)["x-audit-action"] ?? null }).toEqual({ id: o.id, audit: o.audit });
  });

  it("names the refusal codes the runtime answers", () => {
    expect(responseDescription("CriticalAboveReorder")).toMatch(/critical_above_reorder/);
    expect(responseDescription("SetConflict")).toMatch(/stale_write[\s\S]*product_retired[\s\S]*idempotency_key_conflict/);
    expect(responseDescription("RetireConflict")).toMatch(/stale_write/);
    expect(responseDescription("OriginRejected")).toMatch(/origin_rejected/);
  });
});

describe("stock-levels contract — request fixtures", () => {
  it.each([
    ["1", true],
    ["0.0001", true],
    ["999999999999999.9999", true],
    ["12.5", true],
    ["0", false],
    ["0.0", false],
    ["0000.0000", false],
    ["-1", false],
    ["1.00001", false],
    ["1234567890123456", false],
    ["1e3", false],
    [" 1", false],
    ["1.", false],
    [".5", false],
  ])("LevelQuantity %j → %s (runtime and contract agree)", (value, valid) => {
    expect(validator("LevelQuantity")(value)).toBe(valid);
    expect(LEVEL_QUANTITY.test(value)).toBe(valid);
  });

  it("accepts the documented set and retire bodies", () => {
    const set = validator("SetStockLevelRequest");
    expect(set({ expectedUpdatedAt: null, reorderLevel: "10" })).toBe(true);
    expect(set({ expectedUpdatedAt: "2026-11-02T10:00:00.123Z", reorderLevel: "10", criticalLevel: null })).toBe(true);
    expect(set({ expectedUpdatedAt: null, reorderLevel: "10", criticalLevel: "10" })).toBe(true);
    expect(validator("RetireStockLevelRequest")({ expectedUpdatedAt: "2026-11-02T10:00:00.123Z" })).toBe(true);
  });
});
