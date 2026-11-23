/**
 * RT-1403 (RT-530 owner decision c12029) — `pos-sales/sales.yaml` 1.26.0-draft:
 * the new device-only operation `recordCashierVoid`
 * (`POST /api/pos/v1/sales/{saleRef}/cashier-void`). `[GATED: contract]`, owner
 * authorization on RT-1403 (comment 18071) and the owner's choice of a separate
 * route (comment 18113). Structural / load-only; no app boot.
 *
 * Pins:
 *   1. the version and the info note;
 *   2. the new operation is device-only, and `recordVoid` is exactly as before
 *      (operator envelope only; its body does not carry `operatorUserId`);
 *   3. `RecordCashierVoidRequest` is `RecordVoidRequest` plus a REQUIRED uuid
 *      `operatorUserId`, agreeing with the DTO;
 *   4. the generic 403 `refused` is documented on the cashier route's own 403,
 *      and `VoidForbidden` (the manager route's) is untouched;
 *   5. the change is additive: a path and schemas only.
 */
import "reflect-metadata";

import {
  RecordCashierVoidRequestSchema,
  RecordVoidRequestSchema,
} from "../../../../src/catalog/sales/dto/record-void-request.dto";
import {
  allContracts,
  contractDocument,
  type OperationObject,
  type OpenApiDocument,
  type SchemaObject,
} from "../../../_helpers/openapi-contract";

let sales: OpenApiDocument;

beforeAll(() => {
  sales = contractDocument(allContracts(), "sales");
});

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");

const CASHIER_PATH = "/api/pos/v1/sales/{saleRef}/cashier-void";
const VOID_PATH = "/api/pos/v1/sales/{saleRef}/void";

function op(path: string): OperationObject {
  const found = sales.paths?.[path]?.["post"];
  if (!found) throw new Error(`${path} not declared`);
  return found;
}

function schema(name: string): SchemaObject {
  const found = sales.components?.schemas?.[name];
  if (!found) throw new Error(`${name} not declared`);
  return found;
}

