import { useCallback, useState } from 'react';

import type { ReturnsBridgeAPI, ReturnsResendResponse } from '../../shared/returns/types.js';
import { attempt, CALL_FAILED, useSingleFlight } from './returns-bridge.js';
import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';

/**
 * RT-1498 — the per-row resend of an unresolved return, from the journal.
 * Single-flight across the whole list: one resend at a time (the main
 * dispatcher is single-flight per return, and the operator reads one result).
 * The renderer sends only the return id and shows what main answered; it never
 * decides that a return was recorded.
 */
interface ResendResult {
  /** `success` only for a confirmation main reported; everything else is `danger`. */
  readonly tone: 'success' | 'danger';
  readonly text: string;
}

export interface HistoryResend {
  readonly run: (returnId: string) => Promise<void>;
  /** The return being resent now, if any. */
  readonly sending: string | null;
  /** The last resend's result, for the notice above the list. */
  readonly result: ResendResult | null;
}

/** One answer (or a rejected call) as its own closed result. */
function resendResult(res: ReturnsResendResponse | typeof CALL_FAILED): ResendResult {
  if (res === CALL_FAILED) return { tone: 'danger', text: OUTCOME_COPY.submitFailed };
  switch (res.kind) {
    case 'confirmed':
      return {
        tone: 'success',
        text: res.replayed ? OUTCOME_COPY.replayed : OUTCOME_COPY.confirmed,
      };
    case 'unconfirmed':
      return { tone: 'danger', text: OUTCOME_COPY.stillUnconfirmed };
    case 'refused':
      return { tone: 'danger', text: refusalMessage(res.reason) };
  }
}

export function useHistoryResend(
  bridge: ReturnsBridgeAPI,
  reload: () => Promise<unknown>,
): HistoryResend {
  const { run: once } = useSingleFlight<'resend'>();
  const [sending, setSending] = useState<string | null>(null);
  const [result, setResult] = useState<ResendResult | null>(null);

  const run = useCallback(
    (returnId: string) =>
      once('resend', async () => {
        setSending(returnId);
        setResult(null);
        try {
          const res = await attempt(() => bridge.resend({ returnId }));
          setResult(resendResult(res));
          // The journal is the truth after any answer, including a lost one.
          await reload();
        } finally {
          setSending(null);
        }
      }),
    [bridge, once, reload],
  );

  return { run, sending, result };
}
