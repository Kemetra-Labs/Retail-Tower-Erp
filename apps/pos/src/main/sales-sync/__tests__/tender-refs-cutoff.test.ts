/**
 * RT-363 — reading `POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE`: a valid explicit-zone instant, or
 * off. A set but invalid value warns once with a closed-set message (no instant in the log).
 */
import { describe, expect, it } from 'vitest';

import {
  readTenderRefsSince,
  TENDER_REFS_LOG,
  TENDER_REFS_SINCE_ENV,
} from '../tender-refs-cutoff.js';

function read(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const value = readTenderRefsSince(env, { warn: (msg) => warnings.push(msg) });
  return { value, warnings };
}

describe('readTenderRefsSince', () => {
  it('is the variable the Jira issue names', () => {
    expect(TENDER_REFS_SINCE_ENV).toBe('POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE');
  });

  it('unset or blank -> off, no warning (the normal state)', () => {
    expect(read({})).toEqual({ value: null, warnings: [] });
    expect(read({ [TENDER_REFS_SINCE_ENV]: '  ' })).toEqual({ value: null, warnings: [] });
  });

  it('a valid instant -> its canonical UTC form, no warning', () => {
    expect(read({ [TENDER_REFS_SINCE_ENV]: '2026-12-01T02:00:00+02:00' })).toEqual({
      value: '2026-12-01T00:00:00.000Z',
      warnings: [],
    });
  });

  it('a set but invalid value -> off with one warning that carries no instant', () => {
    const { value, warnings } = read({ [TENDER_REFS_SINCE_ENV]: '2026-12-01' });
    expect(value).toBeNull();
    expect(warnings).toEqual([TENDER_REFS_LOG.unparseable]);
    expect(warnings[0]).not.toContain('2026');
  });
});
