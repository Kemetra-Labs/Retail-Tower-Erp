/**
 * RT-1325 guard: only routes whose handler is itself guarded against a double
 * run may opt into the short claim lease (`claimLeaseSec`). The owner opted in
 * exactly one in RT-1325: the Connector posting ack. (POS sale capture is
 * guarded too, per the RT-1325 route/guard table, but stays on the default.)
 * A new opt-in fails here and needs the same review and an owner decision.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { Reflector } from "@nestjs/core";

import { ErpnextPostingController } from "../../src/catalog/erpnext-posting/erpnext-posting.controller";
import { SalesController } from "../../src/catalog/sales/sales.controller";
import {
  GUARDED_ROUTE_CLAIM_LEASE_SEC,
  IDEMPOTENT_OPTIONS_KEY,
  type IdempotentOptions,
} from "../../src/idempotency/idempotent.decorator";

const SRC = resolve(__dirname, "..", "..", "src");

/** Every reviewed opt-in: file → the number of routes in it that opt in. */
const REVIEWED_OPT_INS: Record<string, number> = {
  "catalog/erpnext-posting/erpnext-posting.controller.ts": 1,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function optionsOf(handler: object): IdempotentOptions {
  return new Reflector().get<IdempotentOptions>(IDEMPOTENT_OPTIONS_KEY, handler as () => unknown) ?? {};
}

describe("RT-1325 — the claim lease is opt-in for reviewed routes only", () => {
  it("only the reviewed files set claimLeaseSec on a route", () => {
    const optIns: Record<string, number> = {};
    for (const path of sourceFiles(SRC)) {
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join("\n");
      // A decorator call, possibly over several lines, naming claimLeaseSec.
      const uses = code.match(/@Idempotent\((?:[^()]|\([^()]*\))*?claimLeaseSec/g)?.length ?? 0;
      if (uses > 0) optIns[relative(SRC, path).replace(/\\/g, "/")] = uses;
    }
    expect(optIns).toEqual(REVIEWED_OPT_INS);
  });

  it("the Connector posting ack uses the reviewed lease", () => {
    expect(optionsOf(ErpnextPostingController.prototype.ackOutcome).claimLeaseSec).toBe(GUARDED_ROUTE_CLAIM_LEASE_SEC);
  });

  it("POS sale capture and its sibling void keep the default claim lifetime (owner decision)", () => {
    expect(optionsOf(SalesController.prototype.captureSale).claimLeaseSec).toBeUndefined();
    expect(optionsOf(SalesController.prototype.recordVoid).claimLeaseSec).toBeUndefined();
  });
});
