/**
 * ShiftForceCloseService — RT-742 `forceCloseShift`
 * (`POST /api/pos/v1/shifts/{shift_id}/forced-close`, `pos-shifts.openapi.yaml`
 * 1.4.0-draft; RT-554 follow-up, owner decision 2026-10-19; design option A,
 * Jira RT-742 comment 13237).
 *
 * A manager clears a STUCK shift from any terminal of the same tenant and
 * store. The shift is closed as NOT COUNTED: the manager's terminal holds
 * neither the drawer's totals nor the POS cash-up, and the server never
 * computes one (Constitution §III), so the fact carries the closing manager,
 * the calling terminal, the reason and the server clock, and no total.
 *
 * One transaction under the envelope's tenant (RLS on the NOBYPASSRLS domain
 * pool). Tenant, store, actor, calling terminal and the caller's own session
 * come from the envelope guard, never from the body (Constitution §II, §XII).
 * The shift row is locked FOR UPDATE first, the lock `closeShift` and
 * `recordCashMovement` take, so a force close serialises with them and with
 * another force close: the loser re-reads the committed state.
 *
 * Order (contract, Order): the shift in the envelope's tenant and store, on
 * any device (404 `shift_not_found`) → the natural-key replay (200) or, for a
 * different `forcedReason`, 409 `shift_force_closed` → 409 `shift_closed` →
 * the stuck rule (409 `shift_not_stuck`) → record (201). The natural key is
 * the shift and the hash of `forcedReason`, never the actor: the same force
 * close from another manager or terminal is a replay of the recorded fact.
 *
 * RT-1445: the Console enters here too (`forceCloseFromConsole`), over the same
 * rows, the same stuck rule and the same natural key; it adds the preview
 * fingerprint and the D9 cap between the stuck rule and the record, and records
 * `closed_via = 'console'` with no terminal (0119). See that method.
 */
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import type { ForceActionAuditActor } from "../common/force-action-actor";
import { MembershipRepository } from "../context/membership.repository";
import { canonicalJson } from "../idempotency/canonical-json";
import { ShiftCashUpError } from "./shift-cash-up.errors";
import type { ShiftWriteResult } from "./shift-cash-up.service";
import { buildForceCloseAudit, readActorRole, type ForceCloseAudit } from "./shift-force-close.audit";
import { previewFingerprint, readForceCloseFacts } from "./shift-force-close.facts";
import {
  ShiftForceCloseRepository,
  stuckBlockers,
  type ForcedCloseRow,
  type StoreShiftRow,
} from "./shift-force-close.repository";
import { formatMoney } from "../common/money/shift-money";


/** What the envelope guard published: scope, actor, calling terminal and session. */
export interface ForceCloseContext {
  readonly tenantId: string;
  readonly storeId: string;
  /** The envelope operator: the closing manager. */
  readonly actorUserId: string;
  /** The terminal the envelope is bound to: where the request came from. */
  readonly callerDeviceId: string;
  /** The envelope's own `auth_tokens` row, excluded from the stuck rule. */
  readonly callerTokenId: string;
}

/** The `ForceCloseShiftRequest` body. */
export interface ForceCloseFact {
  readonly forcedReason: string;
}

/** The `ForcedCloseRecord` projection. */
export interface ForcedCloseProjection {
  readonly closedByUserId: string;
  readonly closedAt: string;
  readonly closedFromTerminalLabel: string | null;
  readonly openedOnTerminalLabel: string | null;
  readonly forcedReason: string;
  readonly cashCount: "not_counted";
}

/** The `ForceClosedShift` projection; null cash-up fields for a legacy shift. */
export interface ForceClosedShiftProjection {
  readonly shiftId: string;
  readonly status: "force_closed";
  readonly currencyCode: string | null;
  readonly openingFloat: string | null;
  readonly openedAt: string;
  readonly openingUserId: string;
  readonly receivedAt: string | null;
  readonly forcedClose: ForcedCloseProjection;
}

export interface ForceCloseResult extends ShiftWriteResult<ForceClosedShiftProjection> {
  readonly audit: ForceCloseAudit;
}

