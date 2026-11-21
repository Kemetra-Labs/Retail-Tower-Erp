/**
 * RT-1403 S2 — the sale-void payout claim and record (migration 0069).
 *
 * A payout is CLAIMED (a durable row, with its audit) before the drawer is kicked, as RT-15 does for
 * returns, and completed by the record once the kick opened (or none is configured, or a manager
 * attested a manual payout). A claim with no record is drawer activity in flight: it blocks a fresh
 * payout and the shift close.
 *
 * The record is one append-only row per sale whose void cash left the drawer: a gated `payout` (the
 * void was confirmed by Backend-Core, completing its claim) or a manager-attested `exception`. It is
 * written in ONE
 * transaction with its audit event, and, for an exception, with the spending of its approval
 * (`build` runs inside the transaction). Nothing is ever updated or deleted: the schema triggers
 * refuse it, and refuse an insert the payout gate would refuse (the DB backstop).
 *
 * `DatabaseHandle` is injected so tests run on sql.js.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { SaleVoidMismatchReason, SaleVoidState } from '../../shared/sale-void/types.js';
import type { VoidScope } from './sale-void-repository.js';

type PayoutKind = 'payout' | 'exception';
/**
 * `no_drawer`: RT-531, the terminal has no cash drawer; `manual`: a manager attested a payout from a
 * drawer opened by hand (always the method of an exception).
 */
type PayoutMethod = 'drawer' | 'no_drawer' | 'manual';

/**
 * The drawer kick record of a claim (0069, as 0040): `sending` is written before the transport is
 * called; `failed_before_send` (provably never reached the hardware) is the only outcome after which
 * the drawer may be kicked again.
 */
type KickOutcome = 'sending' | 'opened' | 'failed_before_send' | 'unknown';
export type KickResult = Exclude<KickOutcome, 'sending'>;

/** A started payout: who claimed it, in which shift, and where its drawer kick stands. */
export interface NewClaim {
  readonly voidId: string;
  readonly saleId: string;
  readonly scope: VoidScope;
  readonly shiftId: string;
  /** The void's business day. */
  readonly businessDate: string;
  readonly claimedBy: {
    readonly operatorId: string;
    readonly displayName: string;
    readonly sessionId: string;
  };
  readonly claimedAt: string;
}

export interface PayoutClaim extends NewClaim {
  readonly kickOutcome: KickOutcome | null;
  readonly kickCount: number;
  readonly kickedAt: string | null;
}

/** The single-use approval an exception spent, as recorded. */
interface ExceptionEvidence {
  readonly approvalId: string;
  readonly approverUserId: string;
  readonly requesterUserId: string;
  readonly policyVersion: string;
}

/** One payout record: the facts at the moment the cash left (all immutable). */
export interface NewPayout {
  readonly payoutId: string;
  readonly voidId: string;
  readonly saleId: string;
  readonly scope: VoidScope;
  /** The open shift that paid it; its cash-up counts the record. */
  readonly shiftId: string;
  /** The store business day of the payment (`YYYY-MM-DD`). */
  readonly businessDate: string;
  readonly kind: PayoutKind;
  readonly method: PayoutMethod;
  /** The void's journaled net cash. */
  readonly amountMinor: number;
  readonly currencyCode: string;
  /** The void's state when the cash left. */
  readonly voidState: SaleVoidState;
  /** Why cash and accounting disagree; set only on an exception. */
  readonly mismatchReason: SaleVoidMismatchReason | null;
  readonly paidAt: string;
  readonly paidBy: {
    readonly operatorId: string;
    readonly displayName: string;
    readonly sessionId: string;
  };
  /** Set only on an exception. */
  readonly exception: ExceptionEvidence | null;
}

export type PayoutRecord = NewPayout;

export interface SaleVoidPayoutRepository {
  /** Run `fn` in one local DB transaction (the claim, its kick mark and its audit). */
  transaction<T>(fn: () => T): T;
  /** Start (claim) the payout of a void; false when it already has one. A schema trigger refuses the rest. */
  startClaim(claim: NewClaim): boolean;
  readClaim(voidId: string): PayoutClaim | null;
  /**
   * Record that a kick is about to be sent (counted), BEFORE the transport is called. False unless
   * the claim was never kicked or its last kick provably never left (`failed_before_send`).
   */
  markSending(stamp: { readonly voidId: string; readonly now: string }): boolean;
  /** Resolve the kick in flight (`sending`) to its outcome, once. */
  recordKick(input: { readonly voidId: string; readonly outcome: KickResult }): boolean;
  /** Claims of this terminal with no record yet: payouts whose drawer may be open. */
  countOpenClaims(scope: VoidScope): number;
  /** True once a `payout_not_made` mismatch audit exists for the void (the flag is audit-only). */
  hasUnpaidFlag(voidId: string): boolean;
  /**
   * Insert the record `build` returns. `build` runs INSIDE the transaction, before the insert, so
   * it can spend a manager approval; a throw from `build`, the insert (a schema trigger) or
   * `within` (the audit) rolls everything back.
   */
  insertFrom(build: () => NewPayout, within?: (inserted: PayoutRecord) => void): void;
  readByVoid(voidId: string): PayoutRecord | null;
  readBySale(saleId: string): PayoutRecord | null;
}

interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}

interface Row {
  payout_id: string;
  void_id: string;
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  shift_id: string;
  business_date: string;
  kind: PayoutKind;
  method: PayoutMethod;
  amount_minor: number;
  currency_code: string;
  void_state: SaleVoidState;
  mismatch_reason: SaleVoidMismatchReason | null;
  paid_at: string;
  paid_by_operator_id: string;
  paid_by_display_name: string;
  paid_by_session_id: string;
  exception_approval_id: string | null;
  exception_approver_user_id: string | null;
  exception_requester_user_id: string | null;
  exception_policy_version: string | null;
}

interface ClaimRow {
  void_id: string;
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  shift_id: string;
  business_date: string;
  claimed_by_operator_id: string;
  claimed_by_display_name: string;
  claimed_by_session_id: string;
  claimed_at: string;
  kick_outcome: KickOutcome | null;
  kick_count: number;
  kicked_at: string | null;
}

function toClaim(row: ClaimRow): PayoutClaim {
  return {
    voidId: row.void_id,
    saleId: row.sale_id,
    scope: { tenantId: row.tenant_id, branchId: row.branch_id, terminalId: row.terminal_id },
    shiftId: row.shift_id,
    businessDate: row.business_date,
    claimedBy: {
      operatorId: row.claimed_by_operator_id,
      displayName: row.claimed_by_display_name,
      sessionId: row.claimed_by_session_id,
    },
    claimedAt: row.claimed_at,
    kickOutcome: row.kick_outcome,
    kickCount: row.kick_count,
    kickedAt: row.kicked_at,
  };
}

function evidenceOf(row: Row): ExceptionEvidence | null {
  if (
    row.exception_approval_id === null ||
    row.exception_approver_user_id === null ||
    row.exception_requester_user_id === null ||
    row.exception_policy_version === null
  ) {
    return null;
  }
  return {
    approvalId: row.exception_approval_id,
    approverUserId: row.exception_approver_user_id,
    requesterUserId: row.exception_requester_user_id,
    policyVersion: row.exception_policy_version,
  };
}

function toRecord(row: Row): PayoutRecord {
  return {
    payoutId: row.payout_id,
    voidId: row.void_id,
    saleId: row.sale_id,
    scope: { tenantId: row.tenant_id, branchId: row.branch_id, terminalId: row.terminal_id },
    shiftId: row.shift_id,
    businessDate: row.business_date,
    kind: row.kind,
    method: row.method,
    amountMinor: row.amount_minor,
    currencyCode: row.currency_code,
    voidState: row.void_state,
    mismatchReason: row.mismatch_reason,
    paidAt: row.paid_at,
    paidBy: {
      operatorId: row.paid_by_operator_id,
      displayName: row.paid_by_display_name,
      sessionId: row.paid_by_session_id,
    },
    exception: evidenceOf(row),
  };
}

