/**
 * bounded-array.spec.ts — RT-1051: request arrays are length-checked before any
 * element is validated (zod GHSA-mrhx-c7xc-m3w5), and each bounded field
 * matches its contract `maxItems`.
 *
 * Pure Zod schema tests: no NestJS bootstrap, no DB, no network.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { load } from "js-yaml";
import { z, type ZodTypeAny } from "zod";

import { AiEntitlementCheckInputSchema, MAX_TARGET_STORES } from "../../src/ai-entitlements/entitlement-checker";
import { CreditSaleReversalRequestSchema } from "../../src/catalog/sales/dto/credit-sale-reversal-request.dto";
import {
  MAX_REFUND_TENDERS,
  MAX_RETURN_LINES,
  RecordReturnRequestSchema,
} from "../../src/catalog/sales/dto/record-return-request.dto";
import { boundedArray } from "../../src/common/bounded-array";
import { MAX_STORE_IDS, MembershipUpdateSchema } from "../../src/memberships/dto";
import { InvitationCreateSchema } from "../../src/memberships/invitation.dto";
import { ApproverEligibilityRequestSchema, MAX_APPROVER_USER_IDS } from "../../src/pos-approvers/dto";
import { MAX_AUDIT_EVENTS_PER_BATCH, PosAuditEventsSyncSchema } from "../../src/pos-audit-events/dto";
import { CloseShiftRequestSchema } from "../../src/pos-shifts/shift-cash-up.dto";
import { ClaimCreateSchema } from "../../src/settlement/dto/claim-request.dto";
import { SettlementIntentCreateSchema } from "../../src/settlement/dto/settlement-intent-request.dto";

const UUID = "0b000000-0000-7000-8000-000000000001";
const uuidAt = (i: number): string => `0b000000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;

/** Issues whose path starts at `field`. */
function fieldIssues(schema: ZodTypeAny, body: Record<string, unknown>, field: string): z.ZodIssue[] {
  const r = schema.safeParse(body);
  return r.success ? [] : r.error.issues.filter((i) => i.path[0] === field);
}

describe("boundedArray", () => {
  const schema = boundedArray(3, z.array(z.string().uuid()).min(1));

  it("accepts an array up to the bound and validates its elements", () => {
    expect(schema.safeParse([UUID, UUID, UUID]).success).toBe(true);
    const bad = schema.safeParse(["not-a-uuid"]);
    expect(bad.success).toBe(false);
  });

  it("refuses a longer array with one too_big issue and never validates its elements", () => {
    const r = schema.safeParse(Array.from({ length: 10_000 }, () => "not-a-uuid"));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toHaveLength(1);
      expect(r.error.issues[0]).toMatchObject({ code: "too_big", maximum: 3, type: "array" });
    }
  });
});

interface BoundCase {
  name: string;
  schema: ZodTypeAny;
  field: string;
  max: number;
  base: Record<string, unknown>;
  item: (i: number) => unknown;
}

const returnLine = (i: number) => ({ lineRef: uuidAt(i + 1), quantity: "1" });
const cashTender = () => ({ method: "cash", amount: "1.00" });

const CASES: BoundCase[] = [
  { name: "RecordReturnRequest.lines", schema: RecordReturnRequestSchema, field: "lines", max: MAX_RETURN_LINES, base: {}, item: returnLine },
  { name: "RecordReturnRequest.refundTenders", schema: RecordReturnRequestSchema, field: "refundTenders", max: MAX_REFUND_TENDERS, base: {}, item: cashTender },
  { name: "CreditSaleReversalRequest.lines", schema: CreditSaleReversalRequestSchema, field: "lines", max: MAX_RETURN_LINES, base: { kind: "return" }, item: returnLine },
  { name: "CreditSaleReversalRequest.refundTenders", schema: CreditSaleReversalRequestSchema, field: "refundTenders", max: MAX_REFUND_TENDERS, base: { kind: "return" }, item: cashTender },
  { name: "MembershipUpdate.store_ids", schema: MembershipUpdateSchema, field: "store_ids", max: MAX_STORE_IDS, base: { store_access_kind: "specific" }, item: (i) => uuidAt(i + 1) },
  { name: "InvitationCreate.store_ids", schema: InvitationCreateSchema, field: "store_ids", max: MAX_STORE_IDS, base: { email: "a@example.com", role_code: "cashier", store_access_kind: "specific" }, item: (i) => uuidAt(i + 1) },
  { name: "PosAuditEventsSync.events", schema: PosAuditEventsSyncSchema, field: "events", max: MAX_AUDIT_EVENTS_PER_BATCH, base: { device_token_attestation: "x" }, item: () => ({}) },
  { name: "AiEntitlementCheckInput.targetStores", schema: AiEntitlementCheckInputSchema, field: "targetStores", max: MAX_TARGET_STORES, base: {}, item: (i) => uuidAt(i + 1) },
  // Arrays that already had a `.max()` (unchanged limits): now length-checked first too.
  { name: "ClaimCreate.receivableRefs", schema: ClaimCreateSchema, field: "receivableRefs", max: 500, base: {}, item: (i) => uuidAt(i + 1) },
  { name: "SettlementIntentCreate.payers", schema: SettlementIntentCreateSchema, field: "payers", max: 16, base: {}, item: () => ({}) },
  { name: "ApproverEligibilityRequest.user_ids", schema: ApproverEligibilityRequestSchema, field: "user_ids", max: MAX_APPROVER_USER_IDS, base: {}, item: (i) => uuidAt(i + 1) },
  { name: "CloseShiftRequest.cashRefundReturnRefs", schema: CloseShiftRequestSchema, field: "cashRefundReturnRefs", max: 1000, base: {}, item: (i) => uuidAt(i + 1) },
];

