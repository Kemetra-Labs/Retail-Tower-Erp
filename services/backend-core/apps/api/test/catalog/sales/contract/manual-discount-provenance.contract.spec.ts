/**
 * RT-1571 (RT-285 F-7, RT-740 lineage; [GATED: contract] under the owner's delegation, RT-1588 comment 18881
 * item 9, RT-1571 comment 18901) — the manual discount stored on the sale line. Static (no DB).
 *
 * Pins the additive shape across the three read contracts:
 *   - `pos-sales/sales.yaml` 1.30.0-draft: `SaleLine.discount` (`SaleLineDiscount`) is optional and carries the
 *     capture's fields (the approver's user id included, optional); the request is unchanged;
 *   - `pos-sales/sale-history.yaml` 1.2.0-draft and `console-sales.openapi.yaml` 1.4.0-draft:
 *     `SaleHistoryLine.discount` is optional, the same facts WITHOUT the approver's user id, identical in both;
 *   - the vocabularies match the capture DTO, so a stored value always reads back inside the contract.
 */
import "reflect-metadata";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { DISCOUNT_REASON_CODES } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import {
  allContracts,
  contractDocument,
  contractReader,
  type OpenApiDocument,
  type SchemaObject,
} from "../../../_helpers/openapi-contract";

const UUID = "0a000000-0000-7000-8000-000000157101";

let sales: OpenApiDocument;
let history: OpenApiDocument;
let consoleSales: OpenApiDocument;

beforeAll(() => {
  const all = allContracts();
  sales = contractDocument(all, "sales");
  history = contractDocument(all, "sale-history");
  consoleSales = contractDocument(all, "console-sales.openapi");
});

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");

function schemaOf(doc: OpenApiDocument, name: string): SchemaObject {
  const found = doc.components?.schemas?.[name];
  if (!found) throw new Error(`${name} not declared`);
  return found;
}

const props = (s: SchemaObject): Record<string, SchemaObject> =>
  ((s as { properties?: Record<string, SchemaObject> }).properties ?? {}) as Record<string, SchemaObject>;
const required = (s: SchemaObject): string[] => [...(((s as { required?: string[] }).required ?? []) as string[])];

function validatorFor(doc: OpenApiDocument, id: string, schema: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(doc as object), $id: id });
  return ajv.compile({ $ref: `${id}#/components/schemas/${schema}` });
}

const STORED = {
  kind: "percent",
  value: "10",
  amount: "9.0000",
  reasonCode: "promotion",
  authoritySource: "cashier_approval",
  approverRole: "manager",
};

const historyLine = {
  lineRef: UUID,
  sequence: 1,
  lineName: "Widget",
  unitPrice: "45.0000",
  currencyCode: "EGP",
  quantity: "2.000000",
  lineAmount: "81.0000",
  taxAmount: null,
  unit: "box",
  returnedQuantity: "0",
};

describe("pos-sales/sales.yaml — RT-1571 version and note", () => {
  it("is 1.30.0-draft with a note citing the authorization, OQ-8, the unchanged hash and the read rule", () => {
    expect(sales.info?.version).toBe("1.30.0-draft");
    const info = flat(sales.info?.description);
    expect(info).toContain("RT-1571 (1.30.0-draft; [GATED: contract] authorized under the owner's delegation");
    expect(info).toContain("RT-1588 comment 18881 item 9 and RT-1571 comment 18901");
    expect(info).toContain("owner decision OQ-8 in RT-285 comment 18526");
    expect(info).toContain("so no existing payload hashes differently");
    expect(info).toContain("(migration 0134)");
    expect(info).toContain('("not recorded")');
  });
});

describe("pos-sales/sales.yaml — RT-1571 request unchanged", () => {
  it("CaptureSaleLineDiscount keeps its fields and required list", () => {
    const d = schemaOf(sales, "CaptureSaleLineDiscount");
    expect(Object.keys(props(d)).sort()).toEqual(
      ["amount", "approverRole", "approverUserId", "authoritySource", "kind", "reasonCode", "value"],
    );
    expect(required(d).sort()).toEqual(["amount", "approverRole", "authoritySource", "kind", "reasonCode", "value"]);
  });

  it("states that the discount is now stored and returned, and that approverUserId is a recorded, unverified claim", () => {
    const d = flat(schemaOf(sales, "CaptureSaleLineDiscount").description);
    expect(d).toContain("Storage (from 1.30.0-draft, RT-1571)");
    expect(d).toContain("it is now also stored on the line as sent");
    expect(d).toContain("A replay never rewrites it: the first capture's facts stand.");
    const approver = flat(props(schemaOf(sales, "CaptureSaleLineDiscount"))["approverUserId"]?.description);
    expect(approver).toContain("it is not verified (an unknown id is not refused)");
    expect(approver).toContain("never used for authorization or attribution");
  });
});

