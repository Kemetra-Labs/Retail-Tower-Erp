/**
 * RT-1252 — POS fleet refs (OBS-1 §1 "POS fleet refs"): server-minted,
 * deterministic, domain-separated, truncated HMACs; the key is required and
 * at least 32 characters.
 */
import { createHmac } from "node:crypto";

import {
  MIN_REF_KEY_LENGTH,
  REF_LENGTH,
  mintFleetRefs,
  resolveRefKey,
} from "../../src/pos-telemetry/pos-telemetry.refs";

const KEY = "k".repeat(MIN_REF_KEY_LENGTH);
const SAME_ID = "01928f3e-7b1c-7d2a-9e4f-000000000001";
const SCOPE = { deviceId: "dev-1", tenantId: "tenant-1", storeId: "store-1" };

describe("mintFleetRefs", () => {
  it("is an HMAC-SHA256 of kind:id, cut to the ref length", () => {
    const expected = createHmac("sha256", KEY).update("store:store-1").digest("hex").slice(0, REF_LENGTH);
    expect(mintFleetRefs(KEY, SCOPE).store_ref).toBe(expected);
  });

  it("is deterministic and lower-case hex of the ref length", () => {
    const refs = mintFleetRefs(KEY, SCOPE);
    expect(mintFleetRefs(KEY, SCOPE)).toEqual(refs);
    for (const value of Object.values(refs)) expect(value).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates kinds: the same id gives different tenant, store and terminal refs", () => {
    const refs = mintFleetRefs(KEY, { deviceId: SAME_ID, tenantId: SAME_ID, storeId: SAME_ID });
    expect(new Set(Object.values(refs)).size).toBe(3);
  });

  it("changes with the key and never contains the raw id", () => {
    const refs = mintFleetRefs(KEY, SCOPE);
    expect(mintFleetRefs("z".repeat(MIN_REF_KEY_LENGTH), SCOPE)).not.toEqual(refs);
    expect(JSON.stringify(refs)).not.toContain("store-1");
  });
});

describe("resolveRefKey", () => {
  it.each([
    ["unset", {}],
    ["blank", { POS_TELEMETRY_REF_KEY: "   " }],
    ["too short", { POS_TELEMETRY_REF_KEY: "k".repeat(MIN_REF_KEY_LENGTH - 1) }],
  ])("is null when %s", (_label, env) => {
    expect(resolveRefKey(env as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns a key of at least the minimum length, trimmed", () => {
    expect(resolveRefKey({ POS_TELEMETRY_REF_KEY: ` ${KEY} ` } as NodeJS.ProcessEnv)).toBe(KEY);
  });
});
