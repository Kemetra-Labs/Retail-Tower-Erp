/**
 * ShiftForceCloseRepository — persistence for RT-742 `forceCloseShift`
 * (`pos-shifts.openapi.yaml` 1.4.0-draft; RT-811 stuck rule, 1.5.0-draft) and
 * for the Console force close over the same service (RT-1445,
 * `console-force-actions.openapi.yaml`).
 *
 * Every method takes the caller's tenant-scoped client (`runWithTenantContext`
 * on the NOBYPASSRLS domain pool), so every statement also runs under the
 * tenant policies of `shifts`, `devices`, `auth_tokens`, `cashier_admissions`
 * and `shift_forced_closes`. RLS isolates tenants only, so the STORE predicate is
 * in every query (Constitution §II, §XII).
 *
 * Scope. Unlike the cash-up writes, the shift resolves on ANY device of the
 * envelope's tenant and store, legacy rows included (contract, Scope);
 * another store, another tenant and an unknown id are all "no row". The
 * Console routes name the shift only: its store is the shift's own, and the
 * tenant is the session's.
 */
import type { PoolClient } from "pg";

import { hasForcedClose, type ShiftLifecycleState } from "./shift-cash-up.repository";

/** A shift of the envelope's store, as the force close needs it. */
export interface StoreShiftRow {
  readonly shiftId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly openingDeviceId: string;
  readonly openingUserId: string;
  readonly openedAt: Date;
  readonly lifecycleState: ShiftLifecycleState;
  readonly source: "legacy" | "cash_up";
  /** Null for a legacy shift (no cash-up open). */
  readonly currencyCode: string | null;
  readonly openingFloat: string | null;
  readonly receivedAt: Date | null;
  /** The opening terminal's label; null when it has none. */
  readonly openedOnTerminalLabel: string | null;
  /**
   * True when a force close is recorded (`shift_forced_closes`); the shift is
   * then `closed_forced` with no `shift_closes` row. A `closed_forced` shift
   * without one was closed on its terminal by a counted forced close.
   */
  readonly notCounted: boolean;
}

/** Where a force close came from (`shift_forced_closes.closed_via`, 0119). */
type ForcedCloseVia = "pos" | "console";

/** The force close to record; the time is the server clock. */
export interface NewForcedClose {
  readonly closedByUserId: string;
  /** The calling terminal; null exactly when `closedVia` is `console` (0119 CHECK). */
  readonly closedFromDeviceId: string | null;
  readonly closedVia: ForcedCloseVia;
  readonly forcedReason: string;
  /** sha256 of the natural key (32 bytes). */
  readonly payloadHash: Buffer;
}

/** A recorded force close, with both terminals named by label. */
export interface ForcedCloseRow extends NewForcedClose {
  readonly shiftId: string;
  readonly closedAt: Date;
  readonly closedFromTerminalLabel: string | null;
  readonly openedOnTerminalLabel: string | null;
}

/** The stuck rule's inputs beyond the shift. */
export interface StuckRule {
  /**
   * The caller's own envelope session, which never makes the drawer look live.
   * Null for the Console (RT-1445): it has no envelope session, so every active
   * `pos_operator` session of the opening cashier counts.
   */
  readonly callerTokenId: string | null;
  readonly thresholdMinutes: number;
}

/**
 * The three predicates of the stuck rule, each judged at the transaction's
 * `now()`. The shift is stuck exactly when it is stale and neither live
 * predicate holds. The POS force close, the Console list, the preview and the
 * Console force close all read this one verdict (RT-1445), so they cannot
 * diverge.
 */
export interface StuckVerdict {
  readonly stale: boolean;
  readonly liveOperatorSession: boolean;
  readonly liveCashierAdmission: boolean;
}

/** The stuck rule's blockers, in the contract's order (`ShiftBlocker`, minus `shift_not_open`). */
export type StuckBlocker = "not_stale" | "live_operator_session" | "live_cashier_admission";

