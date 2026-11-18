/**
 * Store deletion facts and rules — RT-1439 (RT-1437 B2, `stores.openapi.yaml` 1.3.0-draft).
 *
 * ONE evaluator behind `previewStoreDeletion`, `consoleDeleteStore` and the legacy
 * `softDeleteStore`, so the preview states exactly what the write decides (the preview is
 * advisory; the write re-runs this in its own transaction). It reads, on the caller's
 * tenant-scoped client (RLS on), the facts a deletion would strand or change, derives the four
 * blockers (the contract's order) and a fingerprint of the previewed state.
 *
 * The blockers (D3, D4a; there is NO force past them):
 *   1. `store_has_open_shift`          a shift of the store is open;
 *   2. `store_has_unretired_device`    a device is not retired (active or revoked);
 *   3. `store_device_queue_unsynced`   a non-retired device has a non-zero or unknown sale queue
 *                                      (no heartbeat row, or a NULL counter, is unknown, never zero);
 *   4. `store_has_open_count_session`  a Count Session of the store is open.
 *
 * Server-received view only: a fact a till has not synced cannot be seen (preview caveats).
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { canonicalJson } from "../../common/hashing/canonical-json";
import { OPEN_COUNT_SESSION_STATES } from "../../inventory/count-sessions/count-sessions-setting.service";
import { countStoreOpenShifts, listStoreOpenShifts, readStoreOpenShifts } from "../../pos-shifts";

export const STORE_HAS_OPEN_SHIFT = "store_has_open_shift";
export const STORE_HAS_UNRETIRED_DEVICE = "store_has_unretired_device";
export const STORE_DEVICE_QUEUE_UNSYNCED = "store_device_queue_unsynced";
export const STORE_HAS_OPEN_COUNT_SESSION = "store_has_open_count_session";

export type StoreDeletionBlockerCode =
  | typeof STORE_HAS_OPEN_SHIFT
  | typeof STORE_HAS_UNRETIRED_DEVICE
  | typeof STORE_DEVICE_QUEUE_UNSYNCED
  | typeof STORE_HAS_OPEN_COUNT_SESSION;

export interface StoreDeletionBlocker {
  readonly code: StoreDeletionBlockerCode;
  readonly count: number;
}

/** What the 409 says for each blocker. Generic text: no id, name or count in the message. */
export const STORE_DELETION_BLOCKER_MESSAGES: Readonly<Record<StoreDeletionBlockerCode, string>> = {
  store_has_open_shift: "The store has an open shift.",
  store_has_unretired_device: "The store has a device that is not retired.",
  store_device_queue_unsynced: "A device of the store has unsynced sales or does not report its sale queue.",
  store_has_open_count_session: "The store has an open Count Session.",
};

export type DeviceTrustState = "active" | "revoked" | "retired";

export interface StoreDeletionQueue {
  readonly pending: number;
  readonly deadLetter: number;
  readonly held: number;
}

/**
 * What the guards decide on: exact counts from their own aggregate queries, with NO row limit.
 * The lists below are capped for the preview (the contract's `maxItems`), so a store with more
 * rows than a cap must never be judged from a list: a retired till is cheap to accumulate, and an
 * active or unsynced one past the cap would otherwise be deleted with no 409.
 */
export interface StoreDeletionCounts {
  readonly openShifts: number;
  readonly unretiredDevices: number;
  /** Non-retired devices with a non-zero or unknown (no heartbeat row, or a NULL counter) sale queue. */
  readonly unsyncedDevices: number;
  readonly openCountSessions: number;
  /** Every device of the store, retired included: the audit's `device_count`. */
  readonly totalDevices: number;
}

export interface StoreDeletionFacts {
  readonly counts: StoreDeletionCounts;
  readonly store: { readonly storeId: string; readonly code: string; readonly name: string; readonly isActive: boolean };
  readonly openShifts: ReadonlyArray<{
    readonly shiftId: string;
    readonly openedAt: Date;
    readonly terminalLabel: string | null;
    /** Null when the facts were read without eligibility (`withEligibility: false`, the write paths). */
    readonly forceCloseEligible: boolean | null;
  }>;
  readonly devices: ReadonlyArray<{
    readonly deviceId: string;
    readonly label: string | null;
    readonly trustState: DeviceTrustState;
    readonly lastSeenAt: Date | null;
    /** Null when the till never reported its queue (no health row, or a NULL counter). */
    readonly queue: StoreDeletionQueue | null;
  }>;
  readonly openCountSessions: ReadonlyArray<{ readonly sessionId: string; readonly status: string }>;
  readonly warehouseMappings: readonly string[];
  readonly singleStoreMembers: ReadonlyArray<{ readonly userId: string; readonly roleCode: string }>;
  readonly offersRebuiltCount: number;
}

