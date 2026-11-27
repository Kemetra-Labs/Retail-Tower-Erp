/**
 * RT-1498 S7 (RT-196 §3.8, OD-196-7) — how many of this terminal's returns are still unresolved when
 * its shift closes, and how many of those wait for support. The close is never blocked by them ("warn,
 * don't block"): an unresolved return never paid out, so Expected Cash does not include it.
 *
 * Unresolved = `pending` or `unknown`, and not freed by a close (`releasedByCloseSql`: a close that a
 * late commit re-blocked counts again, RT-1553). Awaiting support = the unresolved ones with a
 * `needs_support` disposition. Read only; counts, never ids or amounts.
 */
import type { UnresolvedReturnCounts } from '../../shared/shift-cashup/types.js';
import type { DatabaseHandle } from '../db/client.js';
import { releasedByCloseSql } from './returns-dispositions-repository.js';

interface UnresolvedReturnCounter {
  count(terminalId: string): UnresolvedReturnCounts;
}

interface Stmt {
  all(...params: unknown[]): unknown[];
}

interface CountRow {
  unresolved: number | null;
  awaiting: number | null;
}

const COUNT_SQL = `
  SELECT COUNT(*) AS unresolved,
         SUM(CASE WHEN EXISTS (
               SELECT 1 FROM return_journal_dispositions d
                WHERE d.return_id = return_journal.return_id AND d.kind = 'needs_support')
             THEN 1 ELSE 0 END) AS awaiting
    FROM return_journal
   WHERE terminal_id = ?
     AND state IN ('pending', 'unknown')
     AND NOT ${releasedByCloseSql('return_journal')}`;

/**
 * The counts for the terminal paired NOW (the one whose shift is closing). An unpaired till has no
 * returns of its own to warn about.
 */
export function unresolvedReturnsAtClose(
  db: DatabaseHandle,
  currentTerminalId: () => string | null,
): () => UnresolvedReturnCounts {
  const counter = createUnresolvedReturnCounter(db);
  return () => {
    const terminalId = currentTerminalId();
    return terminalId === null ? { unresolved: 0, awaitingSupport: 0 } : counter.count(terminalId);
  };
}

export function createUnresolvedReturnCounter(db: DatabaseHandle): UnresolvedReturnCounter {
  return {
    count(terminalId) {
      const [row] = (db.prepare(COUNT_SQL) as Stmt).all(terminalId) as CountRow[];
      return { unresolved: row?.unresolved ?? 0, awaitingSupport: row?.awaiting ?? 0 };
    },
  };
}
