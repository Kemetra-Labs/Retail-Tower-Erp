/**
 * RT-1600 — the freshness gate of one store (RT-1599 FRESHNESS). Pure: the caller reads the store's devices (the
 * device-health port) and passes them here with the compute's clock.
 *
 * A store may not GIVE stock while its tills may still hold sales the server has not seen. Only ACTIVE devices count
 * (a revoked or retired till sells nothing, as in store deletion). The checks run in this order; the first that applies
 * to any active till wins:
 *   1. its queue is unknown: it never reported, or its last beat carried no queue counter -> `pos_queue_unknown`;
 *   2. it holds dead-letter or held sales                                                -> `pos_queue_dead_letter_or_held`;
 *   3. its last heartbeat is older than the threshold (pending sales behind a stale
 *      heartbeat are covered by this)                                                    -> `device_heartbeat_stale`.
 * A till that never reported is caught by 1 (no beat means no queue); 3 still treats a missing heartbeat as stale, so
 * the gate stays closed if the device port ever reports a queue without a beat. `nowMs` must be on the clock the
 * heartbeats were stamped with (the database's). A store with no active till has nothing unsynced and is eligible.
 */
import type { RedistributionStoreV1 } from './types';

/** The device facts the gate reads (the device-health port's shape, structurally). */
export interface FreshnessDeviceFact {
  readonly trustState: string;
  readonly lastSeenAt: Date | null;
  readonly queue: { readonly pending: number; readonly deadLetter: number; readonly held: number } | null;
}

export type SourceExclusion = NonNullable<RedistributionStoreV1['exclusion']>;

export function classifyStoreFreshness(
  devices: readonly FreshnessDeviceFact[],
  nowMs: number,
  staleAfterMs: number,
): Exclude<SourceExclusion, 'inactive'> | null {
  const active = devices.filter((d) => d.trustState === 'active');
  if (active.some((d) => d.queue === null)) return 'pos_queue_unknown';
  if (active.some((d) => d.queue !== null && (d.queue.deadLetter > 0 || d.queue.held > 0))) {
    return 'pos_queue_dead_letter_or_held';
  }
  const stale = (d: FreshnessDeviceFact): boolean => d.lastSeenAt === null || nowMs - d.lastSeenAt.getTime() > staleAfterMs;
  if (active.some(stale)) return 'device_heartbeat_stale';
  return null;
}
