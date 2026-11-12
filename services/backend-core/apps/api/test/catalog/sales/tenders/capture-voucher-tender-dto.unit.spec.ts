/**
 * RT-1114 (RT-1098 R-4a) — the captureSale `voucher` tender boundary, Docker-free.
 *
 *   - acceptance 2 (INVARIANT, RT-10 c10413): `POS_SALE_VOUCHER_TENDER_ENABLED`
 *     is OFF by default, and while it is off a `voucher` tender is a 400 with
 *     every combination of the other tender gates;
 *   - the voucher gate does nothing while `POS_SALE_TENDERS_ENABLED` is off;
 *   - gates on: `voucher` needs a uuid `redemptionId`; no other method takes
 *     one; a voucher takes no `reference`; `redemptionId` is unique within the
 *     sale (400);
 *   - two voucher tenders in one sale follow the RT-360 same-method rule;
 *   - `redemptionId` is part of the payload hash; a cash/card body hashes the
 *     same whichever schema parsed it.
 */
import { ZodError } from "zod";

import {
  CaptureSaleRequestWithTendersSchema,
  CaptureSaleRequestWithVoucherTendersSchema,
} from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { CaptureSaleRequestPipe } from "../../../../src/catalog/sales/dto/capture-sale-request.pipe";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import { isPosSaleVoucherTenderEnabled } from "../../../../src/catalog/sales/sale-tenders-gate";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const SAME_METHOD_FLAG = "POS_SALE_TENDERS_SAME_METHOD_ENABLED";
const VOUCHER_FLAG = "POS_SALE_VOUCHER_TENDER_ENABLED";

const REDEMPTION_A = "0197d3a0-1111-7000-8000-00000000a001";
const REDEMPTION_B = "0197d3a0-1111-7000-8000-00000000a002";
const REF_A = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const REF_B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const REF_C = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

function body(tenders: unknown[]): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-rt1114-dto",
    currencyCode: "EGP",
    posTotal: "100.0000",
    occurredAt: "2026-11-12T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "100.0000",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "100.0000",
        unit: "ea",
      },
    ],
    tenders,
  };
}

const VOUCHER = { method: "voucher", amount: "30", redemptionId: REDEMPTION_A };
const CASH = { method: "cash", amount: "70" };

const pipe = new CaptureSaleRequestPipe();
const parse = (value: unknown): unknown => pipe.transform(value, { type: "body" });

afterEach(() => {
  delete process.env[TENDERS_FLAG];
  delete process.env[SAME_METHOD_FLAG];
  delete process.env[VOUCHER_FLAG];
});

describe("RT-1114 — POS_SALE_VOUCHER_TENDER_ENABLED gate (acceptance 2: built, not switched on)", () => {
  it("is off when unset, empty or not an enabling value", () => {
    expect(isPosSaleVoucherTenderEnabled()).toBe(false);
    for (const v of ["", "0", "false", "no", "off", "enabled"]) {
      process.env[VOUCHER_FLAG] = v;
      expect(isPosSaleVoucherTenderEnabled()).toBe(false);
    }
  });

  it("is on for 1 / true / yes, case-insensitive and trimmed", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "Yes"]) {
      process.env[VOUCHER_FLAG] = v;
      expect(isPosSaleVoucherTenderEnabled()).toBe(true);
    }
  });

  it("refuses a voucher tender (400) while the voucher gate is off, whatever the other tender gates say", () => {
    for (const [tenders, sameMethod] of [
      [undefined, undefined],
      ["true", undefined],
      ["true", "true"],
    ] as const) {
      if (tenders) process.env[TENDERS_FLAG] = tenders;
      if (sameMethod) process.env[SAME_METHOD_FLAG] = sameMethod;
      expect(() => parse(body([CASH, VOUCHER]))).toThrow(ZodError);
      expect(() => parse(body([{ ...VOUCHER, amount: "100" }]))).toThrow(ZodError);
    }
  });

  it("does nothing while the tenders gate is off: a body with tenders is still a 400", () => {
    process.env[VOUCHER_FLAG] = "true";
    expect(() => parse(body([CASH, VOUCHER]))).toThrow(ZodError);
    expect(() => parse(body([{ method: "cash", amount: "100" }]))).toThrow(ZodError);
  });

  it("the default tender schema has no voucher method", () => {
    expect(CaptureSaleRequestWithTendersSchema.safeParse(body([CASH, VOUCHER])).success).toBe(false);
  });
});

