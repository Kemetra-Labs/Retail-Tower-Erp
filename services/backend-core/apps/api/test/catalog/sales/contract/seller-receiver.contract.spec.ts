/**
 * RT-1565 (RT-285 F-1, [GATED: contract], owner approval on RT-1565 comments 18562 and 18563) —
 * `pos-sales/sales.yaml` 1.29.0-draft: seller per line and payment receiver per tender. Static (no DB).
 *
 * Pins the additive shape: two new OPTIONAL request fields, one new optional read object, one new 422 code,
 * and no change to any `required` list the tills already rely on.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { allContracts, contractDocument, type OpenApiDocument, type SchemaObject } from "../../../_helpers/openapi-contract";

const CONTRACT_ID = "sales";
const UUID = "0a000000-0000-7000-8000-000000156531";

let sales: OpenApiDocument;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  sales = contractDocument(allContracts(), CONTRACT_ID);
  ajv.addSchema(sales as object, CONTRACT_ID);
});

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");

function schema(name: string): SchemaObject {
  const found = sales.components?.schemas?.[name];
  if (!found) throw new Error(`${name} not declared`);
  return found;
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const props = (s: SchemaObject): Record<string, SchemaObject> =>
  ((s as { properties?: Record<string, SchemaObject> }).properties ?? {}) as Record<string, SchemaObject>;
const required = (s: SchemaObject): string[] => ((s as { required?: string[] }).required ?? []) as string[];

const captureLine = {
  lineName: "Widget",
  unitPrice: "5.0000",
  currencyCode: "EGP",
  quantity: "1",
  lineAmount: "5.0000",
  unit: "ea",
};

describe("pos-sales/sales.yaml — RT-1565 version and note", () => {
  it("was 1.29.0-draft (RT-1571 then moved it to 1.30.0-draft) with a note citing the approval, the owner decisions and the hash rule", () => {
    expect(sales.info?.version).toBe("1.30.0-draft");
    const info = flat(sales.info?.description);
    expect(info).toContain("RT-1565 (1.29.0-draft; [GATED: contract] owner approval on RT-1565 comments 18562 and 18563");
    expect(info).toContain("OQ-1, OQ-2 and OQ-5");
    expect(info).toContain("Neither is part of the payload hash");
    expect(info).toContain("`sale_seller_refused`");
  });
});

describe("pos-sales/sales.yaml — RT-1565 request fields", () => {
  it("CaptureSaleLine.sellerUserId is an optional uuid", () => {
    const line = schema("CaptureSaleLine");
    expect(props(line)["sellerUserId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(required(line)).not.toContain("sellerUserId");
    const v = validator("CaptureSaleLine");
    expect(v(captureLine)).toBe(true);
    expect(v({ ...captureLine, sellerUserId: UUID })).toBe(true);
    expect(v({ ...captureLine, sellerUserId: "S100" })).toBe(false);
  });

  it("SaleTender.receivedByUserId is an optional uuid, on request and read alike", () => {
    const tender = schema("SaleTender");
    expect(props(tender)["receivedByUserId"]).toMatchObject({ type: "string", format: "uuid" });
    expect(required(tender)).toEqual(["method", "amount"]);
    const v = validator("SaleTender");
    expect(v({ method: "cash", amount: "1" })).toBe(true);
    expect(v({ method: "cash", amount: "1", receivedByUserId: UUID })).toBe(true);
    expect(v({ method: "cash", amount: "1", receivedByUserId: "me" })).toBe(false);
  });
});

describe("pos-sales/sales.yaml — RT-1565 read and refusal", () => {
  it("SaleLine.seller is an optional SaleLineSeller of user, store and role", () => {
    expect(props(schema("SaleLine"))["seller"]).toEqual({ $ref: "#/components/schemas/SaleLineSeller" });
    expect(required(schema("SaleLine"))).not.toContain("seller");
    const seller = schema("SaleLineSeller");
    expect(required(seller)).toEqual(["userId", "storeId", "roleId"]);
    const v = validator("SaleLineSeller");
    expect(v({ userId: UUID, storeId: UUID, roleId: UUID })).toBe(true);
    expect(v({ userId: UUID, storeId: UUID })).toBe(false);
    expect(v({ userId: UUID, storeId: UUID, roleId: UUID, code: "S100" })).toBe(false);
  });

  it("CaptureUnprocessable lists sale_seller_refused, last in the order", () => {
    const text = flat(
      (sales.components as { responses?: Record<string, { description?: string }> }).responses?.["CaptureUnprocessable"]
        ?.description,
    );
    expect(text).toContain("`sale_seller_refused` (RT-1565)");
    expect(text).toContain("then the payers, then the sellers and receivers.");
  });
});
