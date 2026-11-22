/**
 * RT-1498 close slice — whether the server's status read is available, as the last probe saw it.
 * `closeAvailable` is true ONLY when the last status read was answered with a verdict (not a 404).
 * Fail closed: before any probe, and after a 404, it is false. A fault that says nothing about the
 * route (a 5xx, a timeout, a 401) leaves the last answer as it was.
 */
import { describe, expect, it } from 'vitest';

import { createStatusReadAvailability } from '../returns-status-availability.js';

describe('status read availability', () => {
  it('is unavailable before any probe (unknown means false)', () => {
    expect(createStatusReadAvailability().isAvailable()).toBe(false);
  });

  it.each(['recorded', 'not_recorded'] as const)('a %s verdict makes it available', (kind) => {
    const availability = createStatusReadAvailability();
    availability.note({ kind } as never);
    expect(availability.isAvailable()).toBe(true);
  });

  it('a 404 makes it unavailable again', () => {
    const availability = createStatusReadAvailability();
    availability.note({ kind: 'not_recorded' });
    availability.note({ kind: 'unavailable' });
    expect(availability.isAvailable()).toBe(false);
  });

  it.each(['offline', 'unauthorized', 'server', 'unreadable'] as const)(
    'a %s fault leaves the last answer as it was',
    (cause) => {
      const availability = createStatusReadAvailability();
      availability.note({ kind: 'no_verdict', cause });
      expect(availability.isAvailable()).toBe(false);
      availability.note({ kind: 'not_recorded' });
      availability.note({ kind: 'no_verdict', cause });
      expect(availability.isAvailable()).toBe(true);
      availability.note({ kind: 'unavailable' });
      availability.note({ kind: 'no_verdict', cause });
      expect(availability.isAvailable()).toBe(false);
    },
  );
});
