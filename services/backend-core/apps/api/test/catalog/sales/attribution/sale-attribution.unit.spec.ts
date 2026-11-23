/**
 * RT-1565 (RT-285 F-1) — seller per line and payment receiver per tender, unit (no DB).
 *
 *   - DTO: `lines[].sellerUserId` and `tenders[].receivedByUserId` are optional uuids on every capture body;
 *     anything else is a 400;
 *   - split: the attribution comes out of the body; what is left hashes exactly like the same sale sent
 *     without it (owner choice: not hashed, like `operatorUserId`), and the input is not changed;
 *   - resolve: nothing named reads nothing; each distinct id (case-insensitive) is checked once; any id
 *     that is not eligible is one `SaleSellerRefusedError`; a seller is frozen with the sale's store and the
 *     role the member held.
 */
import type { PoolClient } from "pg";

import * as auth from "../../../../src/auth";
import * as memberships from "../../../../src/memberships";
import { sha256CanonicalHex } from "../../../../src/common/hashing/payload-hash";
import {
  CaptureSaleRequestSchema,
  CaptureSaleRequestWithSameMethodVoucherTendersSchema,
  type CaptureSaleRequestDto,
} from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import {
  hasSaleAttribution,
  NO_ATTRIBUTION,
  resolveSaleAttribution,
  splitSaleAttribution,
} from "../../../../src/catalog/sales/sale-attribution";
import { SaleSellerRefusedError } from "../../../../src/catalog/sales/sale-errors";
import { saleFactsDigest, saleFactsOf } from "../../../../src/catalog/sales/quarantine/quarantine-facts";

// The two module ports are mocked: this spec covers the orchestration, the db-integration spec the SQL.
jest.mock("../../../../src/memberships", () => ({ attributableMembersAt: jest.fn() }));
jest.mock("../../../../src/auth", () => ({ usersLiveAt: jest.fn() }));
const attributableMembersAt = jest.mocked(memberships.attributableMembersAt);
const usersLiveAt = jest.mocked(auth.usersLiveAt);

const TENANT = "0a000000-0000-7000-8000-000000156511";
const STORE = "0a000000-0000-7000-8000-000000156512";
const SELLER_1 = "0a000000-0000-7000-8000-000000156513";
const SELLER_2 = "0a000000-0000-7000-8000-000000156514";
const RECEIVER = "0a000000-0000-7000-8000-000000156515";
const ROLE_1 = "0a000000-0000-7000-8000-000000156516";
const ROLE_2 = "0a000000-0000-7000-8000-000000156517";
const OCCURRED_AT = "2026-11-23T10:00:00.000Z";

const line = (name: string, extra: Record<string, unknown> = {}) => ({
  lineName: name,
  unitPrice: "5.0000",
  currencyCode: "EGP",
  quantity: "1",
  lineAmount: "5.0000",
  unit: "ea",
  ...extra,
});

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "rt1565-unit",
    currencyCode: "EGP",
    posTotal: "10.0000",
    occurredAt: OCCURRED_AT,
    lines: [line("A"), line("B")],
    ...overrides,
  };
}

const parse = (raw: unknown): CaptureSaleRequestDto =>
  CaptureSaleRequestWithSameMethodVoucherTendersSchema.parse(raw) as CaptureSaleRequestDto;

describe("RT-1565 — capture DTO", () => {
  it("accepts a seller per line and a receiver per tender", () => {
    const raw = body({
      lines: [line("A", { sellerUserId: SELLER_1 }), line("B")],
      tenders: [
        { method: "cash", amount: "4", tenderRef: "0a000000-0000-7000-8000-000000156521", receivedByUserId: RECEIVER },
        { method: "card_external", amount: "6", reference: "A1", tenderRef: "0a000000-0000-7000-8000-000000156522" },
      ],
    });
    const parsed = parse(raw);
    expect(parsed.lines[0]!.sellerUserId).toBe(SELLER_1);
    expect(parsed.tenders![0]!.receivedByUserId).toBe(RECEIVER);
  });

  it("accepts a seller on the pre-RT-77 body too (the line shape is shared)", () => {
    expect(CaptureSaleRequestSchema.safeParse(body({ lines: [line("A", { sellerUserId: SELLER_1 })] })).success).toBe(
      true,
    );
  });

  it.each([
    ["a non-uuid seller", body({ lines: [line("A", { sellerUserId: "S100" })] })],
    ["a null seller", body({ lines: [line("A", { sellerUserId: null })] })],
    ["a non-uuid receiver", body({ tenders: [{ method: "cash", amount: "10", receivedByUserId: "me" }] })],
    ["a receiver on the body, not a tender", body({ receivedByUserId: RECEIVER })],
    ["a seller on the body, not a line", body({ sellerUserId: SELLER_1 })],
  ])("refuses %s (400)", (_label, raw) => {
    expect(CaptureSaleRequestWithSameMethodVoucherTendersSchema.safeParse(raw).success).toBe(false);
  });
});

