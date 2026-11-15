/**
 * RT-1322 (RT-249 N-S2, doc 20 §5.3) — Completion's bounded read of its own
 * sale number: no call with the flag off, 250 ms for 2 s then 1 s up to 15 s,
 * stop on `ok`, on a refusal, at the bound and on unmount, and never show a
 * result that belongs to another payment.
 */

import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SalesReadForHandoffRequest,
  SalesReadForHandoffResponse,
  SaleSummary,
} from '../../../../shared/bridge-api.js';
import {
  POLL_BOUND_MS,
  useSettledSaleNumber,
  type UseSettledSaleNumberArgs,
} from '../useSettledSaleNumber.js';

const PENDING: SalesReadForHandoffResponse = { kind: 'pending' };

function okResponse(exact: string, short: string | null): SalesReadForHandoffResponse {
  return { kind: 'ok', sale: { sale_number: exact } as SaleSummary, short_number: short };
}

type Read = (req: SalesReadForHandoffRequest) => Promise<SalesReadForHandoffResponse>;

function args(read: Read | null, over: Partial<UseSettledSaleNumberArgs> = {}) {
  return {
    enabled: true,
    read,
    handoffActionId: 'hid-1',
    paymentAttemptId: 'pa-1',
    ...over,
  } satisfies UseSettledSaleNumberArgs;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RT-1322 useSettledSaleNumber — when it asks', () => {
  it('makes no call with the flag off, and stays idle', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const { result } = renderHook(() => useSettledSaleNumber(args(read, { enabled: false })));
    await advance(POLL_BOUND_MS + 5_000);
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toEqual({ status: 'idle' });
  });

  it.each([
    ['no handoff id', { handoffActionId: null }],
    ['no attempt id', { paymentAttemptId: null }],
  ])('makes no call with %s', async (_n, over) => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const { result } = renderHook(() => useSettledSaleNumber(args(read, over)));
    await advance(POLL_BOUND_MS);
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toEqual({ status: 'idle' });
  });

  it('stays idle, with no claim and no neutral line, when the bridge has no readForHandoff', async () => {
    const { result } = renderHook(() => useSettledSaleNumber(args(null)));
    await advance(POLL_BOUND_MS);
    expect(result.current).toEqual({ status: 'idle' });
  });

  it('sends exactly the two key ids and nothing else', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    renderHook(() => useSettledSaleNumber(args(read)));
    await advance(0);
    expect(read).toHaveBeenCalledWith({ handoff_action_id: 'hid-1', payment_attempt_id: 'pa-1' });
    expect(Object.keys(read.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'handoff_action_id',
      'payment_attempt_id',
    ]);
  });
});

