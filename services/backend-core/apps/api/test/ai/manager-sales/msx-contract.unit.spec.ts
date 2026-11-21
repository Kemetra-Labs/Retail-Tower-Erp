/**
 * RT-1539 — the runtime against the P-05 contract: every answer, refusal and unavailable body the
 * route can produce validates against the contract's own 200 schema; the closed vocabularies in
 * `msx.constants.ts` equal the contract's enums; the request schema agrees with the contract's
 * request schema on the P-07 dataset requests (read only).
 */
import { MSX_DECLINES, MSX_GAPS, MSX_NOTICES, MSX_REFUSAL_CODES, MSX_TEMPLATE_IDS, MSX_UNAVAILABLE_CODES, MSX_FEATURE_ID, MSX_OPERATIONS } from "../../../src/ai/manager-sales/msx.constants";
import { ManagerSalesEvidenceBuilder } from "../../../src/ai/manager-sales/msx.evidence";
import { managerSalesFeature } from "../../../src/ai/manager-sales/msx.feature";
import { ManagerSalesExplainRequestSchema } from "../../../src/ai/manager-sales/msx.request";
import { mapResult } from "../../../src/ai/manager-sales/msx.response";
import type { ManagerSalesAnswer } from "../../../src/ai/manager-sales/msx.output";
import { AI_FALLBACK_REASONS } from "../../../src/ai/gateway/ai-gateway.types";
import { allContracts, contractDocument } from "../../_helpers/openapi-contract";
import { MSX_CASES } from "../eval/manager-sales/msx.cases";
import { validateRequest, validateResponse } from "../eval/manager-sales/msx.schema";
import { fakeReads, ownerCtx, STORE_A1, STORE_A2 } from "./__support__/msx-fixtures";

const doc = contractDocument(allContracts(), "ai-manager-sales-explain.openapi") as {
  paths: Record<string, { post: Record<string, unknown> }>;
  components: { schemas: Record<string, { enum?: string[] }> };
};
const enumOf = (name: string): string[] => doc.components.schemas[name]!.enum!;

const WEEK = { from: "2026-11-08", to: "2026-11-14" };

async function answer(extra: Record<string, unknown>): Promise<ManagerSalesAnswer> {
  const reads = fakeReads();
  const builder = new ManagerSalesEvidenceBuilder(reads.summary as never, reads.byStore as never);
  const params = ManagerSalesExplainRequestSchema.parse({ storeIds: [], locale: "en", ...WEEK, ...extra });
  const pack = await builder.build({ ctx: ownerCtx(), featureId: MSX_FEATURE_ID, storeIds: params.storeIds, correlationId: "c", params });
  return managerSalesFeature.outputSchema.parse(managerSalesFeature.execute(pack, {})) as ManagerSalesAnswer;
}