describe("RT-1565 — splitSaleAttribution", () => {
  it("leaves a body that names no one as it was, hash included", () => {
    const plain = parse(body({ tenders: [{ method: "cash", amount: "10" }] }));
    const { body: stripped, attribution } = splitSaleAttribution(plain);
    expect(stripped).toEqual(plain);
    expect(sha256CanonicalHex(stripped)).toBe(sha256CanonicalHex(plain));
    expect(attribution).toEqual({ lineSellers: [null, null], tenderReceivers: [null] });
    expect(hasSaleAttribution(attribution)).toBe(false);
  });

  it("takes the sellers and receivers out, so the sale hashes as if they were never sent", () => {
    const plain = parse(body({ tenders: [{ method: "cash", amount: "10" }] }));
    const named = parse(
      body({
        lines: [line("A", { sellerUserId: SELLER_1 }), line("B", { sellerUserId: SELLER_2 })],
        tenders: [{ method: "cash", amount: "10", receivedByUserId: RECEIVER }],
      }),
    );
    const { body: stripped, attribution } = splitSaleAttribution(named);
    expect(sha256CanonicalHex(stripped)).toBe(sha256CanonicalHex(plain));
    expect(attribution).toEqual({ lineSellers: [SELLER_1, SELLER_2], tenderReceivers: [RECEIVER] });
    expect(hasSaleAttribution(attribution)).toBe(true);
  });

  it("does not change its input, and keeps a tender-less body tender-less", () => {
    const named = parse(body({ lines: [line("A", { sellerUserId: SELLER_1 })] }));
    const before = JSON.stringify(named);
    const { body: stripped, attribution } = splitSaleAttribution(named);
    expect(JSON.stringify(named)).toBe(before);
    expect("tenders" in stripped).toBe(false);
    expect(attribution.tenderReceivers).toEqual([]);
  });
});

const SALE = { tenantId: TENANT, storeId: STORE, occurredAt: OCCURRED_AT };
const CLIENT = {} as PoolClient;

/** Arrange the two ports: eligible members (user → role) and live users. */
function arrange(members: Record<string, string>, live: readonly string[]): void {
  attributableMembersAt.mockResolvedValue(new Map(Object.entries(members)));
  usersLiveAt.mockResolvedValue(new Set(live));
}

beforeEach(() => {
  attributableMembersAt.mockReset();
  usersLiveAt.mockReset();
});

describe("RT-1565 — resolveSaleAttribution", () => {
  it("reads nothing when no one is named", async () => {
    expect(await resolveSaleAttribution(CLIENT, SALE, NO_ATTRIBUTION)).toEqual({ lineSellers: [], tenderReceivers: [] });
    const allNull = { lineSellers: [null, null], tenderReceivers: [null] };
    expect(await resolveSaleAttribution(CLIENT, SALE, allNull)).toEqual(allNull);
    expect(attributableMembersAt).not.toHaveBeenCalled();
    expect(usersLiveAt).not.toHaveBeenCalled();
  });

  it("checks each distinct id once (case-insensitive) and freezes the sale's store and the member's role", async () => {
    arrange({ [SELLER_1]: ROLE_1, [SELLER_2]: ROLE_2 }, [SELLER_1, SELLER_2]);
    const resolved = await resolveSaleAttribution(CLIENT, SALE, {
      lineSellers: [SELLER_1.toUpperCase(), SELLER_2, null, SELLER_1],
      tenderReceivers: [SELLER_2, null],
    });
    expect(attributableMembersAt).toHaveBeenCalledTimes(1);
    expect(attributableMembersAt).toHaveBeenCalledWith(CLIENT, {
      tenantId: TENANT,
      storeId: STORE,
      userIds: [SELLER_1, SELLER_2],
      at: OCCURRED_AT,
    });
    expect(usersLiveAt).toHaveBeenCalledWith(CLIENT, { userIds: [SELLER_1, SELLER_2], at: OCCURRED_AT });
    expect(resolved.lineSellers).toEqual([
      { userId: SELLER_1, storeId: STORE, roleId: ROLE_1 },
      { userId: SELLER_2, storeId: STORE, roleId: ROLE_2 },
      null,
      { userId: SELLER_1, storeId: STORE, roleId: ROLE_1 },
    ]);
    expect(resolved.tenderReceivers).toEqual([SELLER_2, null]);
  });

  it("refuses a receiver who is not an eligible member", async () => {
    arrange({ [SELLER_1]: ROLE_1 }, [SELLER_1, RECEIVER]);
    await expect(
      resolveSaleAttribution(CLIENT, SALE, { lineSellers: [SELLER_1], tenderReceivers: [RECEIVER] }),
    ).rejects.toBeInstanceOf(SaleSellerRefusedError);
  });

  it("refuses an eligible member whose user was deleted at the sale", async () => {
    arrange({ [SELLER_1]: ROLE_1 }, []);
    await expect(
      resolveSaleAttribution(CLIENT, SALE, { lineSellers: [SELLER_1], tenderReceivers: [] }),
    ).rejects.toBeInstanceOf(SaleSellerRefusedError);
  });
});

describe("RT-1565 — the quarantine same-facts digest matches the capture hash", () => {
  it("ignores each line's seller and each tender's receiver, like captureSale", () => {
    const plain = body({ tenders: [{ method: "cash", amount: "10" }] });
    const named = body({
      lines: [line("A", { sellerUserId: SELLER_1 }), line("B")],
      tenders: [{ method: "cash", amount: "10", receivedByUserId: RECEIVER }],
    });
    expect(saleFactsDigest(named)).toBe(saleFactsDigest(plain));
    expect(saleFactsDigest(named)).toBe(sha256CanonicalHex(splitSaleAttribution(parse(named)).body));
  });

  it("leaves malformed entries as they are (a quarantined body is arbitrary JSON)", () => {
    const odd = body({ lines: ["x", null, [1]], tenders: "none" });
    expect(saleFactsOf(odd)).toEqual(odd);
  });
});