describe("pos-sales/sales.yaml — RT-1403 cashier void route", () => {
  it("keeps the 1.26.0-draft note citing the authorizations, the live-admission rule and the additive shape (RT-1544 then bumped the document to 1.27.0-draft, RT-1548 to 1.28.0-draft, RT-1565 to 1.29.0-draft)", () => {
    expect(sales.info?.version).toBe("1.29.0-draft");
    const info = flat(sales.info?.description);
    expect(info).toContain("RT-1403 (1.26.0-draft; [GATED: contract] owner authorization on RT-1403, comment 18071");
    expect(info).toContain("comment 12029");
    expect(info).toContain("RT-1403 comment 18113");
    expect(info).toContain("`recordCashierVoid`");
    expect(info).toContain("live at the server's current time (no back-dating window)");
    expect(info).toContain("every RT-530 check");
    expect(info).toContain("one `sale_voids` row per");
    expect(info).toContain("Additive: a new path and a new schema only");
    expect(info).toContain("`recordVoid` (`POST /api/pos/v1/sales/{saleRef}/void`) is unchanged");
    expect(info).toContain("the POS MUST NOT send to it before then");
  });

  it("recordCashierVoid takes the device bearer ONLY, never the operator envelope", () => {
    expect(op(CASHIER_PATH).operationId).toBe("recordCashierVoid");
    expect(op(CASHIER_PATH).security).toEqual([{ device: [] }]);
  });

  it("recordVoid stays exactly the manager envelope route: envelope only, no operatorUserId, original 403", () => {
    expect(op(VOID_PATH).operationId).toBe("recordVoid");
    expect(op(VOID_PATH).security).toEqual([{ operatorAuthorization: [] }]);
    expect(Object.keys(schema("RecordVoidRequest").properties ?? {}).sort()).toEqual(
      ["approval", "businessDate", "externalId", "sourceSystem"],
    );
    expect(op(VOID_PATH).responses?.["403"]).toEqual({ $ref: "#/components/responses/VoidForbidden" });
    const forbidden = flat(sales.components?.responses?.["VoidForbidden"]?.description);
    expect(forbidden).not.toContain("`refused`");
    expect(forbidden).not.toContain("device");
  });

  it("the device scheme says it is accepted on recordCashierVoid as well as captureSale", () => {
    expect(flat(sales.components?.securitySchemes?.["device"]?.["description"])).toContain("`recordCashierVoid`");
  });

  it("RecordCashierVoidRequest is the void body plus a REQUIRED uuid operatorUserId, strict", () => {
    const body = schema("RecordCashierVoidRequest");
    expect(body.additionalProperties).toBe(false);
    expect([...(body.required ?? [])].sort()).toEqual(["externalId", "operatorUserId", "sourceSystem"]);
    expect(Object.keys(body.properties ?? {}).sort()).toEqual(
      ["approval", "businessDate", "externalId", "operatorUserId", "sourceSystem"],
    );
    expect(body.properties?.["operatorUserId"]?.["type"]).toBe("string");
    expect(body.properties?.["operatorUserId"]?.["format"]).toBe("uuid");
    expect(body.properties?.["approval"]).toEqual({ $ref: "#/components/schemas/VoidApproval" });
  });

  it("documents that the field is a verified claim, never trusted, and not part of the payload hash", () => {
    const text = flat(schema("RecordCashierVoidRequest").properties?.["operatorUserId"]?.["description"]);
    expect(text).toContain("It is a claim, never trusted on its own");
    expect(text).toContain("live at the server's current time");
    expect(text).toContain("`void_requester_mismatch`");
    expect(text).toContain("the device creates the admission itself with no server-side PIN check");
    expect(text).toContain("not suspended at the store");
    expect(text).toContain("not part of the void's `payload_hash`");
  });

  it("the operation describes the device credential, the generic 401 and 403 refused, and the shared provenance", () => {
    const text = flat(op(CASHIER_PATH).description);
    expect(text).toContain("`recordVoid` stays manager and admin envelope only");
    expect(text).toContain("an operator envelope, are the generic 401");
    expect(text).toContain("generic 403 `refused`");
    expect(text).toContain("What this credential proves, plainly");
    expect(text).toContain("It does not prove that the cashier or the approving manager was present");
    expect(text).toContain("`POST /cashier-admissions` checks no PIN on the server");
    expect(text).toContain("the trust is the device token plus a cashier id the client states");
    expect(text).toContain("not suspended at the store");
    expect(text).not.toContain("never to an id the client merely states");
    expect(text).toContain("including a missing `operatorUserId`, is the usual 400");
    expect(text).toContain("Both routes call the same service");
    expect(text).toContain("`operatorUserId` is not part of the stored `payload_hash`");
  });

  it("the cashier 403 names `refused` first, says it is never a revoked device, and keeps the RT-530 codes", () => {
    const text = flat(sales.components?.responses?.["CashierVoidForbidden"]?.description);
    expect(text).toContain("`refused`");
    expect(text).toContain("an ineligible or suspended cashier");
    expect(text).toContain("never a sign that the device was revoked");
    for (const code of [
      "void_approval_required",
      "void_requester_mismatch",
      "void_self_approval",
      "void_requester_not_eligible",
      "void_approver_not_eligible",
      "credit_sale_reversal_restricted",
    ]) {
      expect(text).toContain(code);
    }
    expect(op(CASHIER_PATH).responses?.["403"]).toEqual({ $ref: "#/components/responses/CashierVoidForbidden" });
  });

  it("the cashier route declares the same response codes as recordVoid", () => {
    expect(Object.keys(op(CASHIER_PATH).responses ?? {}).sort()).toEqual(
      Object.keys(op(VOID_PATH).responses ?? {}).sort(),
    );
    for (const code of ["400", "401", "404", "409", "422", "500"]) {
      expect(op(CASHIER_PATH).responses?.[code]).toEqual(op(VOID_PATH).responses?.[code]);
    }
  });

  it("the strict DTOs and the contract agree, and recordVoid's own DTO does not accept operatorUserId", () => {
    const cashierShape = (RecordCashierVoidRequestSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(cashierShape).sort()).toEqual(Object.keys(schema("RecordCashierVoidRequest").properties ?? {}).sort());
    const voidShape = (RecordVoidRequestSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(voidShape).sort()).toEqual(Object.keys(schema("RecordVoidRequest").properties ?? {}).sort());
    expect(Object.keys(voidShape)).not.toContain("operatorUserId");
  });

  it("the cashier DTO needs a uuid operatorUserId and still refuses unknown fields; recordVoid's refuses operatorUserId", () => {
    const base = { sourceSystem: "pos-pulse", externalId: "x" };
    const uuid = "0a140300-0000-4000-8000-0000000000c1";
    expect(RecordCashierVoidRequestSchema.safeParse({ ...base, operatorUserId: uuid }).success).toBe(true);
    expect(RecordCashierVoidRequestSchema.safeParse(base).success).toBe(false);
    expect(RecordCashierVoidRequestSchema.safeParse({ ...base, operatorUserId: "nope" }).success).toBe(false);
    expect(RecordCashierVoidRequestSchema.safeParse({ ...base, operatorUserId: null }).success).toBe(false);
    expect(RecordCashierVoidRequestSchema.safeParse({ ...base, operatorUserId: uuid, tenantId: uuid }).success).toBe(false);
    expect(RecordVoidRequestSchema.safeParse({ ...base, operatorUserId: uuid }).success).toBe(false);
    expect(RecordVoidRequestSchema.safeParse(base).success).toBe(true);
  });
});
