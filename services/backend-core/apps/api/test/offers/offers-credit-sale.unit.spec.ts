/**
 * RT-1337: an offer promotion cannot ride on a credit sale. A credit sale returns through the credit reversal,
 * which does not settle the offer clawback, so the discount would be refunded twice. Refused at the schema.
 */
import { CaptureSaleRequestSchema } from "../../src/catalog/sales/dto/capture-sale-request.dto";
import { captureBody } from "../catalog/sales/capture/__capture-harness";

const PROMOTION = { offerId: "0a000000-0000-7000-8000-0000000000f1", offerVersion: 1, packRevision: 1, discountAmount: "0.00" };

function withPromotion(over: Record<string, unknown>): Record<string, unknown> {
  const base = captureBody({ externalId: "rt1337-credit-1" }) as { lines: Array<Record<string, unknown>> };
  return { ...base, lines: base.lines.map((l) => ({ ...l, promotion: PROMOTION })), ...over };
}

describe("a promotion on a credit sale", () => {
  it("is refused when the sale carries a responsibility", () => {
    const r = CaptureSaleRequestSchema.safeParse(
      withPromotion({ responsibilities: [{ payerRef: "0a000000-0000-7000-8000-0000000000f2", amount: "10", sequence: 1 }] }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain("lines.0.promotion");
  });

  it("is accepted when the sale has no responsibility", () => {
    expect(CaptureSaleRequestSchema.safeParse(withPromotion({})).success).toBe(true);
  });
});