describe("pos-sales/sales.yaml — RT-1571 SaleLine.discount", () => {
  it("is an optional SaleLineDiscount; SaleLine's required list is unchanged", () => {
    const line = schemaOf(sales, "SaleLine");
    expect(props(line)["discount"]).toEqual({ $ref: "#/components/schemas/SaleLineDiscount" });
    expect(required(line)).not.toContain("discount");
    expect(required(line).sort()).toEqual(
      ["currencyCode", "lineAmount", "lineName", "lineRef", "quantity", "returnableQuantity", "returnedQuantity", "unit", "unitPrice"],
    );
  });

  it("SaleLineDiscount is strict and carries the capture's fields, approverUserId optional", () => {
    const d = schemaOf(sales, "SaleLineDiscount");
    expect((d as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    expect(Object.keys(props(d)).sort()).toEqual(Object.keys(props(schemaOf(sales, "CaptureSaleLineDiscount"))).sort());
    expect(required(d).sort()).toEqual(required(schemaOf(sales, "CaptureSaleLineDiscount")).sort());
    expect(props(d)["approverUserId"]).toMatchObject({ type: "string", format: "uuid" });
  });

  it("uses the capture's vocabularies, which are the DTO's", () => {
    const capture = props(schemaOf(sales, "CaptureSaleLineDiscount"));
    const stored = props(schemaOf(sales, "SaleLineDiscount"));
    for (const key of ["kind", "reasonCode", "authoritySource", "approverRole"]) {
      expect({ key, enum: (stored[key] as { enum?: string[] }).enum }).toEqual({
        key,
        enum: (capture[key] as { enum?: string[] }).enum,
      });
    }
    expect((stored["reasonCode"] as { enum?: string[] }).enum).toEqual([...DISCOUNT_REASON_CODES]);
  });

  it("validates a stored percent and amount discount, with and without the approver id, and refuses an extra key", () => {
    const v = validatorFor(sales, "sales", "SaleLineDiscount");
    expect(v(STORED)).toBe(true);
    expect(v({ ...STORED, approverUserId: UUID })).toBe(true);
    expect(v({ ...STORED, kind: "amount", value: "5.0000", amount: "5.0000" })).toBe(true);
    expect(v({ ...STORED, reasonNote: "regular" })).toBe(false);
    expect(v({ ...STORED, reasonCode: "my cousin" })).toBe(false);
    const { approverRole: _r, ...partial } = STORED;
    expect(v(partial)).toBe(false);
  });

  it("says absent means not recorded, including every line captured before 1.30.0-draft", () => {
    const d = flat(schemaOf(sales, "SaleLineDiscount").description);
    expect(d).toContain("Present only when recorded");
    expect(d).toContain("on every line captured before 1.30.0-draft, even a discounted one");
  });
});

describe("sale history and console detail — RT-1571 SaleHistoryLine.discount", () => {
  it.each([
    ["pos-sales/sale-history.yaml", () => history, "1.2.0-draft"],
    ["console-sales.openapi.yaml", () => consoleSales, "1.4.0-draft"],
  ] as const)("%s is %s with an optional discount without the approver's user id", (_name, doc, version) => {
    expect(doc().info?.version).toBe(version);
    const line = schemaOf(doc(), "SaleHistoryLine");
    expect(required(line)).not.toContain("discount");
    const discount = props(line)["discount"]!;
    expect((discount as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    expect(required(discount).sort()).toEqual(["amount", "approverRole", "authoritySource", "kind", "reasonCode", "value"]);
    expect(Object.keys(props(discount)).sort()).toEqual(required(discount).sort());
    expect(Object.keys(props(discount))).not.toContain("approverUserId");
    expect(flat(discount.description)).toContain("WITHOUT the approver's user id");
  });

  it("the history and the console describe the line identically, and their discount matches readSale's minus the id", () => {
    const pos = contractReader(history);
    const api = contractReader(consoleSales);
    const reader = contractReader(sales);
    const historyDiscount = pos.shape(props(schemaOf(history, "SaleHistoryLine"))["discount"]) as Record<string, unknown>;
    expect(api.shape(props(schemaOf(consoleSales, "SaleHistoryLine"))["discount"])).toEqual(historyDiscount);
    const full = reader.shape(schemaOf(sales, "SaleLineDiscount")) as { properties: Record<string, Record<string, unknown>> };
    const historyProps = historyDiscount["properties"] as Record<string, Record<string, unknown>>;
    for (const key of ["kind", "reasonCode", "authoritySource", "approverRole"]) {
      expect({ key, enum: historyProps[key]!["enum"] }).toEqual({ key, enum: full.properties[key]!["enum"] });
    }
    expect(historyProps["value"]!["pattern"]).toBe(full.properties["value"]!["pattern"]);
  });

  it("validates a history line with and without a discount, and refuses one carrying the approver id", () => {
    for (const [doc, id] of [
      [history, "sale-history"],
      [consoleSales, "console-sales"],
    ] as const) {
      const v = validatorFor(doc, id, "SaleHistoryLine");
      expect({ id, ok: v(historyLine) }).toEqual({ id, ok: true });
      expect({ id, ok: v({ ...historyLine, discount: STORED }) }).toEqual({ id, ok: true });
      expect({ id, ok: v({ ...historyLine, discount: { ...STORED, approverUserId: UUID } }) }).toEqual({ id, ok: false });
    }
  });
});