describe.each(CASES)("$name", ({ schema, field, max, base, item }) => {
  it(`raises no length issue at ${max} items`, () => {
    const issues = fieldIssues(schema, { ...base, [field]: Array.from({ length: max }, (_, i) => item(i)) }, field);
    expect(issues.filter((i) => i.code === "too_big" && i.path.length === 1)).toEqual([]);
  });

  it(`refuses ${max + 1} items with a single too_big issue`, () => {
    const issues = fieldIssues(schema, { ...base, [field]: Array.from({ length: max + 1 }, (_, i) => item(i)) }, field);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "too_big", maximum: max, path: [field] });
  });

  it("refuses an oversized array of invalid elements without validating them or running parent refinements", () => {
    // null elements: a parent superRefine that read them (e.g. `t.method`) would throw.
    for (const bad of [42, null]) {
      const body = { ...base, [field]: Array.from({ length: 5_000 }, () => bad) };
      expect(() => schema.safeParse(body)).not.toThrow();
      const issues = fieldIssues(schema, body, field);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: "too_big", maximum: max });
    }
  });
});

describe("contract maxItems match the zod bounds", () => {
  const dir = path.resolve(__dirname, "../../../../packages/contracts/openapi");
  type Doc = { components: { schemas: Record<string, { properties: Record<string, { maxItems?: number }> }> } };
  const read = (rel: string): Doc => load(fs.readFileSync(path.join(dir, rel), "utf8")) as Doc;
  const sales = read("pos-sales/sales.yaml");
  const memberships = read("memberships.openapi.yaml");
  const audit = read("pos-audit-events.openapi.yaml");
  const ai = read("ai-entitlements.openapi.yaml");
  const maxOf = (doc: Doc, schema: string, prop: string) => doc.components.schemas[schema]?.properties[prop]?.maxItems;

  it.each([
    [sales, "RecordReturnRequest", "lines", MAX_RETURN_LINES],
    [sales, "RecordReturnRequest", "refundTenders", MAX_REFUND_TENDERS],
    [sales, "CreditSaleReversalRequest", "lines", MAX_RETURN_LINES],
    [sales, "CreditSaleReversalRequest", "refundTenders", MAX_REFUND_TENDERS],
    [memberships, "MembershipUpdate", "store_ids", MAX_STORE_IDS],
    [audit, "PosAuditEventsSyncRequest", "events", MAX_AUDIT_EVENTS_PER_BATCH],
    [ai, "AiEntitlementCheckInput", "targetStores", MAX_TARGET_STORES],
  ] as const)("%#: %s.%s", (doc, schema, prop, max) => {
    expect(maxOf(doc, schema, prop)).toBe(max);
  });

  it("the invitation request store_ids carries the same maxItems", () => {
    const withStoreIds = Object.entries(memberships.components.schemas).filter(
      ([name, s]) => name !== "MembershipUpdate" && s.properties?.store_ids !== undefined,
    );
    expect(withStoreIds.length).toBeGreaterThan(0);
    for (const [, s] of withStoreIds) expect(s.properties.store_ids?.maxItems).toBe(MAX_STORE_IDS);
  });
});