/** The store as the facts carry it, from a store row. */
export function factsStoreOf(store: {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}): StoreDeletionFacts["store"] {
  return { storeId: store.id, code: store.code, name: store.name, isActive: store.isActive };
}

/** The contract's caps on each preview list (the schema `maxItems`). */
const MAX_SHIFTS = 200;
const MAX_DEVICES = 500;
const MAX_COUNT_SESSIONS = 200;
const MAX_WAREHOUSES = 50;
const MAX_MEMBERS = 500;

interface DeviceRow {
  id: string;
  label: string | null;
  revoked_at: Date | null;
  retired_at: Date | null;
  health_last_seen_at: Date | null;
  has_health: boolean;
  pending: number | null;
  dead_letter: number | null;
  held: number | null;
}

const DEVICES_SQL = `
  SELECT d.id, d.label, d.revoked_at, d.retired_at,
         h.last_seen_at AS health_last_seen_at,
         (h.device_id IS NOT NULL) AS has_health,
         h.sale_queue_pending AS pending,
         h.sale_queue_dead_letter AS dead_letter,
         h.sale_queue_held AS held
    FROM devices d
    LEFT JOIN device_health h ON h.device_id = d.id AND h.tenant_id = d.tenant_id
   WHERE d.store_id = $1
   ORDER BY d.id
   LIMIT $2`;

/**
 * $1 store, $2 the open Count Session states. One row; every count is exact. The open-shift count
 * comes from the pos-shifts port (`countStoreOpenShifts`), not from this statement.
 */
const COUNTS_SQL = `
  SELECT (SELECT count(*) FROM devices d WHERE d.store_id = $1)::int AS total_devices,
         (SELECT count(*) FROM devices d WHERE d.store_id = $1 AND d.retired_at IS NULL)::int AS unretired_devices,
         (SELECT count(*)
            FROM devices d
            LEFT JOIN device_health h ON h.device_id = d.id AND h.tenant_id = d.tenant_id
           WHERE d.store_id = $1 AND d.retired_at IS NULL
             AND (h.device_id IS NULL
                  OR h.sale_queue_pending IS NULL OR h.sale_queue_dead_letter IS NULL OR h.sale_queue_held IS NULL
                  OR h.sale_queue_pending + h.sale_queue_dead_letter + h.sale_queue_held > 0))::int AS unsynced_devices,
         (SELECT count(*) FROM count_sessions WHERE store_id = $1 AND state = ANY($2::text[]))::int AS open_count_sessions`;

function trustStateOf(row: DeviceRow): DeviceTrustState {
  if (row.retired_at !== null) return "retired";
  return row.revoked_at !== null ? "revoked" : "active";
}

function queueOf(row: DeviceRow): StoreDeletionQueue | null {
  if (!row.has_health || row.pending === null || row.dead_letter === null || row.held === null) return null;
  return { pending: row.pending, deadLetter: row.dead_letter, held: row.held };
}

export interface ReadStoreDeletionFactsOptions {
  /**
   * Judge each open shift's force-close eligibility (one stuck-verdict statement per shift). The preview
   * states it, so it defaults to true. The write paths pass false: they refuse on the exact counts and
   * fingerprint the shift ids only, so a verdict would be read under the store lock and discarded. The
   * guards, the counts and the fingerprint are the same either way; `forceCloseEligible` is null.
   */
  readonly withEligibility?: boolean;
}

