import { type SentryEventLike, scrubSentryEvent } from "@/observability/scrub";
import { describe, expect, test } from "vitest";
import golden from "./obs1-golden-vectors.json";
import union from "./rt879-redaction-vectors.json";

/**
 * RT-879: the Console scrubber against the two shared vector files, both copied
 * unchanged (`tools/contracts-check` `identical:`).
 *  - `obs1-golden-vectors.json`: the OBS-1 §3.5 exact outputs (RT-682, RT-694),
 *    required of every scrubber by contract §7 item 3.
 *  - `rt879-redaction-vectors.json`: the union of the rules any runtime masks. A
 *    vector names what must not survive (and, for negatives, what must be kept).
 *
 * If a vector fails, fix the SOURCE — never the fixture.
 */
function scrubValue(value: string): string {
  const out = scrubSentryEvent({ exception: { values: [{ type: "Error", value }] } });
  return out?.exception?.values?.[0]?.value ?? "";
}

function timeAll(inputs: { pattern: string; repeat: number }[], maxOutputLength: number): number {
  const started = performance.now();
  for (const { pattern, repeat } of inputs) {
    expect(scrubValue(pattern.repeat(repeat)).length).toBeLessThanOrEqual(maxOutputLength);
  }
  return performance.now() - started;
}

describe("OBS-1 §3.5 golden vectors (Bearer/Authorization and phones)", () => {
  test("carries all 46 contract vectors", () => {
    expect(golden.vectors).toHaveLength(46);
  });

  test.each(golden.vectors.map((v) => [v.id, v.input, v.expected] as const))(
    "%s: masks exactly as the contract vector says",
    (_id, input, expected) => {
      expect(scrubValue(input)).toBe(expected);
    },
  );

  test("stays linear on the contract's adversarial inputs", () => {
    const { inputs, maxOutputLength, maxTotalMs } = golden.linearTime;
    expect(timeAll(inputs, maxOutputLength)).toBeLessThan(maxTotalMs);
  });
});

describe("RT-879 redaction vectors (union of the four runtimes)", () => {
  // `sdk` carries only `infer_ip: "never"` (contract 3.3), a Console-only addition.
  const allowed = new Set([...union.topLevelAllowlist, "sdk"]);

  test.each(union.messages.map((v) => [v.id, v] as const))(
    "%s: leaks nothing it names",
    (_id, v) => {
      const value = scrubValue(v.input);
      for (const secret of v.mustNotContain) expect(value).not.toContain(secret);
      for (const kept of v.mustContain) expect(value).toContain(kept);
    },
  );

  test.each(union.events.map((v) => [v.id, v] as const))(
    "%s: drops or rebuilds the event",
    (_id, v) => {
      const out = scrubSentryEvent(v.event as SentryEventLike);
      if ("drop" in v && v.drop) {
        expect(out).toBeNull();
        return;
      }
      expect(out).not.toBeNull();
      for (const key of Object.keys(out ?? {})) expect(allowed).toContain(key);
      const serialized = JSON.stringify(out);
      const secrets: string[] = ("mustNotContain" in v ? v.mustNotContain : undefined) ?? [];
      for (const secret of secrets) expect(serialized).not.toContain(secret);
    },
  );

  test("stays linear on the RT-879 adversarial inputs", () => {
    const { inputs, maxOutputLength, maxTotalMs } = union.linearTime;
    expect(timeAll(inputs, maxOutputLength)).toBeLessThan(maxTotalMs);
  });
});
