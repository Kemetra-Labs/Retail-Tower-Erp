/**
 * The recorded facts a Console force close states and fingerprints (RT-1445;
 * `console-force-actions.openapi.yaml`, "Preview, then confirm, then re-check").
 *
 * ONE read and ONE fingerprint function serve both the preview and the write,
 * so the digest the preview returns is the digest the write recomputes under
 * the shift lock (RT-1447 was the same class of bug: two readers of one
 * instant that drifted). Every instant that enters the digest is read from the
 * database as UTC text at microsecond precision, never through a JS `Date`
 * (millisecond precision), so two reads of the same state agree exactly.
 *
 * The digest covers exactly the facts the preview states as recorded: the
 * shift's lifecycle state and open time, its three eligibility predicates, the
 * cash movement count and last received time, the sale and refund counts, the
 * opening float and currency, the opening terminal's identity and trust state,
 * the shift id and the tenant. It never covers `evaluatedAt` or `ageMinutes`.
 * It is not a secret and carries no authority: every rule is checked again by
 * the write either way. Recorded counts only: never an expected-cash or
 * variance figure (Constitution §III).
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { canonicalJson } from "../common/hashing/canonical-json";
import { toStoreShift, type StoreShiftDbRow, type StoreShiftRow, type StuckVerdict } from "./shift-force-close.repository";

export type TerminalTrustState = "active" | "revoked" | "retired";

/** The recorded facts of one shift, as the preview states them. */
export interface ForceCloseFacts {
  /** The opening cashier's display name; null when the user has none (never an e-mail). */
  readonly cashierDisplayName: string | null;
  readonly terminalLabel: string | null;
  readonly terminalLastSeenAt: Date | null;
  readonly terminalTrustState: TerminalTrustState;
  /** Null for a legacy shift (no received cash facts: unknown, never zero). */
  readonly cashMovementCount: number | null;
  readonly lastCashMovementReceivedAt: Date | null;
  /** Sales captured from the opening terminal at or after the shift opened. */
  readonly saleCount: number;
  /** Refund executions recorded for the shift's drawer. */
  readonly refundExecutionCount: number;
  /** The server clock of the read. */
  readonly evaluatedAt: Date;
  /** The part of the digest that is read from the database at full precision. */
  readonly digestInputs: {
    readonly openedAtUtc: string;
    readonly lastCashMovementReceivedAtUtc: string | null;
  };
}

interface FactsDbRow {
  display_name: string | null;
  label: string | null;
  last_seen_at: Date | null;
  trust_state: TerminalTrustState;
  cash_movement_count: number | null;
  last_cash_movement_received_at: Date | null;
  last_cash_movement_received_at_utc: string | null;
  opened_at_utc: string;
  sale_count: number;
  refund_execution_count: number;
  evaluated_at: Date;
}

const UTC_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * The shift joined to its opening cashier and opening terminal, and the two derived columns every
 * reader of that join shares (RT-1453: the single-shift facts below and the store's open-shift list
 * are one join, not two copies). `opening_cashier_user_id` and `opening_device_id` are NOT NULL
 * foreign keys, so the inner joins drop no shift. One latent edge: `devices` is joined on the
 * shift's own tenant, and the schema alone does not force the device's tenant to match (migration
 * 0036: the service does). A shift whose device belongs to another tenant would be counted by
 * `countOpenStoreShifts` but not listed; nothing produces such a row today, and the count (the
 * guard) stays right either way.
 */
const SHIFT_WITH_CASHIER_AND_TERMINAL_FROM = `FROM shifts s
    JOIN users u ON u.id = s.opening_cashier_user_id
    JOIN devices d ON d.id = s.opening_device_id AND d.tenant_id = s.tenant_id`;
const CASHIER_DISPLAY_NAME_SQL = `NULLIF(btrim(u.display_name, E' \\t\\r\\n\\f'), '')`;
const TERMINAL_TRUST_STATE_SQL = `CASE WHEN d.retired_at IS NOT NULL THEN 'retired'
              WHEN d.revoked_at IS NOT NULL THEN 'revoked'
              ELSE 'active' END`;

