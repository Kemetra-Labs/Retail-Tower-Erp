import { describe, expect, it } from 'vitest';

import { normalisePairingCode } from '../normalise-code';

// Obviously fake codes: 16 characters from the Console alphabet.
const CONSOLE_CODE = 'ABCD2345EFGH6789';

describe('normalisePairingCode (RT-1316 Phase 2)', () => {
  it.each([
    ['as issued', 'ABCD2345EFGH6789'],
    ['grouped with dashes', 'ABCD-2345-EFGH-6789'],
    ['lower case', 'abcd2345efgh6789'],
    ['lower case, grouped', 'abcd-2345-efgh-6789'],
    ['spaced', 'ABCD 2345 EFGH 6789'],
    ['surrounding whitespace', '  ABCD-2345-EFGH-6789\t'],
    ['mixed separators', 'abcd - 2345 efgh-6789'],
    ['a non-breaking space', 'ABCD 2345EFGH6789'],
    ['an en dash', 'ABCD–2345–EFGH–6789'],
  ])('a Console code %s is sent canonical', (_case, input) => {
    expect(normalisePairingCode(input)).toBe(CONSOLE_CODE);
  });

  it.each([
    // The bootstrap CLI's --generate form: 24 base64url characters, case-sensitive.
    ['a base64url bootstrap code', 'aB3-dE_fGh1jKl2mNo-pQr4s'],
    ['a code with a look-alike letter', 'ABCD-2345-EFGH-678O'],
    ['a code that is too short', 'ABCD-2345-EFGH'],
    ['a code that is too long', 'ABCD-2345-EFGH-6789-A'],
  ])('%s is sent as typed, only trimmed', (_case, input) => {
    expect(normalisePairingCode(`  ${input} `)).toBe(input);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['separators only', ' - - '],
  ])('%s input normalises to the empty string', (_case, input) => {
    expect(normalisePairingCode(input)).toBe('');
  });
});