/** The `GET /shifts/stuck` staleness threshold, shared by this rule (minutes). */
export const STUCK_THRESHOLD_MINUTES = 15;

/** sha256 of the canonical natural key: the shift and the reason. */
export function forceCloseHash(shiftId: string, fact: ForceCloseFact): Buffer {
  return createHash("sha256").update(canonicalJson({ shiftId, forcedReason: fact.forcedReason })).digest();
}

/** The wire projection of a force-closed shift. No internal id is returned. */
export function toForceClosedShiftProjection(shift: StoreShiftRow, close: ForcedCloseRow): ForceClosedShiftProjection {
  const { currencyCode, openingFloat } = shift;
  return {
    shiftId: shift.shiftId,
    status: "force_closed",
    currencyCode,
    openingFloat:
      currencyCode === null || openingFloat === null ? null : formatMoney({ amount: openingFloat, currencyCode }),
    openedAt: shift.openedAt.toISOString(),
    openingUserId: shift.openingUserId,
    receivedAt: shift.receivedAt?.toISOString() ?? null,
    forcedClose: {
      closedByUserId: close.closedByUserId,
      closedAt: close.closedAt.toISOString(),
      closedFromTerminalLabel: close.closedFromTerminalLabel,
      openedOnTerminalLabel: close.openedOnTerminalLabel,
      forcedReason: close.forcedReason,
      cashCount: "not_counted",
    },
  };
}

/**
 * What the Console session published: the tenant, the closing user and the admitted actor (the access
 * guard ran before the service: an `owner` or `tenant_admin` with all-store access, or, since RT-1462,
 * a platform admin acting on behalf of the tenant).
 */
export interface ConsoleForceCloseContext {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actor: ForceActionAuditActor;
}

/** The `ConsoleForceCloseRequest` body. */
export interface ConsoleForceCloseRequest {
  readonly forcedReason: string;
  readonly previewFingerprint: string;
}

/** The `ConsoleForcedCloseRecord` projection: the POS record plus where the close came from. */
interface ConsoleForcedCloseProjection {
  readonly closedByUserId: string;
  readonly closedAt: string;
  readonly closedVia: "pos" | "console";
  readonly closedFromTerminalLabel: string | null;
  readonly openedOnTerminalLabel: string | null;
  readonly forcedReason: string;
  readonly cashCount: "not_counted";
}

/** The `ConsoleForceClosedShift` projection. */
export interface ConsoleForceClosedShiftProjection extends Omit<ForceClosedShiftProjection, "forcedClose"> {
  readonly forcedClose: ConsoleForcedCloseProjection;
}

/** What the record step hands the audit hook (the row is written in the close's transaction). */
interface ConsoleCloseEvent {
  readonly audit: ForceCloseAudit;
  readonly shiftId: string;
  readonly storeId: string;
}

/**
 * The two steps the Console owns inside the close's transaction (the shared
 * D9 cap and the audit row), so they commit or roll back with the record.
 */
export interface ConsoleCloseHooks {
  /** After the fingerprint matched, before the record: the D9 cap (throws the 429). */
  readonly beforeRecord: (client: PoolClient) => Promise<void>;
  /** After the record, in the same transaction: the `shift.force_closed` audit row. */
  readonly afterRecord: (client: PoolClient, event: ConsoleCloseEvent) => Promise<void>;
}

/** The wire projection of a force-closed shift for the Console. No internal id is returned. */
function toConsoleForceClosedShiftProjection(
  shift: StoreShiftRow,
  close: ForcedCloseRow,
): ConsoleForceClosedShiftProjection {
  const { forcedClose: _pos, ...rest } = toForceClosedShiftProjection(shift, close);
  return {
    ...rest,
    forcedClose: {
      closedByUserId: close.closedByUserId,
      closedAt: close.closedAt.toISOString(),
      closedVia: close.closedVia,
      closedFromTerminalLabel: close.closedFromTerminalLabel,
      openedOnTerminalLabel: close.openedOnTerminalLabel,
      forcedReason: close.forcedReason,
      cashCount: "not_counted",
    },
  };
}

