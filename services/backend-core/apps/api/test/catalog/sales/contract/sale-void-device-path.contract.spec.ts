/**
 * RT-1403 (RT-530 owner decision c12029) — `pos-sales/sales.yaml` 1.26.0-draft:
 * `recordVoid` accepts the device bearer plus an optional `operatorUserId` as
 * a second, alternative credential. `[GATED: contract]`, owner authorization on
 * RT-1403 (comment 18071). Structural / load-only; no app boot.
 *
 * Pins:
 *   1. the version and the info note;
 *   2. the security alternatives (envelope first, then `device`), and that
 *      `device` is still the same scheme captureSale uses;
 *   3. the optional uuid `operatorUserId` on the strict body, agreeing with the
 *      DTO;
 *   4. the generic 403 `refused` is documented on the void's own 403;
 *   5. the change is additive: no new required field, and the envelope
 *      response codes are all still declared.
 */
import "reflect-metadata";

import { RecordVoidRequestSchema } from "../../../../src/catalog/sales/dto/record-void-request.dto";
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

function voidOp(): OperationObject {
  const op = sales.paths?.["/api/pos/v1/sales/{saleRef}/void"]?.["post"];
  if (!op) throw new Error("recordVoid not declared");
  return op;
}

function body(): SchemaObject {
  const found = sales.components?.schemas?.["RecordVoidRequest"];
  if (!found) throw new Error("RecordVoidRequest not declared");
  return found;
}

describe("pos-sales/sales.yaml — RT-1403 cashier device-path void", () => {
  it("is 1.26.0-draft with a note citing the authorization, the live-admission rule and the additive shape", () => {
    expect(sales.info?.version).toBe("1.26.0-draft");
    const info = flat(sales.info?.description);
    expect(info).toContain("RT-1403 (1.26.0-draft; [GATED: contract] owner authorization on RT-1403, comment 18071");
    expect(info).toContain("comment 12029");
    expect(info).toContain("live at the server's current time (no back-dating window)");
    expect(info).toContain("every RT-530 check");
    expect(info).toContain("Additive");
    expect(info).toContain("MUST NOT send it before then");
  });

  it("recordVoid accepts the envelope OR the device bearer, as two alternatives, envelope first", () => {
    expect(voidOp().security).toEqual([{ operatorAuthorization: [] }, { device: [] }]);
  });

  it("the device scheme says it is accepted on recordVoid as well as captureSale", () => {
    expect(flat(sales.components?.securitySchemes?.["device"]?.["description"])).toContain("`recordVoid`");
  });

  it("the strict void body gains an OPTIONAL uuid operatorUserId and nothing else", () => {
    expect(body().additionalProperties).toBe(false);
    expect(body().required).toEqual(["sourceSystem", "externalId"]);
    expect(Object.keys(body().properties ?? {}).sort()).toEqual(
      ["approval", "businessDate", "externalId", "operatorUserId", "sourceSystem"].sort(),
    );
    expect(body().properties?.["operatorUserId"]?.["type"]).toBe("string");
    expect(body().properties?.["operatorUserId"]?.["format"]).toBe("uuid");
  });

  it("documents which scheme the field selects, that an envelope carrying it is a 401, and that it is a verified claim", () => {
    const text = flat(body().properties?.["operatorUserId"]?.["description"]);
    expect(text).toContain("REQUIRED with the `device` scheme");
    expect(text).toContain("MUST be absent with `operatorAuthorization`");
    expect(text).toContain("generic 401");
    expect(text).toContain("It is a claim, never trusted on its own");
    expect(text).toContain("live at the server's current time");
    expect(text).toContain("`void_requester_mismatch`");
    expect(text).toContain("not part of the void's `payload_hash`");
  });

  it("the operation describes the device path, the generic 401 and the generic 403 refused", () => {
    const text = flat(voidOp().description);
    expect(text).toContain("Cashier device path (RT-1403");
    expect(text).toContain("an envelope request that carries it is refused with the generic 401");
    expect(text).toContain("generic 403 `refused`");
    expect(text).toContain("never to an id the client merely states");
  });

  it("the void's own 403 names the refused code and says it is never a revoked device", () => {
    const text = flat(sales.components?.responses?.["VoidForbidden"]?.description);
    expect(text).toContain("`refused` (RT-1403, `device` path only)");
    expect(text).toContain("never a sign that the device was revoked");
    // The RT-530 codes are all still there.
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
  });

  it("keeps every response code of the envelope path declared", () => {
    expect(Object.keys(voidOp().responses ?? {}).sort()).toEqual(
      ["200", "201", "400", "401", "403", "404", "409", "422", "500"],
    );
  });

  it("the strict DTO and the contract agree on the body's properties", () => {
    const dtoShape = (RecordVoidRequestSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(dtoShape).sort()).toEqual(Object.keys(body().properties ?? {}).sort());
  });

  it("the DTO accepts operatorUserId only as a uuid and still refuses unknown fields", () => {
    const base = { sourceSystem: "pos-pulse", externalId: "x" };
    const uuid = "0a140300-0000-4000-8000-0000000000c1";
    expect(RecordVoidRequestSchema.safeParse({ ...base, operatorUserId: uuid }).success).toBe(true);
    expect(RecordVoidRequestSchema.safeParse(base).success).toBe(true);
    expect(RecordVoidRequestSchema.safeParse({ ...base, operatorUserId: "nope" }).success).toBe(false);
    expect(RecordVoidRequestSchema.safeParse({ ...base, operatorUserId: null }).success).toBe(false);
    expect(RecordVoidRequestSchema.safeParse({ ...base, tenantId: uuid }).success).toBe(false);
  });
});