describe('RT-1322 useSettledSaleNumber — pending, ok and the bound', () => {
  it('shows pending (no number, no claim) and then the number on ok, and stops', async () => {
    const read = vi
      .fn<Read>()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValue(okResponse('TERM-01-2026-10-16-000047', '47'));
    const { result } = renderHook(() => useSettledSaleNumber(args(read)));

    await advance(0);
    expect(result.current).toEqual({ status: 'pending' });
    await advance(250);
    expect(result.current).toEqual({ status: 'pending' });
    await advance(250);
    expect(result.current).toEqual({
      status: 'ok',
      saleNumber: { short: '47', exact: 'TERM-01-2026-10-16-000047' },
    });
    expect(read).toHaveBeenCalledTimes(3);

    await advance(POLL_BOUND_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps a null short form for the caller to show the exact number only', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(okResponse('FREE-TEXT', null)));
    const { result } = renderHook(() => useSettledSaleNumber(args(read)));
    await advance(0);
    expect(result.current).toEqual({
      status: 'ok',
      saleNumber: { short: null, exact: 'FREE-TEXT' },
    });
  });

  it('asks every 250 ms for 2 s, then every 1 s, and gives up at 15 s', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const { result } = renderHook(() => useSettledSaleNumber(args(read)));

    await advance(0);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(1_750); // t = 1.75 s: reads at 0, 250 … 1750
    expect(read).toHaveBeenCalledTimes(8);
    await advance(249); // t = 1.999 s: the 2 s read has not happened
    expect(read).toHaveBeenCalledTimes(8);
    await advance(1); // t = 2 s
    expect(read).toHaveBeenCalledTimes(9);
    await advance(999); // t = 2.999 s
    expect(read).toHaveBeenCalledTimes(9);
    await advance(1); // t = 3 s: now one second apart
    expect(read).toHaveBeenCalledTimes(10);

    await advance(POLL_BOUND_MS - 3_000 - 1); // t = 14.999 s
    expect(result.current).toEqual({ status: 'pending' });
    const callsBeforeBound = read.mock.calls.length;
    await advance(1); // t = 15 s
    expect(result.current).toEqual({ status: 'unavailable' });

    await advance(30_000);
    expect(read).toHaveBeenCalledTimes(callsBeforeBound);
  });

  it('reaches the bound even when a read never answers', async () => {
    const read = vi.fn<Read>(() => new Promise<SalesReadForHandoffResponse>(() => undefined));
    const { result } = renderHook(() => useSettledSaleNumber(args(read)));
    await advance(POLL_BOUND_MS - 1);
    expect(result.current).toEqual({ status: 'pending' });
    await advance(1);
    expect(result.current).toEqual({ status: 'unavailable' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sale_not_found', 'sale_not_found'],
    ['no_session', 'no_session'],
    ['role_denied', 'role_denied'],
    ['invalid_input', 'invalid_input'],
    ['forbidden_field_in_request', 'forbidden_field_in_request'],
  ] as const)('stops at once on a %s refusal', async (_n, reason) => {
    const read = vi.fn<Read>(() => Promise.resolve({ kind: 'refused', reason }));
    const { result } = renderHook(() => useSettledSaleNumber(args(read)));
    await advance(0);
    expect(result.current).toEqual({ status: 'unavailable' });
    await advance(POLL_BOUND_MS);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops at once when the read fails', async () => {
    const read = vi.fn<Read>(() => Promise.reject(new Error('ipc down')));
    const { result } = renderHook(() => useSettledSaleNumber(args(read)));
    await advance(0);
    expect(result.current).toEqual({ status: 'unavailable' });
    await advance(POLL_BOUND_MS);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('RT-1322 useSettledSaleNumber — unmount and another payment', () => {
  it('stops polling on unmount', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const { unmount } = renderHook(() => useSettledSaleNumber(args(read)));
    await advance(500);
    const calls = read.mock.calls.length;
    unmount();
    await advance(POLL_BOUND_MS * 2);
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it('ignores an answer that arrives after unmount', async () => {
    let resolve: (r: SalesReadForHandoffResponse) => void = () => undefined;
    const read = vi.fn<Read>(
      () =>
        new Promise<SalesReadForHandoffResponse>((r) => {
          resolve = r;
        }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useSettledSaleNumber(args(read)));
    await advance(0);
    unmount();
    await act(async () => {
      resolve(okResponse('X', '1'));
      await Promise.resolve();
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not keep polling for the same payment when the bridge object is rebuilt', async () => {
    const read = vi.fn<Read>(() => Promise.resolve(PENDING));
    const readFn: Read = (req) => read(req);
    const { rerender } = renderHook(({ fn }: { fn: Read }) => useSettledSaleNumber(args(fn)), {
      initialProps: { fn: readFn },
    });
    await advance(0);
    rerender({ fn: (req) => read(req) }); // a new function each render, as in production
    rerender({ fn: (req) => read(req) });
    await advance(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('never shows the number of an earlier payment for a new attempt', async () => {
    const read = vi.fn<Read>((req) =>
      Promise.resolve(
        req.payment_attempt_id === 'pa-1' ? okResponse('FIRST-000001', '1') : PENDING,
      ),
    );
    const { result, rerender } = renderHook(
      ({ attempt }: { attempt: string }) =>
        useSettledSaleNumber(args(read, { paymentAttemptId: attempt })),
      { initialProps: { attempt: 'pa-1' } },
    );
    await advance(0);
    expect(result.current).toMatchObject({ status: 'ok' });

    rerender({ attempt: 'pa-2' });
    expect(result.current).toEqual({ status: 'pending' });
    await advance(0);
    expect(result.current).toEqual({ status: 'pending' });
  });
});
