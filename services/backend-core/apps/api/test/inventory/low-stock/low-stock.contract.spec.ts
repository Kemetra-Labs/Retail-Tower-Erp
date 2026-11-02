/**
 * apps/api/test/inventory/low-stock/low-stock.contract.spec.ts
 *
 * RT-1069: `inventory/low-stock.yaml` (RT-1055 `[GATED]` contract,
 * `1.0.0-draft`), now served by the RT-1069 runtime
 * (`low-stock.http.integration.spec.ts`). Structural / load-only, plus AJV
 * fixtures and runtime agreement. No app boot and no HTTP. Pins:
 *
 *   1. The one operation at its path and method, served: no
 *      `x-runtime-status` / `x-runtime-note` marker remains; the Posture
 *      paragraph names RT-1069; no operationId collision.
 *   2. Auth: `cookieAuth` only; no 403; the declared response statuses.
 *   3. The query: `store_id` (uuid) and `limit` (1..50, default 10) agree
 *      with the runtime schema; `cursor` / `page_size` are refused.
 *   4. The wire formats the runtime renders (`LevelRatio`, `OnHandQuantity`,
 *      `LevelQuantity`) validate against the contract.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  ConsoleLowStockQuerySchema,
  LOW_STOCK_LIMIT_DEFAULT,
  LOW_STOCK_LIMIT_MAX,
} from "../../../src/inventory/low-stock/low-stock.query";
import { levelRatioOf, toLowStockItem } from "../../../src/inventory/low-stock/low-stock.service";
import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
} from "../../_helpers/openapi-contract";

const CONTRACT_ID = "low-stock";
const PATH = "/api/v1/inventory/low-stock";
const OPERATION_ID = "consoleListLowStock";

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

function op(): OperationObject & Record<string, unknown> {
  const found = (doc.paths?.[PATH] as Record<string, OperationObject> | undefined)?.["get"];
  if (!found) throw new Error(`GET ${PATH} not declared`);
  return found as OperationObject & Record<string, unknown>;
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function parameter(name: string): Record<string, unknown> {
  const p = doc.components?.parameters?.[name] as Record<string, unknown> | undefined;
  if (!p) throw new Error(`parameter ${name} not declared`);
  return p;
}

describe("low-stock contract — the operation (RT-1069 runtime)", () => {
  it("declares exactly GET /api/v1/inventory/low-stock as consoleListLowStock", () => {
    expect(op().operationId).toBe(OPERATION_ID);
    const declared = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => m !== "parameters")
        .map((m) => `${m} ${path}`),
    );
    expect(declared).toEqual([`get ${PATH}`]);
  });

  it("is served: no x-runtime-status / x-runtime-note marker remains", () => {
    expect(op()["x-runtime-status"]).toBeUndefined();
    expect(op()["x-runtime-note"]).toBeUndefined();
  });

  it("keeps 1.0.0-draft and states the RT-1069 posture", () => {
    expect(doc.info?.version).toBe("1.0.0-draft");
    expect(doc.info?.description).toMatch(/The runtime serves this path since\s+RT-1069/);
    expect(doc.info?.description).not.toMatch(/No\s+controller, guard wiring, service or query serves this path yet/);
  });

  it("collides with no operationId in any other contract", () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });
});

describe("low-stock contract — auth and responses", () => {
  it("is cookieAuth only, with no 403 and no audit action", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    expect(op().security).toBeUndefined();
    expect(Object.keys(op().responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "429", "500"]);
    expect(op()["x-audit-action"]).toBeUndefined();
  });
});

describe("low-stock contract — query parameters agree with the runtime", () => {
  it("declares store_id (uuid) and limit (1..50, default 10)", () => {
    expect(parameter("StoreIdQuery")).toEqual(
      expect.objectContaining({ name: "store_id", in: "query", required: false, schema: { type: "string", format: "uuid" } }),
    );
    expect(parameter("Limit")).toEqual(
      expect.objectContaining({
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: LOW_STOCK_LIMIT_MAX, default: LOW_STOCK_LIMIT_DEFAULT },
      }),
    );
  });

  it.each([
    [{}, true],
    [{ limit: "1" }, true],
    [{ limit: "50" }, true],
    [{ store_id: "0A000000-0000-7000-8000-00000000A5A1" }, true],
    [{ limit: "0" }, false],
    [{ limit: "51" }, false],
    [{ limit: "-1" }, false],
    [{ limit: "1.5" }, false],
    [{ limit: ["5", "6"] }, false],
    [{ store_id: "x" }, false],
    [{ cursor: "abc" }, false],
    [{ page_size: "5" }, false],
  ])("runtime query %j → accepted %s", (query, accepted) => {
    expect(ConsoleLowStockQuerySchema.safeParse(query).success).toBe(accepted);
  });

  it("lower-cases store_id", () => {
    const parsed = ConsoleLowStockQuerySchema.parse({ store_id: "0A000000-0000-7000-8000-00000000A5A1", limit: "7" });
    expect(parsed).toEqual({ store_id: "0a000000-0000-7000-8000-00000000a5a1", limit: 7 });
  });
});

describe("low-stock contract — the runtime's wire formats validate", () => {
  it.each([0, 1, 2857, 3333, 9999])("levelRatioOf(%d) is a LevelRatio", (digits) => {
    expect(validator("LevelRatio")(levelRatioOf(digits))).toBe(true);
  });

  it("renders a full item that validates against LowStockItem", () => {
    const item = toLowStockItem({
      store_id: "0a000000-0000-7000-8000-00000000a5a1",
      store_name: "Store X",
      store_active: false,
      product_id: "0a000000-0000-7000-8000-000010690001",
      product_name: "Water",
      stocking_unit: "ea",
      sellable: "0.0000",
      reorder_level: "10.0000",
      critical_level: "2.0000",
      threshold_source: "store",
      critical: true,
      ratio_digits: 0,
    });
    expect(item).toEqual(
      expect.objectContaining({ storeStatus: "inactive", band: "critical", levelRatio: "0.0000", thresholdSource: "store" }),
    );
    const v = validator("LowStockItem");
    if (!v(item)) throw new Error(JSON.stringify(v.errors));
    expect(v({ ...item, criticalLevel: null, band: "low", stockingUnit: null })).toBe(true);
  });
});
