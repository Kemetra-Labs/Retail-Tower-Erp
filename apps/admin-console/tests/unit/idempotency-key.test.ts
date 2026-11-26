import { newIdempotencyKey, reuseOrNewKey } from "@/lib/idempotency-key";
import { KeyedAttempt as HeldAttempt } from "@/lib/write-outcome";
import { buildSetBody, intentFingerprint, keyForIntent } from "@/stock-levels/stockLevelLogic";
import { keyFor as trackingKeyFor } from "@/tracking/writeLogic";
import { describe, expect, test } from "vitest";

/**
 * RT-1217: the one Idempotency-Key helper and the reuse rule every keyed write relies on. A retry
 * of the SAME request reuses its key (the server replays instead of writing twice); a changed
 * request gets a new key (the same key with another body is a 409 `idempotency_key_conflict`).
 */
const CONTRACT_FORMAT = /^[\x21-\x7E]{16,128}$/;

describe("newIdempotencyKey", () => {
  test("matches the contract format ^[\\x21-\\x7E]{16,128}$ and is a v4 UUID", () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(CONTRACT_FORMAT);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("is unique across calls", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe("reuseOrNewKey", () => {
  test("the first attempt mints a key for the fingerprint", () => {
    const attempt = reuseOrNewKey(undefined, "body-1");
    expect(attempt.fingerprint).toBe("body-1");
    expect(attempt.key).toMatch(CONTRACT_FORMAT);
  });

  test("null is the same as no previous attempt", () => {
    expect(reuseOrNewKey(null, "body-1").fingerprint).toBe("body-1");
  });

  test("the mint seam is called only when a new key is needed", () => {
    let n = 0;
    const mint = () => `minted-key-number-${++n}`;
    const first = reuseOrNewKey(undefined, "a", mint);
    reuseOrNewKey(first, "a", mint);
    reuseOrNewKey(first, "b", mint);
    expect(n).toBe(2);
  });
});

/**
 * The reuse rule through every entry point a feature uses: the shared function (cash policy,
 * payers, unknown items), the held-attempt class (brands, offers, count sessions, quarantine,
 * force actions, store deletion, catalog import), the command helpers (status move, tracking,
 * transfers) and the stock-level intent helper.
 */
type Keyer = (fingerprint: string) => string;

const entryPoints: ReadonlyArray<readonly [string, () => Keyer, () => { settle: () => void }]> = [
  [
    "reuseOrNewKey (cash policy, payers, unknown items)",
    () => {
      let held: ReturnType<typeof reuseOrNewKey> | undefined;
      return (fp) => {
        held = reuseOrNewKey(held, fp);
        return held.key;
      };
    },
    () => ({ settle: () => undefined }),
  ],
  [
    "KeyedAttempt class (brands, offers, counts, quarantine, force actions, store deletion, import)",
    () => {
      const attempt = new HeldAttempt();
      return (fp) => attempt.keyFor(fp);
    },
    () => new HeldAttempt(),
  ],
  [
    "keyFor (status move, tracking, transfers)",
    () => {
      let held: ReturnType<typeof trackingKeyFor> | null = null;
      return (fp) => {
        held = trackingKeyFor(held, fp);
        return held.key;
      };
    },
    () => ({ settle: () => undefined }),
  ],
  [
    "keyForIntent (stock levels)",
    () => {
      let held: ReturnType<typeof keyForIntent> | undefined;
      return (fp) => {
        held = keyForIntent(held, fp);
        return held.key;
      };
    },
    () => ({ settle: () => undefined }),
  ],
];

describe.each(entryPoints)("the reuse rule through %s", (_name, make) => {
  test("a retry of the same request reuses its key", () => {
    const keyer = make();
    const first = keyer("request-A");
    expect(keyer("request-A")).toBe(first);
    expect(keyer("request-A")).toBe(first);
  });

  test("a changed request gets a new key, and a retry of that one reuses the new key", () => {
    const keyer = make();
    const first = keyer("request-A");
    const changed = keyer("request-B");
    expect(changed).not.toBe(first);
    expect(keyer("request-B")).toBe(changed);
  });

  test("every key fits the contract format", () => {
    const keyer = make();
    expect(keyer("request-A")).toMatch(CONTRACT_FORMAT);
  });
});

describe("KeyedAttempt.settle (a terminal answer ends the key)", () => {
  test("the same body after settle is a new action with a new key", () => {
    const attempt = new HeldAttempt();
    const first = attempt.keyFor("body");
    expect(attempt.keyFor("body")).toBe(first);
    attempt.settle();
    expect(attempt.keyFor("body")).not.toBe(first);
  });
});

describe("keyForIntent (stock levels)", () => {
  test("keeps the key for the same target and body, mints for a changed body", () => {
    const target = { kind: "tenant" } as const;
    const body = buildSetBody({ reorder: "10", critical: "2" }, null);
    const changed = buildSetBody({ reorder: "10", critical: "3" }, null);
    const first = keyForIntent(undefined, intentFingerprint(target, body));
    expect(keyForIntent(first, intentFingerprint(target, body))).toBe(first);
    expect(keyForIntent(first, intentFingerprint(target, changed)).key).not.toBe(first.key);
  });
});
