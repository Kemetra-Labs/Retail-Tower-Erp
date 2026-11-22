import { describe, expect, it } from 'vitest';

import {
  LOCAL_RETURN_REFUSALS,
  RETURN_DRAWER_FAILURES,
  RETURN_STATES,
  RETURN_UNKNOWN_CAUSES,
  SERVER_RETURN_REFUSALS,
} from '../../../shared/returns/types.js';
import {
  DISPOSITION_COPY,
  ESCALATE_COPY,
  OUTCOME_COPY,
  PAYOUT_COPY,
  UNRESOLVED_COPY,
  drawerFailureMessage,
  escalateApprovalMessage,
  refusalMessage,
  stateLabel,
} from '../returns-messages.js';

/**
 * RT-15 S3 — O1 (AC10): every refusal the bridge can answer has its own
 * message, and no two read alike. The reason lists come from the shared S2
 * tuples, so a reason added in main without copy here fails this test.
 */
const ALL_REASONS = [...SERVER_RETURN_REFUSALS, ...LOCAL_RETURN_REFUSALS];

describe('returns refusal copy (O1)', () => {
  it('covers all 43 reasons (24 from S2/S3, 12 from S4 payout, 2 from RT-196 S1, 2 from RT-1339 offers, 3 from RT-1498 S4/S5) with a non-empty Arabic message', () => {
    expect(ALL_REASONS).toHaveLength(43);
    for (const reason of ALL_REASONS) {
      const message = refusalMessage(reason);
      expect(message.trim().length, reason).toBeGreaterThan(0);
      expect(message, reason).toMatch(/[؀-ۿ]/);
    }
  });

  it('gives every reason a distinct message, distinct from every outcome message', () => {
    const messages = [...ALL_REASONS.map(refusalMessage), ...Object.values(OUTCOME_COPY)];
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('RT-198: shutting_down says the app is closing and never that nothing was done', () => {
    // Work in flight at stop (a resolve pass, a drawer kick) may already have
    // happened: the copy sends the operator to the history, not to "nothing".
    const message = refusalMessage('shutting_down');
    expect(message).toContain('يُغلق');
    expect(message).toContain('سجل المرتجعات');
    expect(message).not.toContain('لم يُنفَّذ');
  });

  it('falls back to a generic message for a reason main has not taught the renderer', () => {
    const unknown = refusalMessage('brand_new_reason' as never);
    expect(unknown.length).toBeGreaterThan(0);
    expect(ALL_REASONS.map(refusalMessage)).not.toContain(unknown);
  });
});

describe('journal state labels (H1)', () => {
  it('labels each of the 5 journal states distinctly', () => {
    const labels = RETURN_STATES.map(stateLabel);
    expect(new Set(labels).size).toBe(5);
    for (const label of labels) expect(label).toMatch(/[؀-ۿ]/);
  });
});

describe('unresolved-return copy (RT-1498, PROPOSED copy pending owner review)', () => {
  it('words every closed cause code, distinctly, in Arabic, with no em dash', () => {
    const lines = RETURN_UNKNOWN_CAUSES.map((cause) => UNRESOLVED_COPY.cause(cause));
    expect(new Set(lines).size).toBe(RETURN_UNKNOWN_CAUSES.length);
    for (const line of lines) {
      expect(line).toMatch(/[؀-ۿ]/);
      expect(line).not.toContain('—');
    }
  });

  it('never reuses a refusal, outcome or payout line, and never says declined', () => {
    const own = [
      ...RETURN_UNKNOWN_CAUSES.map((cause) => UNRESOLVED_COPY.cause(cause)),
      UNRESOLVED_COPY.doNotPay,
      UNRESOLVED_COPY.neverSent,
      UNRESOLVED_COPY.resend,
    ];
    const others = new Set([
      ...ALL_REASONS.map(refusalMessage),
      ...Object.values(OUTCOME_COPY),
      ...Object.values(PAYOUT_COPY),
    ]);
    expect(own.filter((line) => others.has(line))).toEqual([]);
    expect(own.filter((line) => line.includes('مرفوض'))).toEqual([]);
  });

  it('keeps telling the operator not to pay while the return is unresolved', () => {
    expect(UNRESOLVED_COPY.doNotPay).toContain('لا تصرف أي نقد');
  });

  it('falls back to no wording for a cause main has not taught the renderer', () => {
    expect(UNRESOLVED_COPY.cause('brand_new_cause' as never)).toBe('');
  });
});

describe('drawer failure and payout copy (RT-15 S4)', () => {
  it('says why the drawer did not open, one distinct Arabic line per reason', () => {
    const lines = RETURN_DRAWER_FAILURES.map(drawerFailureMessage);
    expect(new Set(lines).size).toBe(RETURN_DRAWER_FAILURES.length);
    for (const line of lines) expect(line).toMatch(/[؀-ۿ]/);
  });

  it('falls back to a generic line for a drawer reason the renderer does not know', () => {
    expect(drawerFailureMessage('melted' as never)).toBe(OUTCOME_COPY.unknownReason);
  });

  it('never reuses a refusal line as payout copy, and uses no em dash', () => {
    const payout = Object.values(PAYOUT_COPY);
    const refusals = new Set(ALL_REASONS.map(refusalMessage));
    expect(payout.filter((line) => refusals.has(line))).toEqual([]);
    expect(payout.filter((line) => line.includes('—'))).toEqual([]);
  });
});

describe('escalation and disposition copy (RT-1498 S4/S5, PROPOSED pending owner review)', () => {
  const own = [
    ESCALATE_COPY.action,
    ESCALATE_COPY.title,
    ESCALATE_COPY.body,
    ESCALATE_COPY.approve,
    ESCALATE_COPY.raised,
    ESCALATE_COPY.approvalUnavailable,
    DISPOSITION_COPY.label.needs_support,
    DISPOSITION_COPY.label.closed,
    DISPOSITION_COPY.supportDetail,
    DISPOSITION_COPY.closedDetail,
  ];

  it('is Arabic, distinct from itself and from every refusal, outcome, payout and unresolved line', () => {
    expect(new Set(own).size).toBe(own.length);
    for (const line of own) expect(line).toMatch(/[؀-ۿ]/);
    const others = new Set([
      ...ALL_REASONS.map(refusalMessage),
      ...Object.values(OUTCOME_COPY),
      ...Object.values(PAYOUT_COPY),
      UNRESOLVED_COPY.doNotPay,
      UNRESOLVED_COPY.neverSent,
      UNRESOLVED_COPY.resend,
    ]);
    expect(own.filter((line) => others.has(line))).toEqual([]);
  });

  it('never says a return handed to support was declined, and tells nobody to pay', () => {
    expect(own.filter((line) => line.includes('مرفوض'))).toEqual([]);
    expect(ESCALATE_COPY.body).toContain('لم يُصرف أي نقد');
  });

  it('keeps the three approval refusals as their own lines', () => {
    for (const reason of ['never_sent', 'approval_invalid', 'approval_stale'] as const) {
      expect(refusalMessage(reason)).not.toBe(OUTCOME_COPY.unknownReason);
    }
  });

  it('maps a refused approval to the four-eyes line, the return lines, or the fallback', () => {
    const fallback = (reason: string): string => `fallback:${reason}`;
    expect(escalateApprovalMessage('approval_unavailable', fallback)).toBe(
      ESCALATE_COPY.approvalUnavailable,
    );
    expect(escalateApprovalMessage('approval_invalid', fallback)).toBe(
      refusalMessage('approval_invalid'),
    );
    expect(escalateApprovalMessage('approval_stale', fallback)).toBe(
      refusalMessage('approval_stale'),
    );
    expect(escalateApprovalMessage('session_locked', fallback)).toBe('fallback:session_locked');
  });
});
