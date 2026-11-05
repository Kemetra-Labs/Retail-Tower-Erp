import { describe, expect, it } from 'vitest';

import { touchTarget } from '../touch';

describe('touchTarget', () => {
  it('keeps the minimum touch target at 44px and a commit control no smaller', () => {
    expect(touchTarget.min).toBe(44);
    expect(touchTarget.commit).toBeGreaterThanOrEqual(touchTarget.min);
  });
});
