/**
 * RT-1553 — automatic detection of a late commit: a return the till CLOSED as "not recorded" that the
 * server later records (finding F-1 of the RT-1498 close slice; the RT-1196 / RT-1548 contract).
 *
 * Two triggers, each a status read of a closed return (`ClosedReturnChecker.checkClosed`, the close
 * service's own read, single-flight per return):
 *
 *   • `sweep` (the background resolver pass): ONE read of each closed return of the scope once a quiet
 *     period (15 minutes, wall clock) has passed since its close. A return is read again only while
 *     the read gives no verdict (offline, unavailable, unreadable); once a verdict is in it is done for
 *     this process. The done set is in memory, so a restart reads each closed return once more (a read
 *     is harmless: it pays nothing and writes at most the one support raise).
 *   • `checkSale` (a new return or void of the same sale is being quoted): a read of each closed return
 *     of that sale, at once. It answers whether the sale is blocked again.
 *
 * A recorded verdict raises the one `needs_support` that migration 0071 allows after a close (inside
 * `checkClosed`). That blocks the sale again (`hasUnresolvedForSale`, the void's `LIVE_RETURN_SQL`).
 * Nothing is paid: the closed journal row is frozen, so it can never be confirmed.
 *
 * Fail-open on no verdict: an inconclusive read neither blocks nor frees anything. A new return is
 * still bounded server-side (`returnedQuantity`, a 409 on over-return, RT-1548 BR-7). A read that
 * throws (a local write failed) is logged and counts as no verdict: a quote or a resolver pass never
 * fails because of the detection.
 */
import type { AuthSnapshot } from './returns-auth.js';
import type { ClosedCheck, ClosedReturnChecker } from './returns-close-service.js';
import type { ReturnDispositionsRepository } from './returns-dispositions-repository.js';
import { RETURN_QUIET_PERIOD_MS } from './returns-quiet-period.js';
import type { JournalEntry, ReturnsRepository } from './returns-repository.js';

export interface LateCommitDetector {
  /** The background read of each closed return a quiet period after its close (see the header). */
  sweep(snapshot: AuthSnapshot): Promise<void>;
  /** Read each closed return of `saleId`; true when one of them is now a late commit (sale blocked). */
  checkSale(snapshot: AuthSnapshot, saleId: string): Promise<boolean>;
}

interface LateCommitDetectorDeps {
  readonly repo: Pick<ReturnsRepository, 'listClosed'>;
  readonly dispositions: Pick<ReturnDispositionsRepository, 'listFor'>;
  readonly checker: ClosedReturnChecker;
  /** The domain clock (ISO-8601 UTC). */
  readonly now: () => string;
  /** True once the return domain is stopping: no read starts after it. */
  readonly isStopped: () => boolean;
  /** How long after a close the sweep reads it (default: the 15-minute quiet period). */
  readonly quietMs?: number;
  readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
}

/** A verdict was reached: the sweep is done with this return. */
const isVerdict = (check: ClosedCheck): boolean => check === 'late_commit' || check === 'clear';

export function createLateCommitDetector(deps: LateCommitDetectorDeps): LateCommitDetector {
  const quietMs = deps.quietMs ?? RETURN_QUIET_PERIOD_MS;
  /** Closed returns the sweep has a verdict on (this process). */
  const done = new Set<string>();

  /** One read; a throw is logged and is no verdict (the detection never fails its caller). */
  async function check(snapshot: AuthSnapshot, entry: JournalEntry): Promise<ClosedCheck> {
    try {
      return await deps.checker.checkClosed(snapshot, entry);
    } catch (err: unknown) {
      deps.logger.error({ err, return_id: entry.returnId }, 'returns:late_commit_read_failed');
      return 'no_verdict';
    }
  }

  /** When the return was closed (ms), or null when it cannot be read. */
  function closedAtMs(returnId: string): number | null {
    const close = deps.dispositions.listFor(returnId).find((d) => d.kind === 'not_recorded_closed');
    if (close === undefined) return null;
    const ms = Date.parse(close.createdAt);
    return Number.isNaN(ms) ? null : ms;
  }

  /** Due for the sweep: not done, and the quiet period since its close has passed. */
  function isDue(entry: JournalEntry, nowMs: number): boolean {
    if (done.has(entry.returnId)) return false;
    const closedAt = closedAtMs(entry.returnId);
    // An unreadable close time is due (fail towards detection; a read pays nothing).
    return closedAt === null || nowMs - closedAt >= quietMs;
  }

  return {
    async sweep(snapshot) {
      if (deps.isStopped()) return;
      const nowMs = Date.parse(deps.now());
      const due = deps.repo.listClosed(snapshot.scope).filter((e) => isDue(e, nowMs));
      for (const entry of due) {
        if (deps.isStopped()) return;
        if (isVerdict(await check(snapshot, entry))) done.add(entry.returnId);
      }
    },

    async checkSale(snapshot, saleId) {
      if (deps.isStopped()) return false;
      let late = false;
      for (const entry of deps.repo.listClosed(snapshot.scope, saleId)) {
        if (deps.isStopped()) return late;
        if ((await check(snapshot, entry)) === 'late_commit') late = true;
      }
      return late;
    },
  };
}
