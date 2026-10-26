/**
 * RT-887 (RT-856 residual) — held discounted sales in the terminal-status
 * indicator and banners.
 *
 * `sync.held` is the subset of `pending` the drain holds while discount capture
 * is off (RT-856; nothing sends them until RT-858). They are not "sending" and
 * never need a human, so «sending», «waiting», the 24 h attention rule and the
 * attention count use `pending − held` only. Main already takes
 * `oldestPendingAt` from the non-held sales. The held count shows as its own
 * neutral row. With `held` absent or 0 the mapping is exactly as before.
 */
import { describe, expect, it } from 'vitest';
import type { TerminalStatusSnapshot } from '../../../shared/terminal-status/types';
import { STATUS_NOW as NOW, iso, snap } from './__helpers__/snapshot';
import {
  SYNC_ATTENTION_AGE_MS,
  mapStatusBanners,
  mapTerminalStatus,
  rowText,
  syncAttentionDueAt,
  type IndicatorRow,
} from '../status-mapping';
import { STATUS_COPY } from '../status-copy';

const HOUR = 60 * 60 * 1000;
const AGED = iso(NOW - SYNC_ATTENTION_AGE_MS - HOUR);

const describeRow = (row: IndicatorRow | null): string | null =>
  row === null ? null : `${row.tone} · ${rowText(row)}`;

describe('RT-887 held-only: no «sending», no attention', () => {
  it('online: no sync row, rule U6, a neutral held row', () => {
    const view = mapTerminalStatus(snap('online', { pending: 2, held: 2 }), NOW);
    expect(view.rule).toBe('U6');
    expect(view.sync).toBeNull();
    expect(describeRow(view.held)).toBe('neutral · إرسال عمليتين بخصم مؤجَّل');
  });

  it('never «sending» or «waiting» in any connection state', () => {
    for (const c of ['online', 'offline', 'degraded', 'checking'] as const) {
      const view = mapTerminalStatus(snap(c, { pending: 4, held: 4 }), NOW);
      expect(view.sync, c).toBeNull();
      expect(view.held?.tone, c).toBe('neutral');
    }
  });

  it('an aged held sale never raises attention, in the indicator or the banners', () => {
    // Even if a stale oldest time slipped through, nothing non-held is pending.
    const snapshot = snap('online', { pending: 1, held: 1, oldestPendingAt: AGED });
    const view = mapTerminalStatus(snapshot, NOW);
    expect(view.rule).toBe('U6');
    expect(view.sync).toBeNull();
    expect(mapStatusBanners(snapshot, NOW)).toEqual({ attention: null, offline: false });
    expect(syncAttentionDueAt(snapshot)).toBeNull();
  });

  it('as main sends it (no oldest age), no attention deadline is armed', () => {
    const snapshot = snap('online', { pending: 3, held: 3, oldestPendingAt: null });
    expect(syncAttentionDueAt(snapshot)).toBeNull();
    expect(mapStatusBanners(snapshot, NOW).attention).toBeNull();
  });

  it('a dead letter still decides attention; the held sales are not counted in it', () => {
    const snapshot = snap('online', { pending: 2, held: 2, deadLetter: 1 });
    const view = mapTerminalStatus(snapshot, NOW);
    expect(view.rule).toBe('U2');
    expect(describeRow(view.sync)).toBe('danger · تحتاج مراجعة');
    expect(describeRow(view.held)).toBe('neutral · إرسال عمليتين بخصم مؤجَّل');
    expect(mapStatusBanners(snapshot, NOW).attention).toBe(1);
  });

  it('offline: rule U3 and the held row stays visible', () => {
    const view = mapTerminalStatus(snap('offline', { pending: 1, held: 1 }), NOW);
    expect(view.rule).toBe('U3');
    expect(view.sync).toBeNull();
    expect(describeRow(view.held)).toBe('neutral · إرسال عملية واحدة بخصم مؤجَّل');
  });
});

