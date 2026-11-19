/**
 * 010-pos-catalog-read-down-consumption T038 — `read-down-driver`.
 *
 * Orchestrates ONE read-down tick: fetch (injected `ReadDownClient`) → on `ok`,
 * hand the rows to the `ReadDownWriter` (validate → stage → promote, atomic); on
 * a transport failure, record a FAILED attempt WITHOUT touching the writer, so a
 * working catalogue is preserved and the freshness clock never advances on a
 * fetch that did not land (SC-5 / FR-7 at the fetch boundary).
 *
 * ASYNC SINGLE-FLIGHT (FR-12 / FR-14). The real-world background trigger is a
 * `setInterval` (Constitution VIII — paired-terminal background, NOT
 * session-gated), and the cashier-facing `catalogue:refresh` bridge needs a
 * synchronous admission so it can answer `started` / `already_running`
 * IMMEDIATELY without awaiting the read-down (contract Addition 1, "returns
 * immediately after kicking off the tick, not after the promote commits").
 *
 * So admission is split from completion:
 *   • `runTickOnce()` returns SYNCHRONOUSLY — `{ kind: 'started', completed }` for
 *     an admitted tick, or `{ kind: 'already_running' }` when one is in flight.
 *   • The read-down runs on the `completed` promise. The bridge maps on `kind`
 *     and ignores `completed`; the driver's own interval / tests await it.
 *
 * Session refusal is NOT the driver's concern — the background driver isn't
 * session-gated (Constitution VIII); the bridge applies `requireCatalogueSession`
 * (009 gate) before ever calling the driver.
 *
 * The CONCRETE HTTP client is injected (T021, blocked on #349) — the driver
 * depends only on the `ReadDownClient` interface. Scope (`tenantId`/`branchId`)
 * and the clock (`now`) are injected config (the real wiring reads them from
 * `pairingStore` at the composition root, T039); mirrors `finalize-listener`.
 */

/*
 * RT-1487: after the first successful snapshot a tick syncs by delta from the
 * stored cursor (`posGetCatalogDeltas`) and re-baselines with a full snapshot only
 * when the server or the writer asks for it. See `deltaTick`.
 */
import type { ReadDownClient } from './read-down-client-types.js';
import type {
  ReadDownWriter,
  ReadDownRunResult,
  ReadDownFailureCategory,
} from './read-down-writer.js';

const TICK_INTERVAL_MIN_MS = 1_000;
const TICK_INTERVAL_MAX_MS = 24 * 60 * 60 * 1_000; // 24h ceiling

/** The committed outcome of one tick (writer result, or a transport failure). */
export interface TickOutcome {
  outcome: ReadDownRunResult['outcome'];
  productsWritten: number;
  recordsRejected: number;
  /** `'transport'` when the fetch failed before the writer ran; else the writer's category. */
  // RT-1487: a `delta-rejected` apply is never returned here — the tick
  // re-baselines with a snapshot instead.
  failureCategory: ReadDownFailureCategory | 'transport' | null;
}

/** `runTickOnce` admits synchronously; the read-down completes on `completed`. */
export type TickAdmission =
  | { kind: 'started'; completed: Promise<TickOutcome> }
  | { kind: 'already_running' };

export interface CreateReadDownDriverDeps {
  client: ReadDownClient;
  writer: ReadDownWriter;
  /** Injected device-principal scope (from `pairingStore` at the composition root). */
  tenantId: string;
  branchId: string;
  /** Injected clock — one ISO-8601 UTC stamp per tick (determinism in tests). */
  now: () => string;
  /** Background interval in ms; bounded [1s, 24h]. */
  tickIntervalMs: number;
}

export interface ReadDownDriver {
  /** Admit one tick synchronously; the read-down resolves on `completed`. */
  runTickOnce(): TickAdmission;
  /**
   * Install the background interval driver AND admit one immediate initial tick
   * (RT-41). Idempotent while started: a repeat call returns the existing handle
   * without a second interval or a second initial tick. Returns the timer handle.
   */
  start(): NodeJS.Timeout;
  /** Stop the background driver (idempotent). */
  stop(): void;
}