/** One force close as the controller hands it over, with its natural-key hash. */
interface ForceCloseRequest {
  readonly ctx: ForceCloseContext;
  readonly shiftId: string;
  readonly fact: ForceCloseFact;
  readonly hash: Buffer;
}

/** One Console force close, with its natural-key hash and the Console's two steps. */
interface ConsoleCloseRequest {
  readonly ctx: ConsoleForceCloseContext;
  readonly shiftId: string;
  readonly request: ConsoleForceCloseRequest;
  readonly hash: Buffer;
  readonly hooks: ConsoleCloseHooks;
}

export class ShiftForceCloseService {
  private readonly memberships: MembershipRepository;

  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL). */
    private readonly pool: Pool,
    private readonly repo: ShiftForceCloseRepository = new ShiftForceCloseRepository(),
    /** The staleness threshold of the stuck rule: the one source for POS, list, preview and close. */
    readonly thresholdMinutes: number = STUCK_THRESHOLD_MINUTES,
  ) {
    this.memberships = new MembershipRepository(pool);
  }

  /** The Console's stuck rule: it has no envelope session, so no session is excluded. */
  consoleStuckRule(): { readonly callerTokenId: null; readonly thresholdMinutes: number } {
    return { callerTokenId: null, thresholdMinutes: this.thresholdMinutes };
  }

  async forceClose(
    ctx: ForceCloseContext,
    shiftId: string,
    fact: ForceCloseFact,
  ): Promise<ForceCloseResult> {
    const hash = forceCloseHash(shiftId, fact);
    const [shift, result, actorRole] = await runWithTenantContext(
      this.pool,
      { tenantId: ctx.tenantId, isPlatformAdmin: false },
      async (client) => {
        const [found, written] = await this.forceCloseInTenant(client, { ctx, shiftId, fact, hash });
        return [found, written, await readActorRole(this.memberships, client, ctx.tenantId, ctx.actorUserId)] as const;
      },
    );
    const audit = buildForceCloseAudit({
      shift,
      channel: "pos",
      actorRole,
      previewFingerprint: null,
      closedFromDeviceId: ctx.callerDeviceId,
      replayed: !result.created,
      nowMs: Date.now(),
    });
    return { ...result, audit };
  }

  /**
   * RT-1445: the Console force close (`consoleForceCloseShift`). One
   * transaction under the session's tenant. The caller's role and all-store
   * scope are decided before this is called; the shift is named without a
   * store, and the tenant is the session's.
   *
   * Order (contract, Evaluation order, steps 4 to 10), after the shift row is
   * locked: the shift in the tenant (404 `shift_not_found`) → the natural-key
   * replay (200: also from another actor, key or channel; it never checks the
   * fingerprint, the cap or the stuck rule) or, for a different
   * `forcedReason`, 409 `shift_force_closed` → 409 `shift_closed` → the stuck
   * rule with its blockers (409 `shift_not_stuck`) → the fingerprint (409
   * `preview_stale`) → the D9 cap (`beforeRecord`, 429) → record (201). The
   * replay sits before the fingerprint and the cap on purpose: the close itself
   * changes the state the fingerprint covers.
   *
   * The Console has no envelope session, so the stuck rule excludes none
   * (`callerTokenId: null`): a signed-in cashier is a live drawer. The close
   * records `closed_via = 'console'` and no terminal (0119).
   */
  async forceCloseFromConsole(
    ctx: ConsoleForceCloseContext,
    shiftId: string,
    request: ConsoleForceCloseRequest,
    hooks: ConsoleCloseHooks,
  ): Promise<ShiftWriteResult<ConsoleForceClosedShiftProjection>> {
    const hash = forceCloseHash(shiftId, { forcedReason: request.forcedReason });
    return runWithTenantContext(this.pool, { tenantId: ctx.tenantId, isPlatformAdmin: false }, (client) =>
      this.consoleCloseInTenant(client, { ctx, shiftId, request, hash, hooks }),
    );
  }

  private async consoleCloseInTenant(
    client: PoolClient,
    input: ConsoleCloseRequest,
  ): Promise<ShiftWriteResult<ConsoleForceClosedShiftProjection>> {
    const { ctx, shiftId, request, hash, hooks } = input;
    const shift = await this.repo.findShiftInTenant(client, ctx.tenantId, shiftId, true);
    if (shift === null) throw new ShiftCashUpError("shift_not_found");
    if (shift.notCounted) {
      const close = await this.repo.findForcedClose(client, shift);
      if (!close?.payloadHash.equals(hash)) throw new ShiftCashUpError("shift_force_closed");
      return { created: false, projection: toConsoleForceClosedShiftProjection(shift, close) };
    }
    if (shift.lifecycleState !== "open") throw new ShiftCashUpError("shift_closed");
    const verdict = await this.repo.readVerdict(client, shift, this.consoleStuckRule());
    const blockers = stuckBlockers(verdict);
    if (blockers.length > 0) throw new ShiftCashUpError("shift_not_stuck", { blockers });
    const facts = await readForceCloseFacts(client, shift);
    if (facts === null) throw new ShiftCashUpError("shift_not_found");
    const fingerprint = previewFingerprint(shift, verdict, facts);
    if (fingerprint !== request.previewFingerprint) throw new ShiftCashUpError("preview_stale");
    await hooks.beforeRecord(client);
    const recorded = await this.repo.insertForcedClose(client, shift, {
      closedByUserId: ctx.actorUserId,
      closedFromDeviceId: null,
      closedVia: "console",
      forcedReason: request.forcedReason,
      payloadHash: hash,
    });
    await hooks.afterRecord(client, {
      audit: buildForceCloseAudit({
        shift,
        channel: "console",
        actorRole: ctx.actor.role,
        actor: ctx.actor,
        previewFingerprint: fingerprint,
        closedFromDeviceId: null,
        replayed: false,
        nowMs: facts.evaluatedAt.getTime(),
      }),
      storeId: shift.storeId,
      shiftId: shift.shiftId,
    });
    return { created: true, projection: toConsoleForceClosedShiftProjection(shift, recorded) };
  }

  private async forceCloseInTenant(
    client: PoolClient,
    request: ForceCloseRequest,
  ): Promise<[StoreShiftRow, ShiftWriteResult<ForceClosedShiftProjection>]> {
    const { ctx, shiftId } = request;
    const shift = await this.repo.findStoreShift(client, { tenantId: ctx.tenantId, storeId: ctx.storeId }, shiftId);
    if (shift === null) throw new ShiftCashUpError("shift_not_found");
    return [shift, await this.closeShiftInStore(client, { ...request, shift })];
  }

  /** The located, locked shift: replay, refusal or the first record. */
  private async closeShiftInStore(
    client: PoolClient,
    request: ForceCloseRequest & { readonly shift: StoreShiftRow },
  ): Promise<ShiftWriteResult<ForceClosedShiftProjection>> {
    const { ctx, fact, hash, shift } = request;
    if (shift.notCounted) return this.replay(client, { shift, hash });
    if (shift.lifecycleState !== "open") throw new ShiftCashUpError("shift_closed");
    const stuck = await this.repo.isStuck(client, shift, {
      callerTokenId: ctx.callerTokenId,
      thresholdMinutes: this.thresholdMinutes,
    });
    if (!stuck) throw new ShiftCashUpError("shift_not_stuck");
    const recorded = await this.repo.insertForcedClose(client, shift, {
      closedByUserId: ctx.actorUserId,
      closedFromDeviceId: ctx.callerDeviceId,
      closedVia: "pos",
      forcedReason: fact.forcedReason,
      payloadHash: hash,
    });
    return { created: true, projection: toForceClosedShiftProjection(shift, recorded) };
  }

  /** The 200 replay of the recorded force close, or 409 for another reason. */
  private async replay(
    client: PoolClient,
    candidate: { readonly shift: StoreShiftRow; readonly hash: Buffer },
  ): Promise<ShiftWriteResult<ForceClosedShiftProjection>> {
    const close = await this.repo.findForcedClose(client, candidate.shift);
    if (!close?.payloadHash.equals(candidate.hash)) throw new ShiftCashUpError("shift_force_closed");
    return { created: false, projection: toForceClosedShiftProjection(candidate.shift, close) };
  }
}