describe("the runtime and the P-05 contract", () => {
  it("the operation is served: it carries no contract-only marker", () => {
    const operation = doc.paths["/api/v1/ai/manager-sales/explain"]!.post;
    expect(operation["x-runtime-status"]).toBeUndefined();
    expect(operation["x-runtime-note"]).toBeUndefined();
    expect(operation["x-idempotency"]).toBe("required");
    expect(operation["x-audit-action"]).toBe("ai.manager_sales.explain");
  });

  describe("closed vocabularies equal the contract's enums", () => {
    it.each([
      ["TemplateId", MSX_TEMPLATE_IDS],
      ["AnswerNotice", MSX_NOTICES],
      ["AnswerDecline", MSX_DECLINES],
      ["SourceGap", MSX_GAPS],
      ["AnswerRefusalCode", MSX_REFUSAL_CODES],
      ["GatewayUnavailableCode", MSX_UNAVAILABLE_CODES],
    ] as const)("%s", (name, values) => {
      expect([...values].sort()).toEqual([...enumOf(name)].sort());
    });

    it("the unavailable codes are a subset of the gateway's fallback reasons, and never the 404 reasons", () => {
      for (const code of MSX_UNAVAILABLE_CODES) expect((AI_FALLBACK_REASONS as readonly string[]).includes(code)).toBe(true);
      expect(MSX_UNAVAILABLE_CODES).not.toContain("store_out_of_scope");
      expect(MSX_UNAVAILABLE_CODES).not.toContain("not_authorized");
    });

    it("the source operations are the two sales reads", () => {
      expect([...MSX_OPERATIONS].sort()).toEqual(["consoleGetSalesByStore", "consoleGetSalesSummary"]);
    });
  });

  describe("every body validates against the contract's 200 schema", () => {
    const requests: [string, Record<string, unknown>][] = [
      ["T-01 scope", { templateId: "T-01" }],
      ["T-01 stores", { templateId: "T-01", storeIds: [STORE_A1, STORE_A2] }],
      ["T-02", { templateId: "T-02", storeIds: [STORE_A1] }],
      ["T-02 future days", { templateId: "T-02", storeIds: [STORE_A1], from: "2026-11-16", to: "2026-11-20" }],
      ["T-03", { templateId: "T-03" }],
      ["T-04", { templateId: "T-04", currency: "EGP" }],
      ["T-05", { templateId: "T-05", currency: "EGP", storeIds: [STORE_A1, STORE_A2] }],
      ["T-06 scope", { templateId: "T-06", currency: "EGP", compare: "previous_period" }],
      ["T-06 store", { templateId: "T-06", currency: "EGP", storeIds: [STORE_A1] }],
      ["T-07", { templateId: "T-07", currency: "EGP" }],
      ["T-08", { templateId: "T-08", currency: "EGP" }],
      ["T-09", { templateId: "T-09", currency: "SAR" }],
      ["T-10", { templateId: "T-10", currency: "EGP", from: "2026-11-18", to: "2026-11-18" }],
      ["T-12", { templateId: "T-12", currency: "EGP" }],
    ];

    it.each(requests)("answer %s", async (_name, extra) => {
      const body = await answer(extra);
      const verdict = validateResponse(body);
      expect(verdict.errors).toBe("");
      expect(verdict.valid).toBe(true);
    });

    it.each(MSX_REFUSAL_CODES)("refusal %s", (code) => {
      const mapped = mapResult({ kind: "declined", decline: { code } });
      expect(mapped.kind).toBe("body");
      if (mapped.kind === "body") expect(validateResponse(mapped.body).valid).toBe(true);
    });

    it.each(MSX_UNAVAILABLE_CODES)("unavailable %s", (code) => {
      const mapped = mapResult({ kind: "fallback", reason: code, providerRequested: false });
      expect(mapped).toEqual({ kind: "body", body: { kind: "unavailable", family: "gateway", code } });
      if (mapped.kind === "body") expect(validateResponse(mapped.body).valid).toBe(true);
    });
  });

  describe("mapResult", () => {
    it("the 404 reasons are not a body", () => {
      for (const reason of ["not_authorized", "store_out_of_scope"] as const) {
        expect(mapResult({ kind: "fallback", reason, providerRequested: false })).toEqual({ kind: "not_found" });
      }
    });

    it("anything a tier-0 run cannot reach, and a decline outside the refusal set, is a server fault", () => {
      for (const reason of ["internal_error", "output_schema_invalid", "output_unknown_evidence_ref", "unknown_feature", "provider_error", "route_not_allowlisted"] as const) {
        expect(mapResult({ kind: "fallback", reason, providerRequested: false })).toEqual({ kind: "fault", reason });
      }
      expect(mapResult({ kind: "declined", decline: { code: "partial_data_not_conclusive" } })).toEqual({ kind: "fault", reason: "unknown_decline" });
    });
  });

  describe("the request schema agrees with the contract on the P-07 requests", () => {
    it.each(MSX_CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
      const mine = ManagerSalesExplainRequestSchema.safeParse(c.request).success;
      if (c.requestValidity === "valid") {
        expect(validateRequest(c.request).valid).toBe(true);
        expect(mine).toBe(true);
      } else {
        expect(mine).toBe(false);
      }
    });
  });
});
