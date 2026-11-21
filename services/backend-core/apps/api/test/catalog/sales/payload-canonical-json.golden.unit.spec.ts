/**
 * RT-1214 — direct golden bytes for `canonicalJsonPayload`, the serializer
 * behind every `payload_hash`. The hashed checks live in
 * `payload-hash.golden.unit.spec.ts`; these pin the exact string so a stray
 * byte shows as a readable diff. (The settlement-intent request-hash spec left
 * with the A/R ledger runtime, RT-422.)
 */
import { canonicalJsonPayload } from "../../../src/common/hashing/payload-hash";
import {
  GOLDEN_FIXTURE,
  GOLDEN_STRING,
  RECEIVABLE_INTENT_VECTORS,
} from "../../_helpers/canonical-json-golden";

describe("canonicalJsonPayload golden strings (RT-1214)", () => {
  it("serializes the shared fixture to the golden string", () => {
    expect(canonicalJsonPayload(GOLDEN_FIXTURE)).toBe(GOLDEN_STRING);
  });

  it.each(RECEIVABLE_INTENT_VECTORS.map((v) => [v.name, v] as const))(
    "%s: intent shape serializes to the pinned string",
    (_name, vector) => {
      const shape = {
        saleRef: vector.saleRef,
        payers: vector.payers.map((p) => ({
          payerRef: p.payerRef,
          owedAmount: p.owedAmount,
          claimMetadata: p.claimMetadata ?? null,
        })),
      };
      expect(canonicalJsonPayload(shape)).toBe(vector.canonical);
    },
  );
});
