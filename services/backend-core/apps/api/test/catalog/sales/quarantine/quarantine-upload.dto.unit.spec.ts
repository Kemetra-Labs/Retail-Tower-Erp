/**
 * RT-1312 Phase 3(b) slice B: a NUL (U+0000) in an upload is a 400 at the
 * schema, not a Postgres error. The `jsonb` column and the `text` columns both
 * refuse it, so a body that holds one can never be stored (RT-1312 comment
 * 16720; named in `pos-sales/sale-quarantine.yaml` `ValidationFailure`).
 */
import { NO_NUL_MESSAGE } from "../../../../src/common/text-validation";
import { QuarantineSaleUploadSchema } from "../../../../src/catalog/sales/quarantine/quarantine-upload.dto";

const upload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceSystem: "pos-pulse",
  externalId: "ext-1",
  idempotencyKey: "pos-pulse-ext-1-capture-key",
  reason: { kind: "refused", httpStatus: 422, errorCode: "sale_tender_mismatch" },
  tillRecordedAt: "2026-11-11T09:05:00.000+02:00",
  saleBody: { sourceSystem: "pos-pulse", externalId: "ext-1", lines: [] },
  ...over,
});

describe("QuarantineSaleUploadSchema: NUL", () => {
  it("accepts an upload without one", () => {
    expect(QuarantineSaleUploadSchema.safeParse(upload()).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a string value in the body", { saleBody: { sourceSystem: "pos-pulse", externalId: "ext-1", note: "a\u0000b" } }],
    ["a nested value in the body", { saleBody: { sourceSystem: "pos-pulse", externalId: "ext-1", lines: [{ n: ["\u0000"] }] } }],
    ["a key in the body", { saleBody: { sourceSystem: "pos-pulse", externalId: "ext-1", "k\u0000": 1 } }],
    ["the externalId", { externalId: "ext\u0000-1", saleBody: { lines: [] } }],
    ["the sourceSystem", { sourceSystem: "pos\u0000", saleBody: { lines: [] } }],
  ])("refuses %s as a validation error", (_label, over) => {
    const result = QuarantineSaleUploadSchema.safeParse(upload(over));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.message)).toContain(NO_NUL_MESSAGE);
  });
});