const INSERT_SQL = `
  INSERT INTO sale_void_payouts
    (payout_id, void_id, sale_id, tenant_id, branch_id, terminal_id, shift_id, business_date, kind,
     method, amount_minor, currency_code, void_state, mismatch_reason, paid_at,
     paid_by_operator_id, paid_by_display_name, paid_by_session_id, exception_approval_id,
     exception_approver_user_id, exception_requester_user_id, exception_policy_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertParams(p: NewPayout): unknown[] {
  return [
    p.payoutId,
    p.voidId,
    p.saleId,
    p.scope.tenantId,
    p.scope.branchId,
    p.scope.terminalId,
    p.shiftId,
    p.businessDate,
    p.kind,
    p.method,
    p.amountMinor,
    p.currencyCode,
    p.voidState,
    p.mismatchReason,
    p.paidAt,
    p.paidBy.operatorId,
    p.paidBy.displayName,
    p.paidBy.sessionId,
    p.exception?.approvalId ?? null,
    p.exception?.approverUserId ?? null,
    p.exception?.requesterUserId ?? null,
    p.exception?.policyVersion ?? null,
  ];
}

type InsertHook = (inserted: PayoutRecord) => void;

class SqlSaleVoidPayoutRepository implements SaleVoidPayoutRepository {
  private readonly insertTx: (build: () => NewPayout, within: InsertHook) => void;

  constructor(private readonly db: DatabaseHandle) {
    this.insertTx = db.transaction((build: () => NewPayout, within: InsertHook): void => {
      const record = build();
      (this.db.prepare(INSERT_SQL) as Stmt).run(...insertParams(record));
      const inserted = this.readByVoid(record.voidId);
      if (inserted !== null) within(inserted);
    });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  startClaim(c: NewClaim): boolean {
    if (this.readClaim(c.voidId) !== null) return false;
    const sql = `INSERT INTO sale_void_payout_claims
      (void_id, sale_id, tenant_id, branch_id, terminal_id, shift_id, business_date,
       claimed_by_operator_id, claimed_by_display_name, claimed_by_session_id, claimed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return (
      (this.db.prepare(sql) as Stmt).run(
        c.voidId,
        c.saleId,
        c.scope.tenantId,
        c.scope.branchId,
        c.scope.terminalId,
        c.shiftId,
        c.businessDate,
        c.claimedBy.operatorId,
        c.claimedBy.displayName,
        c.claimedBy.sessionId,
        c.claimedAt,
      ).changes > 0
    );
  }

  readClaim(voidId: string): PayoutClaim | null {
    const row = (
      this.db.prepare('SELECT * FROM sale_void_payout_claims WHERE void_id = ?') as Stmt
    ).get(voidId);
    return row === undefined ? null : toClaim(row as ClaimRow);
  }

  markSending({ voidId, now }: { voidId: string; now: string }): boolean {
    const sql = `UPDATE sale_void_payout_claims SET kick_outcome = 'sending',
        kick_count = kick_count + 1, kicked_at = ?
      WHERE void_id = ? AND NOT EXISTS (SELECT 1 FROM sale_void_payouts p WHERE p.void_id = ?)
        AND (kick_outcome IS NULL OR kick_outcome = 'failed_before_send')`;
    return (this.db.prepare(sql) as Stmt).run(now, voidId, voidId).changes > 0;
  }

  recordKick({ voidId, outcome }: { voidId: string; outcome: KickResult }): boolean {
    const sql = `UPDATE sale_void_payout_claims SET kick_outcome = ?
      WHERE void_id = ? AND kick_outcome = 'sending'`;
    return (this.db.prepare(sql) as Stmt).run(outcome, voidId).changes > 0;
  }

  countOpenClaims(scope: VoidScope): number {
    const sql = `SELECT COUNT(*) AS n FROM sale_void_payout_claims c
      WHERE c.tenant_id = ? AND c.branch_id = ? AND c.terminal_id = ?
        AND NOT EXISTS (SELECT 1 FROM sale_void_payouts p WHERE p.void_id = c.void_id)`;
    const row = (this.db.prepare(sql) as Stmt).get(
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
    ) as { n: number };
    return row.n;
  }

  hasUnpaidFlag(voidId: string): boolean {
    const sql = `SELECT 1 FROM audit_events
      WHERE action_category = 'sale.void.cash_mismatch_flagged'
        AND json_extract(payload, '$.void_id') = ?
        AND json_extract(payload, '$.mismatch_reason') = 'payout_not_made' LIMIT 1`;
    return (this.db.prepare(sql) as Stmt).get(voidId) !== undefined;
  }

  private one(sql: string, id: string): PayoutRecord | null {
    const row = (this.db.prepare(sql) as Stmt).get(id);
    return row === undefined ? null : toRecord(row as Row);
  }

  insertFrom(build: () => NewPayout, within: InsertHook = () => undefined): void {
    this.insertTx(build, within);
  }

  readByVoid(voidId: string): PayoutRecord | null {
    return this.one('SELECT * FROM sale_void_payouts WHERE void_id = ?', voidId);
  }

  readBySale(saleId: string): PayoutRecord | null {
    return this.one('SELECT * FROM sale_void_payouts WHERE sale_id = ?', saleId);
  }
}

export function createSaleVoidPayoutRepository(db: DatabaseHandle): SaleVoidPayoutRepository {
  return new SqlSaleVoidPayoutRepository(db);
}