/**
 * $1 shift, $2 tenant. One statement, so one snapshot of the facts. The cash
 * facts exist for a `cash_up` shift only (a legacy shift never opened with
 * one): the movements are counted for it, and null stays null (unknown). The
 * sales are those of the OPENING terminal with a sale time at or after the shift
 * opened. `refund_executions` carries no terminal, only `shift_ref` (the shift
 * whose drawer paid, RT-787), so the refund count is the executions of this
 * shift's drawer: the same drawer, the same period, recorded as reported.
 */
const FACTS_SQL = `
  SELECT ${CASHIER_DISPLAY_NAME_SQL} AS display_name,
         d.label,
         d.last_seen_at,
         ${TERMINAL_TRUST_STATE_SQL} AS trust_state,
         CASE WHEN s.source = 'cash_up' THEN mv.n END AS cash_movement_count,
         CASE WHEN s.source = 'cash_up' THEN mv.last_received_at END AS last_cash_movement_received_at,
         CASE WHEN s.source = 'cash_up'
              THEN to_char(mv.last_received_at AT TIME ZONE 'UTC', ${UTC_TEXT}) END AS last_cash_movement_received_at_utc,
         to_char(s.opened_at AT TIME ZONE 'UTC', ${UTC_TEXT}) AS opened_at_utc,
         (SELECT count(*)::int FROM sales sa
           WHERE sa.tenant_id = s.tenant_id AND sa.store_id = s.store_id
             AND sa.device_id = s.opening_device_id AND sa.occurred_at >= s.opened_at) AS sale_count,
         (SELECT count(*)::int FROM refund_executions r
           WHERE r.tenant_id = s.tenant_id AND r.store_id = s.store_id
             AND r.shift_ref = s.shift_id) AS refund_execution_count,
         now() AS evaluated_at
    ${SHIFT_WITH_CASHIER_AND_TERMINAL_FROM}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(m.received_at) AS last_received_at
        FROM shift_cash_movements m
       WHERE m.tenant_id = s.tenant_id AND m.shift_id = s.shift_id
    ) mv ON true
   WHERE s.shift_id = $1 AND s.tenant_id = $2`;

/** The facts of `shift`, or null when its rows are gone (never, given the FKs). */
export async function readForceCloseFacts(client: PoolClient, shift: StoreShiftRow): Promise<ForceCloseFacts | null> {
  const r = await client.query<FactsDbRow>(FACTS_SQL, [shift.shiftId, shift.tenantId]);
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    cashierDisplayName: row.display_name,
    terminalLabel: row.label,
    terminalLastSeenAt: row.last_seen_at,
    terminalTrustState: row.trust_state,
    cashMovementCount: row.cash_movement_count,
    lastCashMovementReceivedAt: row.last_cash_movement_received_at,
    saleCount: row.sale_count,
    refundExecutionCount: row.refund_execution_count,
    evaluatedAt: row.evaluated_at,
    digestInputs: {
      openedAtUtc: row.opened_at_utc,
      lastCashMovementReceivedAtUtc: row.last_cash_movement_received_at_utc,
    },
  };
}

/** One open shift of a store with the cashier and terminal facts the list and the deletion preview state. */
export interface OpenStoreShiftRecord {
  readonly shift: StoreShiftRow;
  readonly cashierDisplayName: string | null;
  readonly terminal: {
    readonly label: string | null;
    readonly lastSeenAt: Date | null;
    readonly trustState: TerminalTrustState;
  };
}

type OpenStoreShiftDbRow = StoreShiftDbRow & {
  display_name: string | null;
  last_seen_at: Date | null;
  trust_state: TerminalTrustState;
};