describe('RT-887 mixed: only the non-held sales drive «sending» and attention', () => {
  it('«sending» counts the non-held sales only', () => {
    const view = mapTerminalStatus(
      snap('online', { pending: 5, held: 2, oldestPendingAt: iso(NOW - HOUR) }),
      NOW,
    );
    expect(view.rule).toBe('U4');
    expect(describeRow(view.sync)).toBe('info · جارٍ إرسال 3 عمليات…');
    expect(describeRow(view.held)).toBe('neutral · إرسال عمليتين بخصم مؤجَّل');
  });

  it('«waiting» counts the non-held sales only', () => {
    const view = mapTerminalStatus(
      snap('online', {
        pending: 4,
        held: 1,
        oldestPendingAt: iso(NOW - HOUR),
        paused: 'no_operator_credential',
      }),
      NOW,
    );
    expect(view.rule).toBe('U5');
    expect(describeRow(view.sync)).toBe('info · 3 عمليات بانتظار الإرسال');
  });

  it('an aged non-held sale raises attention; the banner counts the non-held sales only', () => {
    const snapshot = snap('online', { pending: 3, held: 1, oldestPendingAt: AGED });
    const view = mapTerminalStatus(snapshot, NOW);
    expect(view.rule).toBe('U2');
    expect(describeRow(view.sync)).toBe('danger · تحتاج مراجعة');
    expect(describeRow(view.held)).toBe('neutral · إرسال عملية واحدة بخصم مؤجَّل');
    expect(mapStatusBanners(snapshot, NOW).attention).toBe(2);
  });

  it('a young non-held sale beside held ones: no attention, deadline from the non-held age', () => {
    const oldest = NOW - HOUR;
    const snapshot = snap('online', { pending: 3, held: 2, oldestPendingAt: iso(oldest) });
    expect(mapStatusBanners(snapshot, NOW).attention).toBeNull();
    expect(syncAttentionDueAt(snapshot)).toBe(oldest + SYNC_ATTENTION_AGE_MS);
  });

  it('a held count above pending (a read race) is clamped: nothing non-held, held = pending', () => {
    const view = mapTerminalStatus(snap('online', { pending: 1, held: 3 }), NOW);
    expect(view.sync).toBeNull();
    expect(describeRow(view.held)).toBe('neutral · إرسال عملية واحدة بخصم مؤجَّل');
  });
});

describe('RT-887 none held: exactly as before', () => {
  const states: [string, TerminalStatusSnapshot][] = [
    ['online, nothing pending', snap('online')],
    ['online, pending', snap('online', { pending: 4, oldestPendingAt: iso(NOW - HOUR) })],
    ['online, aged', snap('online', { pending: 2, oldestPendingAt: AGED })],
    ['offline, pending', snap('offline', { pending: 3, oldestPendingAt: iso(NOW - HOUR) })],
    ['paused', snap('online', { pending: 2, paused: 'no_operator_credential' })],
    ['dead letter', snap('checking', { deadLetter: 2 })],
  ];

  it.each(states)('%s: held 0 maps like no held key, and shows no held row', (_l, base) => {
    const zero = { ...base, sync: { ...base.sync, held: 0 } };
    expect(mapTerminalStatus(zero, NOW)).toEqual(mapTerminalStatus(base, NOW));
    expect(mapStatusBanners(zero, NOW)).toEqual(mapStatusBanners(base, NOW));
    expect(syncAttentionDueAt(zero)).toEqual(syncAttentionDueAt(base));
    expect(mapTerminalStatus(base, NOW).held).toBeNull();
  });

  it('no snapshot: no held row', () => {
    expect(mapTerminalStatus(null, NOW).held).toBeNull();
  });
});

describe('RT-887 held copy', () => {
  it('is count-aware like the other sync rows, and never says «sending» or an error', () => {
    const forms = STATUS_COPY.heldDiscount;
    expect(forms.one).toBe('إرسال عملية واحدة بخصم مؤجَّل');
    expect(forms.two).toBe('إرسال عمليتين بخصم مؤجَّل');
    expect(forms.few).toBe('إرسال {n} عمليات بخصم مؤجَّل');
    expect(forms.many).toBe('إرسال {n} عملية بخصم مؤجَّل');
    const view = mapTerminalStatus(snap('online', { pending: 12, held: 12 }), NOW);
    expect(view.held).toEqual({
      tone: 'neutral',
      before: 'إرسال ',
      count: 12,
      after: ' عملية بخصم مؤجَّل',
    });
    expect(JSON.stringify(forms)).not.toMatch(/جارٍ|تعذّر|مراجعة/);
  });
});