export function stuckBlockers(verdict: StuckVerdict): StuckBlocker[] {
  const blockers: StuckBlocker[] = [];
  if (!verdict.stale) blockers.push("not_stale");
  if (verdict.liveOperatorSession) blockers.push("live_operator_session");
  if (verdict.liveCashierAdmission) blockers.push("live_cashier_admission");
  return blockers;
}

/**
 * The force close's shift UPDATE did not move exactly one open row. Thrown
 * so the caller's transaction rolls back: nothing is recorded.
 */
export class ForceCloseNotAppliedError extends Error {
  constructor() {
    super("the force close transition did not apply to exactly one open shift");
    this.name = "ForceCloseNotAppliedError";
  }
}

export interface StoreShiftDbRow {
  shift_id: string;
  tenant_id: string;
  store_id: string;
  opening_device_id: string;
  opening_cashier_user_id: string;
  opened_at: Date;
  lifecycle_state: ShiftLifecycleState;
  source: "legacy" | "cash_up";
  currency_code: string | null;
  opening_float: string | null;
  received_at: Date | null;
  opened_on_terminal_label: string | null;
}

interface ForcedCloseDbRow {
  shift_id: string;
  closed_by_user_id: string;
  closed_at: Date;
  closed_from_device_id: string | null;
  closed_via: ForcedCloseVia;
  closed_from_terminal_label: string | null;
  opened_on_terminal_label: string | null;
  forced_reason: string;
  payload_hash: Buffer;
}

/** $1 shift, $2 tenant, $3 store. The shift row is locked; the device row is not. */
const FIND_STORE_SHIFT_SQL = `
  SELECT s.shift_id, s.tenant_id, s.store_id, s.opening_device_id, s.opening_cashier_user_id,
         s.opened_at, s.lifecycle_state, s.source, s.currency_code,
         s.opening_float::text AS opening_float, s.received_at,
         d.label AS opened_on_terminal_label
    FROM shifts s
    LEFT JOIN devices d ON d.id = s.opening_device_id AND d.tenant_id = s.tenant_id
   WHERE s.shift_id = $1 AND s.tenant_id = $2 AND s.store_id = $3
     FOR UPDATE OF s`;

/**
 * $1 shift, $2 tenant. The Console routes name the shift only, so the store is
 * the shift's own (RT-1445). The write locks the row (the lock `closeShift` and
 * `recordCashMovement` take, so a Console close serialises with them and with a
 * POS force close); the preview reads without one. The two statements differ
 * by the constant `FOR UPDATE` clause only.
 */
const FIND_TENANT_SHIFT_SQL = `
  SELECT s.shift_id, s.tenant_id, s.store_id, s.opening_device_id, s.opening_cashier_user_id,
         s.opened_at, s.lifecycle_state, s.source, s.currency_code,
         s.opening_float::text AS opening_float, s.received_at,
         d.label AS opened_on_terminal_label
    FROM shifts s
    LEFT JOIN devices d ON d.id = s.opening_device_id AND d.tenant_id = s.tenant_id
   WHERE s.shift_id = $1 AND s.tenant_id = $2`;
const FIND_TENANT_SHIFT_LOCKED_SQL = `${FIND_TENANT_SHIFT_SQL}
     FOR UPDATE OF s`;

/**
 * The `GET /shifts/stuck` predicate minus the caller's own session (contract,
 * Eligibility), as its three predicates: opened longer ago than the threshold
 * (`stale`), an active `pos_operator` session of the opening cashier on the
 * store other than the caller's (`live_operator_session`), and (RT-811) a live
 * cashier admission of the tenant on the opening terminal: any user, not
 * ended, not expired at the server clock (`live_cashier_admission`). The
 * caller's envelope makes no exception to the admission rule. A legacy shift
 * with no opening terminal has no admission to find. A NULL caller token (the
 * Console, RT-1445) excludes no session: the `IS NULL` arm is required,
 * because `t.id <> NULL` is NULL and would hide every session, so a live
 * drawer would read as stuck. $1 openedAt, $2 threshold minutes, $3 opening
 * cashier, $4 store, $5 the caller's token (or null), $6 tenant, $7 opening
 * terminal.
 */
