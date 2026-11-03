import { describe, expect, it } from 'vitest';

import { SIGN_IN_COPY, nameInitial } from '../entry-copy';

/** RT-1094 (RT-1042 OD-14) — the owner-approved roster loading statement. */
describe('SIGN_IN_COPY.rosterLoading', () => {
  it('carries the approved copy', () => {
    expect(SIGN_IN_COPY.rosterLoading).toBe('جارٍ تحميل قائمة الكاشير…');
  });
});

/**
 * RT-244 — the roster badge is ONE letter: two letters (`slice(0, 2)`) break
 * Arabic letter joining, and a code unit split breaks a surrogate pair.
 */
describe('nameInitial', () => {
  it('takes the first letter of the trimmed name', () => {
    expect(nameInitial('  منى عبد الرحمن')).toBe('م');
    expect(nameInitial('Ahmed')).toBe('A');
  });

  it('keeps a character outside the BMP whole', () => {
    expect(nameInitial('𝐀bc')).toBe('𝐀');
  });

  it('returns an empty badge for a blank name', () => {
    expect(nameInitial('')).toBe('');
    expect(nameInitial('   ')).toBe('');
  });
});
