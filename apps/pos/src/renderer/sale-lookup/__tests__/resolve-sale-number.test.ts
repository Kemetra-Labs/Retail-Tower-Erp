/**
 * RT-1192 (RT-249 N-S3, doc 20 §4) — what the number field does with what was
 * typed: a full number goes through unchanged, a short form is resolved against
 * today's list, and it never picks one of several.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveSaleNumber } from '../resolve-sale-number';
import { FULL_NUMBER, fakeRecentBridge, recentRow } from './recent-fixtures';

describe('resolveSaleNumber', () => {
  it('says empty for blank input without calling the bridge', async () => {
    const bridge = fakeRecentBridge();
    expect(await resolveSaleNumber(bridge, '   ')).toEqual({ kind: 'empty' });
    expect(bridge.listRecent).not.toHaveBeenCalled();
  });

  it('passes a full number through unchanged and never asks for the list', async () => {
    const bridge = fakeRecentBridge();
    expect(await resolveSaleNumber(bridge, FULL_NUMBER)).toEqual({
      kind: 'exact',
      saleNumber: FULL_NUMBER,
    });
    expect(bridge.listRecent).not.toHaveBeenCalled();
  });

  it('turns Arabic-Indic digits in a full number into Western digits', async () => {
    const bridge = fakeRecentBridge();
    expect(await resolveSaleNumber(bridge, 'T1-٢٠٢٦-١١-٠٥-٠٠٠٠٤٧')).toEqual({
      kind: 'exact',
      saleNumber: FULL_NUMBER,
    });
  });

  it('resolves a short form to the one exact number, asking only for that short form', async () => {
    const bridge = fakeRecentBridge([
      recentRow(),
      recentRow({ sale_number: 'T1-x', short_number: '48' }),
    ]);
    expect(await resolveSaleNumber(bridge, '47')).toEqual({ kind: 'one', saleNumber: FULL_NUMBER });
    expect(bridge.listRecent.mock.calls).toEqual([[{ short_number: '47' }]]);
  });

  it('reads Arabic-Indic digits and drops leading zeros in a short form', async () => {
    const bridge = fakeRecentBridge();
    expect(await resolveSaleNumber(bridge, '٠٠٤٧')).toEqual({
      kind: 'one',
      saleNumber: FULL_NUMBER,
    });
    expect(bridge.listRecent.mock.calls).toEqual([[{ short_number: '47' }]]);
  });

  it('returns every candidate when several sales share the short form (never picks)', async () => {
    const a = recentRow();
    const b = recentRow({ sale_id: 'sale-47b', sale_number: 'T1-2026-11-04-000047' });
    expect(await resolveSaleNumber(fakeRecentBridge([a, b]), '47')).toEqual({
      kind: 'many',
      candidates: [a, b],
    });
  });

  it('says none when nothing matches today', async () => {
    expect(await resolveSaleNumber(fakeRecentBridge([recentRow()]), '999')).toEqual({
      kind: 'none',
    });
  });

  it('fails when the list is refused, rejected or has no bridge (never a wrong sale)', async () => {
    const refused = {
      listRecent: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'no_session' as const }),
      ),
    };
    const rejected = { listRecent: vi.fn(() => Promise.reject(new Error('ipc'))) };
    expect(await resolveSaleNumber(refused, '47')).toEqual({ kind: 'failed' });
    expect(await resolveSaleNumber(rejected, '47')).toEqual({ kind: 'failed' });
    expect(await resolveSaleNumber(null, '47')).toEqual({ kind: 'failed' });
  });
});