const STUCK_VERDICT_SQL = `
  SELECT ($1::timestamptz < now() - ($2::int * INTERVAL '1 minute')) AS stale,
         EXISTS (
           SELECT 1 FROM auth_tokens t
            WHERE t.scope = 'pos_operator'
              AND t.user_id = $3
              AND t.store_id = $4
              AND t.revoked_at IS NULL
              AND t.expires_at > now()
              AND ($5::uuid IS NULL OR t.id <> $5::uuid)) AS live_operator_session,
         EXISTS (
           SELECT 1 FROM cashier_admissions a
            WHERE a.tenant_id = $6::uuid
              AND a.device_id = $7::uuid
              AND a.ended_at IS NULL
              AND a.expires_at > now()) AS live_cashier_admission`;

/** $1 shift, $2 tenant, $3 store. Both terminals by their current label. */
const FIND_FORCED_CLOSE_SQL = `
  SELECT f.shift_id, f.closed_by_user_id, f.closed_at, f.closed_from_device_id, f.closed_via,
         cd.label AS closed_from_terminal_label, od.label AS opened_on_terminal_label,
         f.forced_reason, f.payload_hash
    FROM shift_forced_closes f
    LEFT JOIN devices cd ON cd.id = f.closed_from_device_id AND cd.tenant_id = f.tenant_id
    LEFT JOIN devices od ON od.id = f.opening_device_id AND od.tenant_id = f.tenant_id
   WHERE f.shift_id = $1 AND f.tenant_id = $2 AND f.store_id = $3`;

export function toStoreShift(row: StoreShiftDbRow, notCounted: boolean): StoreShiftRow {
  return {
    shiftId: row.shift_id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    openingDeviceId: row.opening_device_id,
    openingUserId: row.opening_cashier_user_id,
    openedAt: row.opened_at,
    lifecycleState: row.lifecycle_state,
    source: row.source,
    currencyCode: row.currency_code,
    openingFloat: row.opening_float,
    receivedAt: row.received_at,
    openedOnTerminalLabel: row.opened_on_terminal_label,
    notCounted,
  };
}

function toForcedClose(row: ForcedCloseDbRow): ForcedCloseRow {
  return {
    shiftId: row.shift_id,
    closedByUserId: row.closed_by_user_id,
    closedAt: row.closed_at,
    closedFromDeviceId: row.closed_from_device_id,
    closedVia: row.closed_via,
    closedFromTerminalLabel: row.closed_from_terminal_label,
    openedOnTerminalLabel: row.opened_on_terminal_label,
    forcedReason: row.forced_reason,
    payloadHash: row.payload_hash,
  };
}