describe("RT-1114 — tenders gate and voucher gate ON", () => {
  beforeEach(() => {
    process.env[TENDERS_FLAG] = "true";
    process.env[VOUCHER_FLAG] = "true";
  });

  it("accepts a voucher tender with its redemptionId next to a cash tender", () => {
    const parsed = parse(body([CASH, VOUCHER])) as { tenders: unknown[] };
    expect(parsed.tenders).toEqual([CASH, VOUCHER]);
  });

  it("accepts tenderRef and sequence on a voucher tender", () => {
    const voucher = { ...VOUCHER, tenderRef: REF_A, sequence: 2 };
    expect((parse(body([{ ...CASH, tenderRef: REF_B, sequence: 1 }, voucher])) as { tenders: unknown[] }).tenders).toContainEqual(
      voucher,
    );
  });

  it("refuses a voucher without a redemptionId, or with one that is not a uuid", () => {
    expect(() => parse(body([CASH, { method: "voucher", amount: "30" }]))).toThrow(ZodError);
    expect(() => parse(body([CASH, { ...VOUCHER, redemptionId: "R-1" }]))).toThrow(ZodError);
  });

  it("refuses a redemptionId on cash or card_external, and a reference on a voucher", () => {
    expect(() => parse(body([{ ...CASH, redemptionId: REDEMPTION_B }, VOUCHER]))).toThrow(ZodError);
    expect(() =>
      parse(body([{ method: "card_external", amount: "70", redemptionId: REDEMPTION_B }, VOUCHER])),
    ).toThrow(ZodError);
    expect(() => parse(body([CASH, { ...VOUCHER, reference: "AB12" }]))).toThrow(ZodError);
  });

  it("refuses an unknown method still", () => {
    expect(() => parse(body([CASH, { method: "gift_card", amount: "30" }]))).toThrow(ZodError);
  });

  it("refuses two voucher tenders while the same-method gate is off", () => {
    const second = { ...VOUCHER, redemptionId: REDEMPTION_B, amount: "10" };
    expect(() => parse(body([{ ...CASH, amount: "60" }, VOUCHER, second]))).toThrow(ZodError);
  });

  describe("with the same-method gate ON as well", () => {
    beforeEach(() => {
      process.env[SAME_METHOD_FLAG] = "true";
    });

    it("accepts two voucher tenders that each carry a tenderRef and their own redemption", () => {
      const a = { ...VOUCHER, tenderRef: REF_A, sequence: 1 };
      const b = { ...VOUCHER, redemptionId: REDEMPTION_B, amount: "10", tenderRef: REF_B, sequence: 2 };
      const cash = { ...CASH, amount: "60", tenderRef: REF_C, sequence: 3 };
      expect((parse(body([a, b, cash])) as { tenders: unknown[] }).tenders).toHaveLength(3);
    });

    it("refuses one redemption on two tenders even when its case differs (400, never a 500 at the unique index)", () => {
      const a = { ...VOUCHER, tenderRef: REF_A, sequence: 1 };
      const b = { ...VOUCHER, redemptionId: REDEMPTION_A.toUpperCase(), amount: "10", tenderRef: REF_B, sequence: 2 };
      expect(() => parse(body([a, b, { ...CASH, amount: "60", tenderRef: REF_C, sequence: 3 }]))).toThrow(ZodError);
    });

    it("refuses one redemption on two tenders of the sale (400)", () => {
      const a = { ...VOUCHER, tenderRef: REF_A, sequence: 1 };
      const b = { ...VOUCHER, amount: "10", tenderRef: REF_B, sequence: 2 };
      const err = (() => {
        try {
          parse(body([a, b, { ...CASH, amount: "60", tenderRef: REF_C, sequence: 3 }]));
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(ZodError);
      expect(JSON.stringify((err as ZodError).issues)).toContain("redemptionId must be unique within the sale");
    });
  });
});

describe("RT-1114 — redemptionId is part of the payload hash", () => {
  it("a different redemptionId is a different payload (a replay that changes it is a 409)", () => {
    const a = CaptureSaleRequestWithVoucherTendersSchema.parse(body([CASH, VOUCHER]));
    const b = CaptureSaleRequestWithVoucherTendersSchema.parse(
      body([CASH, { ...VOUCHER, redemptionId: REDEMPTION_B }]),
    );
    expect(sha256CanonicalHex(a)).not.toBe(sha256CanonicalHex(b));
  });

  it("a cash and card body hashes identically whichever schema parsed it", () => {
    const tenders = [{ method: "card_external", amount: "30", reference: "AB12" }, CASH];
    const plain = CaptureSaleRequestWithTendersSchema.parse(body(tenders));
    const voucherAware = CaptureSaleRequestWithVoucherTendersSchema.parse(body(tenders));
    expect(sha256CanonicalHex(voucherAware)).toBe(sha256CanonicalHex(plain));
  });
});
