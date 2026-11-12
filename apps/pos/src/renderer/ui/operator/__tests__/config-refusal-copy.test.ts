import { describe, expect, it } from 'vitest';

import { SIGN_IN_REFUSAL_COPY } from '../messages';

/**
 * RT-1346 (RT-1345 D4) — the Arabic copy for a terminal whose server address or sign-in
 * identity setting is missing or invalid after resolution (environment, then the baked
 * file). UX-12: what is wrong, who fixes it, no pointless retry, no setting name or value.
 */

const ARABIC = /[؀-ۿ]/u;
const CATEGORIES = ['server_address_unconfigured', 'identity_unconfigured'] as const;

describe('missing-configuration refusal copy (D4)', () => {
  it.each(CATEGORIES)('%s is Arabic and says who fixes it', (category) => {
    const copy = SIGN_IN_REFUSAL_COPY[category];
    expect(copy).toMatch(ARABIC);
    expect(copy).toContain('مسؤول المتجر');
    expect(copy).toContain('Kemetra');
  });

  it('names the server address and the sign-in identity respectively', () => {
    expect(SIGN_IN_REFUSAL_COPY.server_address_unconfigured).toContain('عنوان الخادم');
    expect(SIGN_IN_REFUSAL_COPY.identity_unconfigured).toContain('معرّف مشروع الهوية');
  });

  it.each(CATEGORIES)('%s is not the credential message and offers no retry', (category) => {
    const copy = SIGN_IN_REFUSAL_COPY[category];
    expect(copy).not.toBe(SIGN_IN_REFUSAL_COPY.invalid_input);
    expect(copy).not.toContain('حاول مرة أخرى');
    // Names the problem in words, never an environment variable or an address.
    expect(copy).not.toMatch(/VITE_|DESCOPE_|https?:|example\./);
  });
});
