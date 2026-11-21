/**
 * RT-1403 S2 — the sale-void payout record (migration 0069).
 *
 * One append-only row per sale whose void cash left the drawer: a gated `payout` (the void was
 * confirmed by Backend-Core) or a manager-attested `exception`. The row is written in ONE
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
/** `no_drawer`: RT-531, the terminal has no cash drawer; `manual`: an attested exception. */
type PayoutMethod = 'drawer' | 'no_drawer' | 'manual';

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
