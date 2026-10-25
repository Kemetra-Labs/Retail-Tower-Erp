import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type SentryEventLike, scrubSentryEvent } from '../scrub.js';

/**
 * RT-879 — the union of the rules any runtime masks. `rt879-redaction-vectors.json`
 * is shared unchanged by POS, Admin-Console, Backend-Core and the Connector
 * (`tools/contracts-check` `identical:`). A vector names what must not survive
 * (and, for negatives, what must be kept), so a runtime may still mask more; the
 * exact §3.2 outputs stay pinned by the OBS-1 golden vectors.
 *
 * If a vector fails, fix the SOURCE — never the fixture.
 */

interface UnionVectors {
  topLevelAllowlist: string[];
  messages: { id: string; input: string; mustNotContain: string[]; mustContain: string[] }[];
  events: { id: string; event: SentryEventLike; drop?: boolean; mustNotContain?: string[] }[];
  linearTime: {
    maxTotalMs: number;
    maxOutputLength: number;
    inputs: { pattern: string; repeat: number }[];
  };
}

const union = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'rt879-redaction-vectors.json'),
    'utf8',
  ),
) as UnionVectors;

function scrubValue(value: string): string {
  const out = scrubSentryEvent({ exception: { values: [{ type: 'Error', value }] } });
  return out?.exception?.values?.[0]?.value ?? '';
}

describe('RT-879 redaction vectors (union of the four runtimes)', () => {
  it.each(union.messages.map((v) => [v.id, v] as const))('%s: leaks nothing it names', (_id, v) => {
    const value = scrubValue(v.input);
    for (const secret of v.mustNotContain) expect(value).not.toContain(secret);
    for (const kept of v.mustContain) expect(value).toContain(kept);
  });

  it.each(union.events.map((v) => [v.id, v] as const))(
    '%s: drops or rebuilds the event',
    (_id, v) => {
      const out = scrubSentryEvent(v.event);
      if (v.drop === true) {
        expect(out).toBeNull();
        return;
      }
      expect(out).not.toBeNull();
      for (const key of Object.keys(out ?? {})) expect(union.topLevelAllowlist).toContain(key);
      const serialized = JSON.stringify(out);
      for (const secret of v.mustNotContain ?? []) expect(serialized).not.toContain(secret);
    },
  );

  it('stays linear on the RT-879 adversarial inputs', () => {
    const { inputs, maxOutputLength, maxTotalMs } = union.linearTime;
    const started = performance.now();
    for (const { pattern, repeat } of inputs) {
      expect(scrubValue(pattern.repeat(repeat)).length).toBeLessThanOrEqual(maxOutputLength);
    }
    expect(performance.now() - started).toBeLessThan(maxTotalMs);
  });
});
