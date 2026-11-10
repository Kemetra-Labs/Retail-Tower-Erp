/**
 * RT-1312 Phase 1 (owner decision P1-D1) — the wire of `posReportDeviceHeartbeat`
 * (`POST /api/pos/v1/terminals/heartbeat`, `pos-device-health.openapi.yaml`
 * 1.1.0-draft, vendored under `contracts/backend-core/`).
 *
 * Rules this module keeps:
 *   - A stored beat REPLACES every self-reported field (an omitted one is stored
 *     as unknown), so every beat names every field; an unknown value is `null`.
 *   - The body is closed and every field is bounded: a value off the contract
 *     (a version with build metadata, an unknown channel or state, a schema head
 *     that is not a migration name) is sent as `null`, never as is, because a 400
 *     stores nothing at all.
 *   - `sale_queue` is a key only an RT-1312 Backend-Core knows: it is sent only
 *     once a reply carried `pos_contract_revision` >= {@link SALE_QUEUE_MIN_REVISION}
 *     (an older one refuses the unknown key with a 400). Counts and one instant:
 *     never a sale id, number, amount or cashier.
 */
import type { PosDeviceHealth } from '../../shared/api-types.js';

type Schemas = PosDeviceHealth.components['schemas'];
export type DeviceHeartbeatReport = Schemas['DeviceHeartbeatReport'];
type UpdateChannel = Schemas['UpdateChannel'];
type UpdateState = Schemas['UpdateState'];

/** The first `pos_contract_revision` that accepts `sale_queue` (RT-1312). */
export const SALE_QUEUE_MIN_REVISION = 2;
/** `SaleQueueCount.maximum`, bounded like the Backend-Core DB CHECK. */
export const SALE_QUEUE_COUNT_MAX = 1_000_000;

const UPDATE_CHANNELS: readonly UpdateChannel[] = ['lab', 'canary', 'stable'];
const UPDATE_STATES: readonly UpdateState[] = [
  'idle',
  'checking',
  'downloading',
  'downloaded',
  'verify_failed',
  'verify_unavailable',
  'compat_blocked',
  'update_pending',
  'installing',
  'error',
];
/** `AppVersion`: a semantic version without build metadata, 5 to 32 characters. */
const APP_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** `SchemaHead`: a migration name, never a path or free text. */
const SCHEMA_HEAD = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The till's unsent sales, from the sale-sync state repo (RT-221 / RT-887 sets). */
export interface SaleQueueCounts {
  readonly pending: number;
  readonly deadLetter: number;
  readonly heldPreviousPairing: number;
  /** The outbox time of the oldest pending sale; null when none is pending. */
  readonly oldestPendingAt: string | null;
}

/** What the terminal knows at beat time; null = unknown. */
export interface HeartbeatFacts {
  readonly appVersion: string | null;
  readonly updateChannel: string | null;
  readonly updateState: string | null;
  readonly pendingVersion: string | null;
  readonly schemaHead: string | null;
  readonly sourceClockAt: Date;
  readonly saleQueue: SaleQueueCounts | null;
}

export interface HeartbeatBodyOptions {
  /** True only after a reply carried `pos_contract_revision` >= 2. */
  readonly includeSaleQueue: boolean;
}

function versionOrNull(value: string | null): string | null {
  if (value === null || value.length < 5 || value.length > 32) return null;
  return APP_VERSION.test(value) ? value : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return allowed.find((a) => a === value) ?? null;
}

function instantOrNull(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A count inside `SaleQueueCount` (an integer, 0 to 1 000 000). */
export function clampSaleQueueCount(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(SALE_QUEUE_COUNT_MAX, Math.max(0, Math.trunc(n)));
}

function saleQueueOf(counts: SaleQueueCounts | null): Schemas['SaleQueueReport'] | null {
  if (counts === null) return null;
  return {
    pending: clampSaleQueueCount(counts.pending),
    dead_letter: clampSaleQueueCount(counts.deadLetter),
    held_previous_pairing: clampSaleQueueCount(counts.heldPreviousPairing),
    oldest_pending_at: instantOrNull(counts.oldestPendingAt),
  };
}

/** Identifies what a beat reports about the queue, to tell when it changed. */
export function saleQueueKey(counts: SaleQueueCounts): string {
  return JSON.stringify(saleQueueOf(counts));
}

export function buildHeartbeatBody(
  facts: HeartbeatFacts,
  options: HeartbeatBodyOptions,
): DeviceHeartbeatReport {
  const schemaHead =
    facts.schemaHead !== null && SCHEMA_HEAD.test(facts.schemaHead) ? facts.schemaHead : null;
  const body: DeviceHeartbeatReport = {
    app_version: versionOrNull(facts.appVersion),
    update_channel: oneOf(facts.updateChannel, UPDATE_CHANNELS),
    update_state: oneOf(facts.updateState, UPDATE_STATES),
    pending_version: versionOrNull(facts.pendingVersion),
    schema_head: schemaHead,
    source_clock_at: facts.sourceClockAt.toISOString(),
  };
  return options.includeSaleQueue ? { ...body, sale_queue: saleQueueOf(facts.saleQueue) } : body;
}

/** The part of a `HeartbeatAck` the POS acts on. */
export interface HeartbeatAckFacts {
  readonly posContractRevision: number;
}

/** The revision of a 200 reply, or null when the reply is not a readable `HeartbeatAck`. */
export function parseHeartbeatAck(json: unknown): HeartbeatAckFacts | null {
  if (typeof json !== 'object' || json === null) return null;
  const revision = (json as Record<string, unknown>)['pos_contract_revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
  return { posContractRevision: revision };
}