export class ShiftForceCloseRepository {
  /**
   * The shift `shiftId` of THIS tenant and store, on any device, locked FOR
   * UPDATE; or null. Whether it is force-closed is read after the lock
   * (`hasForcedClose`), so a force close committed while this waited is seen.
   */
  async findStoreShift(
    client: PoolClient,
    scope: { readonly tenantId: string; readonly storeId: string },
    shiftId: string,
  ): Promise<StoreShiftRow | null> {
    const r = await client.query<StoreShiftDbRow>(FIND_STORE_SHIFT_SQL, [shiftId, scope.tenantId, scope.storeId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    const notCounted =
      row.lifecycle_state === "closed_forced" && (await hasForcedClose(client, { shiftId, tenantId: scope.tenantId }));
    return toStoreShift(row, notCounted);
  }

  /**
   * The shift `shiftId` of THIS tenant, on any store and device (the Console
   * routes name the shift only; the caller's scope is decided before this is
   * called), or null. Locked FOR UPDATE when `lock` (the write); the preview
   * reads without a lock.
   */
  async findShiftInTenant(
    client: PoolClient,
    tenantId: string,
    shiftId: string,
    lock: boolean,
  ): Promise<StoreShiftRow | null> {
    const r = await client.query<StoreShiftDbRow>(lock ? FIND_TENANT_SHIFT_LOCKED_SQL : FIND_TENANT_SHIFT_SQL, [
      shiftId,
      tenantId,
    ]);
    const row = r.rows[0];
    if (row === undefined) return null;
    const notCounted = row.lifecycle_state === "closed_forced" && (await hasForcedClose(client, { shiftId, tenantId }));
    return toStoreShift(row, notCounted);
  }

  /** Whether the open `shift` is stuck now, the caller's own session excluded. */
  async isStuck(client: PoolClient, shift: StoreShiftRow, rule: StuckRule): Promise<boolean> {
    const verdict = await this.readVerdict(client, shift, rule);
    return verdict.stale && !verdict.liveOperatorSession && !verdict.liveCashierAdmission;
  }

  /** The three predicates of the stuck rule for `shift`, at this transaction's `now()`. */
  async readVerdict(client: PoolClient, shift: StoreShiftRow, rule: StuckRule): Promise<StuckVerdict> {
    const r = await client.query<{
      stale: boolean;
      live_operator_session: boolean;
      live_cashier_admission: boolean;
    }>(STUCK_VERDICT_SQL, [
      shift.openedAt,
      rule.thresholdMinutes,
      shift.openingUserId,
      shift.storeId,
      rule.callerTokenId,
      shift.tenantId,
      shift.openingDeviceId,
    ]);
    const row = r.rows[0];
    // No row cannot happen (a SELECT of scalars); fail closed: not stale, live.
    return {
      stale: row?.stale === true,
      liveOperatorSession: row?.live_operator_session !== false,
      liveCashierAdmission: row?.live_cashier_admission !== false,
    };
  }

  /** The recorded force close of `shift`, or null. */
  async findForcedClose(client: PoolClient, shift: StoreShiftRow): Promise<ForcedCloseRow | null> {
    const r = await client.query<ForcedCloseDbRow>(FIND_FORCED_CLOSE_SQL, [shift.shiftId, shift.tenantId, shift.storeId]);
    const row = r.rows[0];
    return row === undefined ? null : toForcedClose(row);
  }

  /**
   * Records the force close of the locked, open `shift` (server clock) and
   * moves it to `closed_forced` (the state a counted forced close also takes;
   * the `shift_forced_closes` row is what says "not counted"). A shift UPDATE that does not move exactly one
   * open row throws ForceCloseNotAppliedError, so the transaction rolls back.
   */
  async insertForcedClose(client: PoolClient, shift: StoreShiftRow, close: NewForcedClose): Promise<ForcedCloseRow> {
    await client.query(
      `INSERT INTO shift_forced_closes
         (shift_id, tenant_id, store_id, opening_device_id, closed_from_device_id, closed_via,
          closed_by_user_id, closed_at, forced_reason, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $9, $6, now(), $7, $8)`,
      [
        shift.shiftId,
        shift.tenantId,
        shift.storeId,
        shift.openingDeviceId,
        close.closedFromDeviceId,
        close.closedByUserId,
        close.forcedReason,
        close.payloadHash,
        close.closedVia,
      ],
    );
    const moved = await client.query(
      `UPDATE shifts SET lifecycle_state = 'closed_forced'
        WHERE shift_id = $1 AND tenant_id = $2 AND store_id = $3 AND opening_device_id = $4
          AND lifecycle_state = 'open'`,
      [shift.shiftId, shift.tenantId, shift.storeId, shift.openingDeviceId],
    );
    if (moved.rowCount !== 1) throw new ForceCloseNotAppliedError();
    const recorded = await this.findForcedClose(client, shift);
    if (recorded === null) throw new ForceCloseNotAppliedError();
    return recorded;
  }
}