/** Read every fact one store deletion decides on, in the caller's transaction. */
export async function readStoreDeletionFacts(
  client: PoolClient,
  store: StoreDeletionFacts["store"],
  tenantId: string,
  options: ReadStoreDeletionFactsOptions = {},
): Promise<StoreDeletionFacts> {
  const storeId = store.storeId;
  const counted = await client.query<{
    total_devices: number;
    unretired_devices: number;
    unsynced_devices: number;
    open_count_sessions: number;
  }>(COUNTS_SQL, [storeId, OPEN_COUNT_SESSION_STATES]);
  const c = counted.rows[0];
  const counts: StoreDeletionCounts = {
    openShifts: await countStoreOpenShifts(client, storeId),
    totalDevices: c?.total_devices ?? 0,
    unretiredDevices: c?.unretired_devices ?? 0,
    unsyncedDevices: c?.unsynced_devices ?? 0,
    openCountSessions: c?.open_count_sessions ?? 0,
  };
  // The open-shift list (and, for the preview, each shift's eligibility) come from the pos-shifts port:
  // the Console's own stuck verdict.
  const shiftScope = { tenantId, storeId };
  const shiftOptions = { limit: MAX_SHIFTS, order: "oldest_first" } as const;
  const shifts =
    options.withEligibility === false
      ? (await listStoreOpenShifts(client, shiftScope, shiftOptions)).map((r) => ({ ...r, forceCloseEligible: null }))
      : await readStoreOpenShifts(client, shiftScope, shiftOptions);
  const devices = await client.query<DeviceRow>(DEVICES_SQL, [storeId, MAX_DEVICES]);
  const sessions = await client.query<{ id: string; state: string }>(
    `SELECT id, state FROM count_sessions
      WHERE store_id = $1 AND state = ANY($2::text[]) ORDER BY id LIMIT $3`,
    [storeId, OPEN_COUNT_SESSION_STATES, MAX_COUNT_SESSIONS],
  );
  const warehouses = await client.query<{ ref: string }>(
    `SELECT erpnext_warehouse_ref AS ref FROM erpnext_warehouse_map
      WHERE store_id = $1 AND retired_at IS NULL ORDER BY id LIMIT $2`,
    [storeId, MAX_WAREHOUSES],
  );
  const members = await client.query<{ user_id: string; role_code: string }>(
    `SELECT m.user_id, r.code AS role_code
       FROM memberships m
       JOIN roles r ON r.id = m.role_id AND r.tenant_id = m.tenant_id
      WHERE m.deleted_at IS NULL
        AND m.store_access_kind = 'specific'
        AND EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $1)
        AND (SELECT count(*) FROM store_access sb
               JOIN stores sst ON sst.id = sb.store_id AND sst.tenant_id = sb.tenant_id
              WHERE sb.membership_id = m.id AND sst.deleted_at IS NULL) = 1
      ORDER BY m.user_id
      LIMIT $2`,
    [storeId, MAX_MEMBERS],
  );
  const offers = await client.query<{ n: number }>(
    `SELECT count(DISTINCT offer_id)::int AS n
       FROM offer_pack_eligible_products WHERE store_id = $1 AND to_revision IS NULL`,
    [storeId],
  );
  return {
    counts,
    store,
    openShifts: shifts.map((r) => ({
      shiftId: r.shift.shiftId,
      openedAt: r.shift.openedAt,
      terminalLabel: r.terminal.label,
      forceCloseEligible: r.forceCloseEligible,
    })),
    devices: devices.rows.map((r) => ({
      deviceId: r.id,
      label: r.label,
      trustState: trustStateOf(r),
      lastSeenAt: r.health_last_seen_at,
      queue: queueOf(r),
    })),
    openCountSessions: sessions.rows.map((r) => ({ sessionId: r.id, status: r.state })),
    warehouseMappings: warehouses.rows.map((r) => r.ref),
    singleStoreMembers: members.rows.map((r) => ({ userId: r.user_id, roleCode: r.role_code })),
    offersRebuiltCount: offers.rows[0]?.n ?? 0,
  };
}

/** The blockers that refuse the delete now, in the contract's order; empty means it may proceed. */
export function evaluateStoreDeletionBlockers(facts: StoreDeletionFacts): StoreDeletionBlocker[] {
  const c = facts.counts;
  const candidates: StoreDeletionBlocker[] = [
    { code: STORE_HAS_OPEN_SHIFT, count: c.openShifts },
    { code: STORE_HAS_UNRETIRED_DEVICE, count: c.unretiredDevices },
    { code: STORE_DEVICE_QUEUE_UNSYNCED, count: c.unsyncedDevices },
    { code: STORE_HAS_OPEN_COUNT_SESSION, count: c.openCountSessions },
  ];
  return candidates.filter((b) => b.count > 0);
}

/**
 * The opaque digest of the previewed state (SHA-256 hex): the store's name, code and active
 * flag, the open shifts (ids), every device (id, trust state, queue counters; NOT the
 * heartbeat time), the open Count Session ids and states, the warehouse mappings, the
 * single-store members and the tenant. It proves only that two reads saw the same state.
 */
export function storeDeletionFingerprint(tenantId: string, facts: StoreDeletionFacts): string {
  const state = {
    tenantId,
    counts: facts.counts,
    store: facts.store,
    openShifts: facts.openShifts.map((s) => ({ shiftId: s.shiftId, state: "open" })),
    devices: facts.devices.map((d) => ({ deviceId: d.deviceId, trustState: d.trustState, queue: d.queue })),
    openCountSessions: facts.openCountSessions,
    warehouseMappings: facts.warehouseMappings,
    singleStoreMembers: facts.singleStoreMembers,
  };
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}
