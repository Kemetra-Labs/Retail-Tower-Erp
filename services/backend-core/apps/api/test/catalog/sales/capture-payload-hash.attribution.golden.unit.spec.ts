/**
 * RT-1565 (RT-285 F-1) — sellers and payment receivers never change the sale `payload_hash`.
 *
 * Every RT-1224 golden vector (literals pinned before RT-1565, `__support__/capture-hash-golden.ts`) is
 * re-sent with a `sellerUserId` on every line and a `receivedByUserId` on every tender. After the
 * controller's split (`splitSaleAttribution`) the hashed body must hash to the SAME pinned literal: an old
 * till's body and a new till's body for one sale are one payload (owner choice, RT-1565 comment 18562).
 */
import { sha256CanonicalHex } from "../../../src/common/hashing/payload-hash";
import { CaptureSaleRequestWithTendersSchema } from "../../../src/catalog/sales/dto/capture-sale-request.dto";
import { splitSaleAttribution } from "../../../src/catalog/sales/sale-attribution";
import { CAPTURE_HASH_VECTORS } from "./__support__/capture-hash-golden";

const SELLER = "0a000000-0000-7000-8000-000000156541";
const RECEIVER = "0a000000-0000-7000-8000-000000156542";

type Body = { lines: Array<Record<string, unknown>>; tenders?: Array<Record<string, unknown>> };

/** The vector's body with a seller on every line and a receiver on every tender. */
function withAttribution(body: unknown): Body {
  const b = body as Body;
  return {
    ...b,
    lines: b.lines.map((l) => ({ ...l, sellerUserId: SELLER })),
    ...(b.tenders === undefined ? {} : { tenders: b.tenders.map((t) => ({ ...t, receivedByUserId: RECEIVER })) }),
  };
}

describe("RT-1565 — sellers and receivers keep the RT-1224 golden payload_hash", () => {
  it.each(CAPTURE_HASH_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const named = CaptureSaleRequestWithTendersSchema.parse(withAttribution(v.body));
    const { body, attribution } = splitSaleAttribution(named);
    expect(sha256CanonicalHex(body)).toBe(v.sha256Hex);
    expect(attribution.lineSellers.every((id) => id === SELLER)).toBe(true);
    expect(attribution.tenderReceivers.every((id) => id === RECEIVER)).toBe(true);
  });

  it("the same body hashed WITHOUT the split differs (the split is what keeps the hash)", () => {
    const v = CAPTURE_HASH_VECTORS[0]!;
    expect(sha256CanonicalHex(withAttribution(v.body))).not.toBe(v.sha256Hex);
  });
});