const OPEN_STORE_SHIFTS_SELECT = `
  SELECT s.shift_id, s.tenant_id, s.store_id, s.opening_device_id, s.opening_cashier_user_id,
         s.opened_at, s.lifecycle_state, s.source, s.currency_code,
         s.opening_float::text AS opening_float, s.received_at,
         d.label AS opened_on_terminal_label,
         ${CASHIER_DISPLAY_NAME_SQL} AS display_name,
         d.last_seen_at,
         ${TERMINAL_TRUST_STATE_SQL} AS trust_state
    ${SHIFT_WITH_CASHIER_AND_TERMINAL_FROM}
   WHERE s.tenant_id = $1 AND s.store_id = $2 AND s.lifecycle_state = 'open'`;
/** $1 tenant, $2 store, $3 limit. Two constant statements: the order is never interpolated from input. */
const OPEN_STORE_SHIFTS_NEWEST_SQL = `${OPEN_STORE_SHIFTS_SELECT}
   ORDER BY s.opened_at DESC, s.shift_id DESC
   LIMIT $3`;
const OPEN_STORE_SHIFTS_OLDEST_SQL = `${OPEN_STORE_SHIFTS_SELECT}
   ORDER BY s.opened_at, s.shift_id
   LIMIT $3`;

/** The open shifts of one store of the tenant, capped at `limit`, in the caller's transaction (no lock). */
export async function listOpenStoreShifts(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  options: { readonly limit: number; readonly order: "newest_first" | "oldest_first" },
): Promise<OpenStoreShiftRecord[]> {
  const sql = options.order === "newest_first" ? OPEN_STORE_SHIFTS_NEWEST_SQL : OPEN_STORE_SHIFTS_OLDEST_SQL;
  const r = await client.query<OpenStoreShiftDbRow>(sql, [scope.tenantId, scope.storeId, options.limit]);
  return r.rows.map((row) => ({
    shift: toStoreShift(row, false),
    cashierDisplayName: row.display_name,
    terminal: { label: row.opened_on_terminal_label, lastSeenAt: row.last_seen_at, trustState: row.trust_state },
  }));
}

/**
 * The ids of the stores of the tenant that have at least one open shift, ascending (RT-1450). Deleted
 * stores are not filtered here: the `stores` module decides which of them are live.
 */
export async function listOpenShiftStoreIds(client: PoolClient, tenantId: string): Promise<string[]> {
  const r = await client.query<{ store_id: string }>(
    `SELECT DISTINCT store_id::text AS store_id FROM shifts
      WHERE tenant_id = $1 AND lifecycle_state = 'open'
      ORDER BY store_id`,
    [tenantId],
  );
  return r.rows.map((row) => row.store_id);
}

/** Every open shift of the store: the exact count a deletion guard decides on (no row limit). */
export async function countOpenStoreShifts(client: PoolClient, storeId: string): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM shifts WHERE store_id = $1 AND lifecycle_state = 'open'`,
    [storeId],
  );
  return r.rows[0]?.n ?? 0;
}

/** Bumped only when the digest's inputs change; clients never interpret the digest. */
const FINGERPRINT_VERSION = 1;

/**
 * The preview fingerprint: a SHA-256 hex digest over the canonical JSON of the
 * facts the preview states. Pure: the preview and the write both call it with
 * facts read by `readForceCloseFacts` and the verdict of the same moment.
 */
export function previewFingerprint(shift: StoreShiftRow, verdict: StuckVerdict, facts: ForceCloseFacts): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        v: FINGERPRINT_VERSION,
        tenantId: shift.tenantId,
        shiftId: shift.shiftId,
        lifecycleState: shift.lifecycleState,
        openedAt: facts.digestInputs.openedAtUtc,
        stale: verdict.stale,
        liveOperatorSession: verdict.liveOperatorSession,
        liveCashierAdmission: verdict.liveCashierAdmission,
        cashMovementCount: facts.cashMovementCount,
        lastCashMovementReceivedAt: facts.digestInputs.lastCashMovementReceivedAtUtc,
        saleCount: facts.saleCount,
        refundExecutionCount: facts.refundExecutionCount,
        openingFloat: shift.openingFloat,
        currencyCode: shift.currencyCode,
        terminal: { deviceId: shift.openingDeviceId, trustState: facts.terminalTrustState },
      }),
    )
    .digest("hex");
}
