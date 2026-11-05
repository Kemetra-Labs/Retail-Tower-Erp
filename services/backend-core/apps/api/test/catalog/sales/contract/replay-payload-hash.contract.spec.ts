/**
 * replay-payload-hash.contract.spec.ts — RT-1206 (`pos-sales/sales.yaml`
 * 1.18.0-draft). Pins the contract text of the provenance-replay rule: a
 * replay whose sale facts differ from the captured sale is 409
 * `idempotency_key_conflict` (the existing `Conflict` response, widened), and
 * the response set of `captureSale` is unchanged (no new status or code).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load as parseYaml } from "js-yaml";

import { CONTRACTS_DIR } from "../../../_helpers/openapi-routes";

type Op = { description: string; responses: Record<string, { $ref?: string; description?: string }> };
type Doc = {
  info: { version: string; description: string };
  paths: Record<string, Record<string, Op>>;
  components: { responses: Record<string, { description: string }> };
};

const doc = parseYaml(readFileSync(join(CONTRACTS_DIR, "pos-sales/sales.yaml"), "utf8")) as Doc;
const flat = (text: string): string => text.replace(/\s+/g, " ");
const capture = (doc.paths["/api/pos/v1/sales"] as Record<string, Op>)["post"] as Op;

describe("RT-1206 — captureSale provenance replay with a different payload (contract)", () => {
  it("the note cites the owner confirmation and states the rule and the compat path", () => {
    const info = flat(doc.info.description);
    expect(info).toContain("RT-1206 (1.18.0-draft; [GATED] owner confirmation Jira RT-1206 comment 15587");
    expect(info).toContain("is now 409 `idempotency_key_conflict` (the existing `Conflict` code, widened)");
    expect(info).toContain("the stored `payload_hash` bytes are unchanged");
    expect(info).toContain("dead-letter `payload_divergence`");
  });

  it("the RT-740 discount note no longer says a provenance replay is not compared", () => {
    const info = flat(doc.info.description);
    expect(info).not.toContain("it is not compared on a provenance replay");
    expect(info).toContain("with a changed `discount` is also 409 `idempotency_key_conflict` (RT-1206)");
  });

  it("the response set is unchanged: 409 is still the shared Conflict response", () => {
    expect(Object.keys(capture.responses).sort()).toEqual(
      ["200", "201", "400", "401", "403", "409", "422", "429", "500"].sort(),
    );
    expect(capture.responses["409"]!.$ref).toBe("#/components/responses/Conflict");
  });

  it("the 200 is a replay of the same sale facts only, and Conflict names the provenance case", () => {
    expect(flat(capture.responses["200"]!.description!)).toContain(
      "was already captured with the same sale facts (the re-sent body hashes to the stored `payload_hash`, RT-1206; otherwise 409)",
    );
    const conflict = flat(doc.components.responses["Conflict"]!.description);
    expect(conflict).toContain("The single wire `error.code` is `idempotency_key_conflict`");
    expect(conflict).toContain("a provenance replay under another key whose sale facts differ from the captured sale's");
  });

  it("the description states the byte-exact compare, the excluded fields and the store-scope order", () => {
    const d = flat(capture.description);
    expect(d).toContain("without `operatorUserId`, `admissionCheckAt` and `receipt`");
    expect(d).toContain("so reordered arrays or a differently written decimal differ");
    expect(d).toContain("The store scope is decided first");
    expect(d).toContain("so is a provenance replay under another key with different tracking (RT-1206)");
  });
});
