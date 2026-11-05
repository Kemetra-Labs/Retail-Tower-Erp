/**
 * RT-1224 — the sale capture `payload_hash` bytes are pinned.
 *
 * The vectors (`__support__/capture-hash-golden.ts`) are literals captured
 * before `captureSale` was decomposed. This spec fails if the hashing of a
 * capture body changes; the characterization matrix checks the same literals
 * against the stored `sales.payload_hash` column.
 */
import { sha256CanonicalHex } from "../../../src/catalog/sales/payload-hash";
import { CAPTURE_HASH_VECTORS } from "./__support__/capture-hash-golden";

describe("RT-1224 — sale capture payload_hash golden vectors", () => {
  it.each(CAPTURE_HASH_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    expect(sha256CanonicalHex(v.body)).toBe(v.sha256Hex);
  });

  it("every vector hashes to a distinct value", () => {
    const hexes = CAPTURE_HASH_VECTORS.map((v) => v.sha256Hex);
    expect(new Set(hexes).size).toBe(hexes.length);
  });
});
