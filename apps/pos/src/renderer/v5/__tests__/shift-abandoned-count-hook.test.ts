/**
 * RT-1003 review (PR #169) — `useAbandonedCount` races the panel's own state:
 * the unmount report must use what the panel committed and what it has
 * already reported, not a render that never committed.
 *
 *   • an approved close marked complete reports nothing on unmount, even when
 *     the panel goes before the render that clears the approval commits;
 *   • a dismissed approval reports once, even when the panel goes before the
 *     render that clears it commits;
 *   • a later send opens a new approval, which is reported again.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types';
import { useAbandonedCount } from '../shift/abandoned-count';

function setup(approving: number | null, count = '520') {
  const abandonCount = vi.fn<ShiftCashupBridgeAPI['abandonCount']>(() =>
    Promise.resolve({ kind: 'recorded' }),
  );
  const bridge = { abandonCount } as unknown as ShiftCashupBridgeAPI;
  const hook = renderHook(
    (props: { approving: number | null; count: string }) =>
      useAbandonedCount({ bridge, currencyCode: 'EGP', ...props }),
    { initialProps: { approving, count } },
  );
  return { hook, abandonCount };
}

describe('useAbandonedCount — unmount before the clearing render commits', () => {
  it('reports nothing after an approved close was marked complete', () => {
    const { hook, abandonCount } = setup(52_000);
    hook.result.current.markSent('520');
    hook.result.current.markCompleted();
    hook.unmount();
    expect(abandonCount).not.toHaveBeenCalled();
  });

  it('reports a dismissed approval once', () => {
    const { hook, abandonCount } = setup(52_000);
    hook.result.current.markSent('520');
    hook.result.current.abandonApproval(52_000);
    hook.unmount();
    expect(abandonCount).toHaveBeenCalledTimes(1);
    expect(abandonCount).toHaveBeenCalledWith({ countedCashMinor: 52_000 });
  });

  it('reports a new approval opened by a later send', () => {
    const { hook, abandonCount } = setup(52_000);
    hook.result.current.markSent('520');
    hook.result.current.abandonApproval(52_000);
    hook.rerender({ approving: null, count: '530' });
    hook.result.current.markSent('530');
    hook.rerender({ approving: 53_000, count: '530' });
    hook.unmount();
    expect(abandonCount.mock.calls).toEqual([
      [{ countedCashMinor: 52_000 }],
      [{ countedCashMinor: 53_000 }],
    ]);
  });

  it('still reports an open approval left unanswered', () => {
    const { hook, abandonCount } = setup(52_000);
    hook.result.current.markSent('520');
    hook.unmount();
    expect(abandonCount).toHaveBeenCalledWith({ countedCashMinor: 52_000 });
  });
});
