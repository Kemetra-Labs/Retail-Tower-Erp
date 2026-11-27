import { useCallback, useState } from 'react';

import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { attempt, CALL_FAILED, useSingleFlight } from './returns-bridge.js';
import { formatReturnTime } from './returns-format.js';
import { OUTCOME_COPY, statusReadMessage } from './returns-messages.js';

/**
 * RT-1498 close slice — «تحديث الحالة»: ask the SERVER whether one unresolved return was recorded, from the
 * journal. A read: it never sends the return and never confirms it. Single-flight across the whole list
 * (main refuses a second action on the same return while one runs). The renderer sends only the return id
 * and shows what main answered; it never decides a verdict, and the journal is re-read after any answer.
 *
 * `closeReady` is true only for a return whose LAST read answered an affirmative `not_recorded` with the
 * quiet period over, and only while the return's last attempt is still the one that read covered (a later
 * send makes it stale). It only decides whether to OFFER «إغلاق»: main re-reads and refuses on its own.
 */
interface StatusResult {
  /** The sale the answer is about (several rows can be unresolved at once). */
  readonly saleNumber: string;
  /** `danger` when the server's answer needs support; `warning` for no verdict; else `info`. */
  readonly tone: 'info' | 'warning' | 'danger';
  readonly text: string;
}

export interface HistoryStatus {
  readonly run: (row: ReturnJournalView) => Promise<void>;
  /** The return being read now, if any. */
  readonly reading: string | null;
  /** The last read's result, for the notice above the list. */
  readonly result: StatusResult | null;
  /** Did the last read of this return find it ready to close (and is that read still current)? */
  readonly closeReady: (row: ReturnJournalView) => boolean;
}

/** What the last read of one return covered: the return, and its last attempt as the read saw it. */
interface ReadyMark {
  readonly returnId: string;
  readonly lastAttemptAt: string | null;
}

function toneOf(res: Awaited<ReturnType<ReturnsBridgeAPI['readStatus']>>): StatusResult['tone'] {
  if (res.kind === 'recorded') {
    return res.outcome === 'resend' || res.outcome === 'confirmed' ? 'info' : 'danger';
  }
  if (res.kind === 'refused') return 'danger';
  return res.kind === 'inconclusive' ? 'warning' : 'info';
}

export function useHistoryStatus(
  bridge: ReturnsBridgeAPI,
  reload: () => Promise<unknown>,
): HistoryStatus {
  const { run: once } = useSingleFlight<'status'>();
  const [reading, setReading] = useState<string | null>(null);
  const [result, setResult] = useState<StatusResult | null>(null);
  const [ready, setReady] = useState<ReadyMark | null>(null);

  const run = useCallback(
    (row: ReturnJournalView) =>
      once('status', async () => {
        setReading(row.returnId);
        setResult(null);
        setReady(null);
        try {
          const res = await attempt(() => bridge.readStatus({ returnId: row.returnId }));
          if (res === CALL_FAILED) {
            setResult({
              saleNumber: row.saleNumber,
              tone: 'danger',
              text: OUTCOME_COPY.callFailed,
            });
          } else {
            setResult({
              saleNumber: row.saleNumber,
              tone: toneOf(res),
              text: statusReadMessage(res, formatReturnTime),
            });
            if (res.kind === 'not_recorded' && res.close.ready) {
              setReady({ returnId: row.returnId, lastAttemptAt: res.ret?.lastAttemptAt ?? null });
            }
          }
          // The journal is the truth after any answer, including a lost one.
          await reload();
        } finally {
          setReading(null);
        }
      }),
    [bridge, once, reload],
  );

  const closeReady = useCallback(
    (row: ReturnJournalView) =>
      ready !== null &&
      ready.returnId === row.returnId &&
      ready.lastAttemptAt !== null &&
      ready.lastAttemptAt === row.lastAttemptAt &&
      row.disposition !== 'closed',
    [ready],
  );

  return { run, reading, result, closeReady };
}
