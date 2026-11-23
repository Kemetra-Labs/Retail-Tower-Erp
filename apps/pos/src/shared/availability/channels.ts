/**
 * RT-1578 (RT-1511 S3, spec 013) — the `availability:*` IPC channels, shared by the preload bridge and the
 * main-process handlers. Read-only and status-only: nothing here reserves or writes stock (FR-6).
 */
export const AVAILABILITY_IPC_CHANNELS = {
  /** Freshness of the cached store availability (never / fresh / stale and the stamp). */
  STATUS: 'availability:status',
  /** The display state of a bounded list of products, from the local cache only. */
  BANDS: 'availability:bands',
  /** A manual out-of-cycle pull (spec 013 FR-10). */
  REFRESH: 'availability:refresh',
} as const;