export function createReadDownDriver(deps: CreateReadDownDriverDeps): ReadDownDriver {
  if (deps.tickIntervalMs < TICK_INTERVAL_MIN_MS || deps.tickIntervalMs > TICK_INTERVAL_MAX_MS) {
    throw new Error(
      `read-down-driver: tickIntervalMs must be between ${String(TICK_INTERVAL_MIN_MS)} and ${String(TICK_INTERVAL_MAX_MS)} (got ${String(deps.tickIntervalMs)})`,
    );
  }

  const { client, writer, tenantId, branchId, now } = deps;

  let inFlight = false;
  let intervalHandle: NodeJS.Timeout | null = null;

  /**
   * Transport failure: the writer must NOT run. Record a failed attempt so the
   * freshness surface can show "last attempt failed" while `last_success_at`
   * (and the stored cursor) stay put (SC-10). The writer owns its own
   * attempt-recording for writer-side failures; the driver owns this one.
   */
  function transportFailure(stamp: string): TickOutcome {
    writer.recordFetchFailure({ tenantId, branchId, now: stamp });
    return {
      outcome: 'failed',
      productsWritten: 0,
      recordsRejected: 0,
      failureCategory: 'transport',
    };
  }

  function toOutcome(result: ReadDownRunResult): TickOutcome {
    return {
      outcome: result.outcome,
      productsWritten: result.productsWritten,
      recordsRejected: result.recordsRejected,
      failureCategory: result.failureCategory,
    };
  }

  /** The full-snapshot path (first sync, and every re-baseline). */
  async function snapshotTick(stamp: string): Promise<TickOutcome> {
    const fetched = await client.fetchSnapshot();
    if (fetched.kind !== 'ok') return transportFailure(stamp);
    return toOutcome(
      writer.run({
        tenantId,
        branchId,
        sourceSnapshotId: fetched.sourceSnapshotId,
        now: stamp,
        rows: fetched.rows,
      }),
    );
  }

  /**
   * RT-1487 — the delta path. Returns the tick outcome, or `null` when the tick
   * must re-baseline with a full snapshot: the server answered
   * `snapshot_required` (cursor past its retained change log), the delta call
   * was reached but failed (e.g. a non-disclosing refusal of a foreign-scope
   * cursor), or an op was rejected. An unreachable backend or a refused device
   * credential is NOT retried with a snapshot: the prior catalogue stays
   * sellable offline and the next tick resumes from the same cursor.
   */
  async function deltaTick(
    fetchDeltas: NonNullable<ReadDownClient['fetchDeltas']>,
    cursor: string,
    stamp: string,
  ): Promise<TickOutcome | null> {
    const delta = await fetchDeltas(cursor);
    if (delta.kind === 'no_connection' || delta.kind === 'device_unauthorized') {
      return transportFailure(stamp);
    }
    if (delta.kind !== 'ok') return null;
    const applied = writer.applyDeltas({
      tenantId,
      branchId,
      cursor: delta.cursor,
      now: stamp,
      ops: delta.ops,
    });
    return applied.failureCategory === 'delta-rejected' ? null : toOutcome(applied);
  }

  /** The async body of one tick. Resolves to the committed outcome, never rejects. */
  async function runTick(): Promise<TickOutcome> {
    const stamp = now();
    try {
      // RT-1487: after a successful snapshot, sync by delta from the stored
      // cursor; with no cursor (first sync, or another store's) take a snapshot.
      const fetchDeltas = client.fetchDeltas?.bind(client);
      const cursor = fetchDeltas ? writer.currentCursor(tenantId, branchId) : null;
      if (fetchDeltas && cursor !== null) {
        const outcome = await deltaTick(fetchDeltas, cursor, stamp);
        if (outcome !== null) return outcome;
      }
      return await snapshotTick(stamp);
    } finally {
      inFlight = false;
    }
  }

  function runTickOnce(): TickAdmission {
    if (inFlight) return { kind: 'already_running' };
    inFlight = true;
    // runTick() flips inFlight back in its finally; admission is synchronous.
    return { kind: 'started', completed: runTick() };
  }

  function start(): NodeJS.Timeout {
    // Idempotent: an already-started driver neither installs a second interval
    // nor admits a second initial tick.
    if (intervalHandle !== null) return intervalHandle;
    intervalHandle = setInterval(() => {
      // Fire-and-forget: single-flight coalesces a tick still running from the
      // previous interval (returns already_running, no-op). A tick never rejects.
      runTickOnce();
    }, deps.tickIntervalMs);
    // RT-41 — one immediate, bounded initial tick so a freshly paired/restarted
    // terminal has a catalogue without waiting a full interval (or a manual
    // refresh). Admitted through the same single-flight gate as the interval and
    // the `catalogue:refresh` bridge, so it can never overlap another pull; a
    // transport failure is recorded like any other tick and retried by the next
    // interval tick or a manual refresh. Fire-and-forget: a tick never rejects.
    runTickOnce();
    return intervalHandle;
  }

  function stop(): void {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return { runTickOnce, start, stop };
}
