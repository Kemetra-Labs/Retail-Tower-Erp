/**
 * RT-15 S2 — shared fixture for the return-domain tests.
 *
 *   • a sql.js database with EVERY migration (incl. 0039) via the sale-sync fixture;
 *   • a synced local sale with a stored server `saleRef` (S1);
 *   • contract-typed `Sale` / `SaleReturn` / `Error` bodies (the vendored pin);
 *   • `FakeBackend` — an in-memory Backend-Core POS sales surface that honours
 *     the Idempotency-Key the way the contract describes (a same-key retry
 *     replays the stored 201 with `Idempotent-Replayed: true`) and records every
 *     request it sees;
 *   • `returnsHarness` — the composed return domain over all of the above.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import type { AuditEvent } from '../../../../shared/audit/event-shape.js';
import { AuditEmitter } from '../../../audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../audit/audit-events-store.js';
import type { DatabaseHandle } from '../../../db/client.js';
import type { DrawerSlot } from '../../../drawer/drawer-slot.js';
import { createShiftCashupRepo } from '../../../shift-cashup/shift-cashup-repo.js';
import type { ReturnsAuditSink } from '../../returns-audit.js';
import { openShiftRefOf, shiftRefAtOf } from '../../returns-execution-enqueue.js';
import { amount4ToMinor, parseAmount4, parseWholeQuantity } from '../../returns-money.js';
import type { AuthSnapshot } from '../../returns-auth.js';
import {
  composeReturns,
  type ComposeReturnsDeps,
  type ComposedReturns,
} from '../../compose-returns.js';
import type { ReturnsSession } from '../../returns-service.js';
import type { StatusReadAvailability } from '../../returns-status-availability.js';
import {
  createReturnDispositionsRepository,
  type ReturnDispositionsRepository,
} from '../../returns-dispositions-repository.js';
import { createReturnsRepository, type ReturnsRepository } from '../../returns-repository.js';
import type { Role } from '../../../../shared/operator/role.js';
import type {
  DrawerKickResult,
  DrawerKickTransport,
} from '../../../drawer/drawer-kick-transport.js';
import type {
  PrintAdapterResult,
  PrintPipeline,
  RenderedReceipt,
} from '../../../receipts/print-pipeline.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type {
  ContractError,
  ContractSale,
  ContractSaleLine,
  ContractSaleReturn,
} from '../__contract__/sales-returns.contract.js';

export { initSalesSyncSql as initReturnsSql };

export const BASE_URL = 'https://backend.example.invalid';
export const ENVELOPE = 'opaque-operator-envelope';
export const SALE_ID = 'sale-1';
export const SALE_NUMBER = `SN-${SALE_ID}`;
export const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
export const LINE_A = '0190f5a2-7b3c-7d4e-8f90-00000000000a';
export const LINE_B = '0190f5a2-7b3c-7d4e-8f90-00000000000b';
export const RETURN_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000ff';
/** RT-1543: the terminal's open shift (the shift whose drawer pays) in the harness. */
export const SHIFT_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000c3';
export const NOW = '2026-10-04T10:00:00.000Z';

/** `NOW` plus `seconds`, as the ISO-8601 stamp the domain clock returns. */
export function secondsAfterNow(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
}

export const CASH_SUMMARY = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 6500 }]);
export const CARD_SUMMARY = JSON.stringify([
  { tender_type: 'external_card_terminal', amount_applied_minor: 6500 },
]);

export const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };

const DEFAULT_ACTOR_USER_ID = '0190f5a2-3b4c-7d8e-9f01-000000000009';

/** The authorization snapshot a signed-in manager on this till is admitted as. */
export const MANAGER_ACTOR: AuthSnapshot = {
  scope: SCOPE,
  operatorId: 'op-manager',
  operatorSessionId: 'sess-manager',
  role: 'manager',
  displayName: 'Display manager',
  actorUserId: DEFAULT_ACTOR_USER_ID,
  envelope: ENVELOPE,
};

export function sessionFor(role: Role): ReturnsSession {
  return {
    role,
    operator_id: `op-${role}`,
    operator_session_id: `sess-${role}`,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    terminal_id: SCOPE.terminalId,
    display_name: `Display ${role}`,
    ...(role === 'cashier' ? {} : { user_id: DEFAULT_ACTOR_USER_ID }),
  };
}

/**
 * RT-15 S4 — the sale drawer's hardware port, faked: counts kicks, answers
 * with `answer` (opened by default) and runs `onKick` as the kick lands.
 */
export class FakeDrawer implements DrawerKickTransport {
  kicks = 0;
  answer: () => Promise<DrawerKickResult> = () => Promise.resolve({ ok: true });
  onKick: (() => void) | null = null;

  kick(): Promise<DrawerKickResult> {
    this.kicks += 1;
    this.onKick?.();
    return this.answer();
  }
}

/** RT-15 S4 — the receipt print pipeline's `printRendered`, faked: records every slip. */
export class FakePrinter implements Pick<PrintPipeline, 'printRendered'> {
  readonly printed: RenderedReceipt[] = [];
  answer: () => Promise<PrintAdapterResult> = () =>
    Promise.resolve({ ok: true, render_path: 'os_print' });

  printRendered(rendered: RenderedReceipt): Promise<PrintAdapterResult> {
    this.printed.push(rendered);
    return this.answer();
  }

  /** The text of the n-th printed slip (HTML with tags removed). */
  textOf(n: number): string {
    const html = this.printed[n]?.html ?? '';
    return html.replace(/<[^>]+>/g, '\n');
  }
}

/** A contract `SaleLine` as Backend-Core renders it (numeric(19,4) / (19,6) text). */
export function saleLine(overrides: Partial<ContractSaleLine> = {}): ContractSaleLine {
  return {
    lineRef: LINE_A,
    lineName: 'Panadol 500mg',
    unitPrice: '15.0000',
    currencyCode: 'EGP',
    quantity: '3',
    lineAmount: '45.0000',
    taxAmount: null,
    unit: 'unit',
    tenantProductRef: null,
    returnedQuantity: '0',
    returnableQuantity: '3.000000',
    ...overrides,
  };
}

/** A full contract `Sale` with two lines (3 × 15.00 and 1 × 20.00). */
export function saleBody(overrides: Partial<ContractSale> = {}): ContractSale {
  return {
    saleRef: SALE_REF,
    storeId: '0190f5a2-0000-7000-8000-000000000001',
    currencyCode: 'EGP',
    posTotal: '65.0000',
    occurredAt: '2026-10-04T09:00:00.000Z',
    receivedAt: '2026-10-04T09:00:01.000Z',
    businessDate: '2026-10-04',
    processedAt: null,
    sourceClockAt: null,
    sourceSystem: 'pos-pulse',
    externalId: 'pos-pulse:handoff-sale-1',
    mismatchFlag: false,
    syncStatus: 'synced',
    voided: false,
    tenders: [{ method: 'cash', amount: '65.0000' }],
    lines: [
      saleLine(),
      saleLine({
        lineRef: LINE_B,
        lineName: 'Vitamin C',
        unitPrice: '20.0000',
        quantity: '1',
        lineAmount: '20.0000',
        returnableQuantity: '1.000000',
      }),
    ],
    ...overrides,
  };
}

interface SentReturnBody {
  externalId: string;
  lines: { lineRef: string; quantity: string }[];
  refundTenders: { method: 'cash'; amount: string }[];
}

/** The contract `SaleReturn` Backend-Core would answer for a request body. */
export function saleReturnFor(body: SentReturnBody, returnRef = RETURN_REF): ContractSaleReturn {
  const total = body.refundTenders[0]?.amount ?? '0.00';
  return {
    returnRef,
    saleRef: SALE_REF,
    recordedAt: '2026-10-04T10:00:02.000Z',
    businessDate: '2026-10-04',
    sourceSystem: 'pos-pulse',
    externalId: body.externalId,
    currencyCode: 'EGP',
    returnTotal: `${total}00`,
    lines: body.lines.map((l) => ({
      lineRef: l.lineRef,
      quantity: `${l.quantity}.000000`,
      lineAmount: total,
      taxAmount: null,
      returnedQuantity: `${l.quantity}.000000`,
      returnableQuantity: '0.000000',
    })),
    refundTenders: body.refundTenders,
    reason: null,
  };
}

export function errorBody(code: string): ContractError {
  return {
    error: { code, message: 'refused', request_id: '0190f5a2-0000-7000-8000-0000000000ee' },
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** RT-1543: how the fake answers `recordRefundExecution`; defaults to the idempotent recorder. */
export type ExecutionResponder = (
  call: RecordedCall,
  backend: FakeBackend,
) => Response | Promise<Response>;

/** The execution a fake Backend-Core has recorded (the contract's `RefundExecution` fields). */
export interface RecordedExecution {
  readonly executionRef: string;
  readonly returnRef: string;
  readonly saleRef: string;
  readonly allocationRef: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly instrument: 'cash';
  readonly amount: string;
  readonly currencyCode: string;
  readonly outcome: 'settled';
  readonly evidence: { method: string; paidAt: string; shiftRef: string };
  readonly recordedAt: string;
}

export type ReturnResponder = (
  call: RecordedCall,
  backend: FakeBackend,
) => Response | Promise<Response>;

/** RT-1498 close slice: how the fake answers `readReturnStatusByProvenance`. */
export type StatusResponder = (
  call: RecordedCall,
  backend: FakeBackend,
) => Response | Promise<Response>;

/** The route of the affirmative status read (RT-1548). */
const STATUS_ROUTE = '/returns/by-provenance/status';

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A copy of `value` without `keys` (to build contract bodies missing optional fields). */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k as K))) as Omit<
    T,
    K
  >;
}

/** The request as the fake backend records it. */
function recordCall(input: RequestInfo | URL, init: RequestInit = {}): RecordedCall {
  return {
    url: urlOf(input),
    method: init.method ?? 'GET',
    headers: { ...(init.headers as Record<string, string> | undefined) },
    body: typeof init.body === 'string' ? init.body : undefined,
  };
}

/** In-memory Backend-Core POS sales surface. */
export class FakeBackend {
  readonly calls: RecordedCall[] = [];
  /** The `readSale` answer (a body → 200, a Response → as given). */
  sale: ContractSale | Response = saleBody();
  /** How `recordReturn` answers; defaults to the idempotent recorder below. */
  onReturn: ReturnResponder = (call, backend) => backend.recordIdempotently(call);
  /** RT-1543: how `recordRefundExecution` answers; defaults to the idempotent recorder. */
  onExecution: ExecutionResponder = (call, backend) => backend.recordExecutionIdempotently(call);
  /** RT-1543: executions recorded so far, by Idempotency-Key. */
  readonly executions = new Map<string, RecordedExecution>();
  /** Runs while a readSale GET is in flight (to change the session mid-request). */
  onRead: (() => void) | null = null;
  /** When set, the `readSale` answer per requested saleRef (else `sale`). */
  saleFor: ((saleRef: string) => ContractSale) | null = null;
  /** When set, awaited before a readSale GET is answered (network latency). */
  readLatency: (() => Promise<void>) | null = null;
  /** Returns recorded so far, by Idempotency-Key. */
  readonly recorded = new Map<string, ContractSaleReturn>();
  /**
   * RT-1498 close slice: how `readReturnStatusByProvenance` answers; defaults to the verdict the fake's
   * own `recorded` map implies (`recorded` for a key it recorded, else `not_recorded`).
   */
  onStatus: StatusResponder = (call, backend) => backend.answerStatus(call);

  /** Method-keyed routes of the fake POS sales surface. */
  private readonly routes: Readonly<Record<string, (call: RecordedCall) => Promise<Response>>> = {
    GET: async (call) => {
      if (call.url.includes(STATUS_ROUTE)) return await this.onStatus(call, this);
      if (this.readLatency !== null) await this.readLatency();
      return this.answerRead(call);
    },
    POST: async (call) =>
      call.url.endsWith('/executions')
        ? await this.onExecution(call, this)
        : await this.onReturn(call, this),
  };

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = recordCall(input, init);
    this.calls.push(call);
    const route = this.routes[call.method];
    if (route === undefined) throw new Error(`FakeBackend: unexpected ${call.method}`);
    return await route(call);
  };

  /** The `readSale` answer; `onRead` runs while it is "in flight". */
  private answerRead(call: RecordedCall): Response {
    this.onRead?.();
    const saleRef = /\/sales\/([^/]+)$/.exec(call.url)?.[1] ?? '';
    const sale = this.saleFor?.(saleRef) ?? this.sale;
    return sale instanceof Response ? sale : jsonResponse(200, sale);
  }

  /** The affirmative verdict for the provenance in the query, from what this fake has recorded. */
  answerStatus(call: RecordedCall): Response {
    const key = new URL(call.url).searchParams.get('externalId') ?? '';
    const recorded = this.recorded.get(key);
    return recorded === undefined
      ? jsonResponse(200, { status: 'not_recorded' })
      : jsonResponse(200, { status: 'recorded', creditLinked: false, saleReturn: recorded });
  }

  /** The status reads, in order. */
  statusCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'GET' && c.url.includes(STATUS_ROUTE));
  }

  /** 201 the first time a key is seen; a same-key retry replays it (RT-82 K4). */
  recordIdempotently(call: RecordedCall): Response {
    const key = call.headers['Idempotency-Key'] ?? '';
    const existing = this.recorded.get(key);
    if (existing !== undefined) {
      return jsonResponse(201, existing, { 'Idempotent-Replayed': 'true' });
    }
    // The return is against the sale named in the path (…/sales/{saleRef}/returns).
    const saleRef = /\/sales\/([^/]+)\/returns$/.exec(call.url)?.[1] ?? SALE_REF;
    const created = { ...saleReturnFor(JSON.parse(call.body ?? '{}') as SentReturnBody), saleRef };
    this.recorded.set(key, created);
    return jsonResponse(201, created);
  }

  /** 201 the first time an execution key is seen; a same-key retry replays it. */
  recordExecutionIdempotently(call: RecordedCall): Response {
    const key = call.headers['Idempotency-Key'] ?? '';
    const existing = this.executions.get(key);
    if (existing !== undefined) {
      return jsonResponse(201, existing, { 'Idempotent-Replayed': 'true' });
    }
    const match = /\/sales\/([^/]+)\/returns\/([^/]+)\/executions$/.exec(call.url);
    const body = JSON.parse(call.body ?? '{}') as Omit<
      RecordedExecution,
      'returnRef' | 'saleRef' | 'instrument' | 'currencyCode' | 'recordedAt'
    >;
    const created: RecordedExecution = {
      ...body,
      saleRef: match?.[1] ?? SALE_REF,
      returnRef: match?.[2] ?? RETURN_REF,
      instrument: 'cash',
      currencyCode: 'EGP',
      recordedAt: '2026-10-04T10:00:03.000Z',
    };
    this.executions.set(key, created);
    return jsonResponse(201, created);
  }

  /** The return POSTs (`.../returns`), never the executions' (RT-1543). */
  returnCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/executions'));
  }

  /** RT-1543: the execution POSTs, in order. */
  executionCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/executions'));
  }
}

export interface SeedSyncedSaleInput {
  readonly saleId?: string;
  /** null = synced without a stored saleRef (pre-S1); undefined = SALE_REF. */
  readonly saleRef?: string | null;
  readonly syncStatus?: 'synced' | 'pending';
  readonly tenderSummary?: string;
  /** The server sale whose lines the local frozen snapshot must match (default saleBody()). */
  readonly sale?: ContractSale;
}

/**
 * The till's frozen `lines_json` for a server sale — the inverse of what
 * capture sent (whole quantity, unit price and line amount in minor units).
 */
export function snapshotFor(sale: ContractSale): string {
  const minor = (v: string): number | null => amount4ToMinor(parseAmount4(v) ?? -1n, 2);
  return JSON.stringify(
    sale.lines.map((l) => ({
      line_id: `local-${l.lineRef}`,
      item_ref: 'p-1',
      display_name: l.lineName,
      quantity: parseWholeQuantity(l.quantity),
      unit_price_minor: minor(l.unitPrice),
      line_subtotal_minor: minor(l.lineAmount),
    })),
  );
}

/** A finalized local sale plus its sale_sync_state row. */
export function seedSyncedSale(db: SqlJsDatabase, input: SeedSyncedSaleInput = {}): void {
  const saleId = input.saleId ?? SALE_ID;
  seedSale(db, {
    sale_id: saleId,
    terminal_id: SCOPE.terminalId,
    tender_lines_summary_json: input.tenderSummary ?? CASH_SUMMARY,
    lines_json: snapshotFor(input.sale ?? saleBody()),
  });
  db.run(
    `INSERT INTO sale_sync_state (sale_id, tenant_id, branch_id, sync_status, attempt_count,
       synced_at, created_at, updated_at, server_sale_ref)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      saleId,
      SCOPE.tenantId,
      SCOPE.branchId,
      input.syncStatus ?? 'synced',
      NOW,
      NOW,
      NOW,
      input.saleRef === undefined ? SALE_REF : input.saleRef,
    ],
  );
}

export interface HarnessOptions {
  readonly enabled?: boolean;
  readonly role?: Role | null;
  readonly token?: string | null;
  readonly timeoutMs?: number;
  /** RT-1403 S2 (M1): the one drawer slot the void payout shares. */
  readonly drawerSlot?: DrawerSlot;
  /**
   * RT-1543 follow-up: read the open shift and the claim-time shift from the REAL shift cash-up
   * repository on the harness database (not from `state.shiftRef`), so a test can open, close and
   * force-close shifts with the real shift cash-up service and see the payout follow them.
   */
  readonly realShifts?: boolean;
  /**
   * RT-1498 close slice: the status-read availability the composed domain notes each read in. A test
   * that mints close approvals builds its approval resolver on the same object (`closeAvailable`).
   */
  readonly statusAvailability?: StatusReadAvailability;
  /**
   * RT-1498 S4/S5: the manager approvals and the live operator's `users.id` the escalation spends,
   * built over the harness's database and state. Absent: no escalation is composed (it refuses).
   */
  readonly escalation?: (context: {
    readonly handle: DatabaseHandle;
    readonly state: HarnessState;
  }) => ComposeReturnsDeps['escalation'];
  /** RT-1498 (`0073`): optional live operator `users.id` reader wired into `composeReturns`. */
  readonly actorUserId?: (context: {
    readonly handle: DatabaseHandle;
    readonly state: HarnessState;
  }) => string | null;
}

export interface HarnessState {
  enabled: boolean;
  role: Role | null;
  token: string | null;
  /** The terminal is paired (the live pairing read; unpaired → no session scope). */
  paired: boolean;
  /** The operator session is inactivity-locked. */
  locked: boolean;
  /** The live paired terminal id. */
  terminalId: string;
  /** RT-1543: the terminal's open shift id; null = no shift open. */
  shiftRef: string | null;
  /** RT-1543: shift cash-up is enabled on this till (`POS_PULSE_FEATURE_SHIFT_CASHUP`). */
  shiftCashup: boolean;
  /**
   * RT-1543 follow-up: the shift that was open when the payout was claimed, as the (fake) shift
   * records answer it (null: none). Read only when no shift is open now. Ignored with `realShifts`.
   */
  claimShiftRef: string | null;
  /** RT-1543 follow-up: the shift read throws (fault injection). */
  failShiftRead: boolean;
  /** RT-1543 follow-up: the shift cash-up flag read throws (fault injection). */
  failFlagRead: boolean;
  /** The domain clock (ISO-8601), read per call; starts at `NOW`. */
  now: string;
  /** RT-1498 close slice: the monotonic clock (ms) of the quiet period; see `elapse`. */
  mono: number;
  /** Runs on every audit emit, before it is written (to change state mid-flow). */
  onAudit: ((event: AuditEvent) => void) | null;
  /** When it returns true for an event, that audit insert throws (fault injection). */
  failAudit: ((event: AuditEvent) => boolean) | null;
}

export interface ReturnsHarness extends ComposedReturns {
  /** RT-15 S4: the drawer and printer the payout uses. */
  readonly drawer: FakeDrawer;
  readonly printer: FakePrinter;
  /**
   * RT-15 S4: the app crashed and started again. Latches the latest domain
   * stopped (an in-flight await then writes nothing) and composes a fresh
   * domain over the SAME database, drawer and printer.
   */
  restart(): ComposedReturns;
  /**
   * RT-15 S4 (Codex P1 lease): a second app instance on the SAME database,
   * alive at the same time (no single-instance lock); same drawer and printer.
   */
  anotherInstance(): ComposedReturns;
  /**
   * RT-198: every process composed so far; `deadTouches` counts each time a
   * dead (crashed) one touched its database, audit sink or session read —
   * each such touch is refused, as a closed DB would refuse it;
   * `sessionReadsAfterStop` counts each session read by a stopped (live)
   * domain — refused too: in the app the DB closes right after stop, and the
   * session read goes through it (the pairing store).
   */
  readonly lives: Pick<Lives, 'deadTouches' | 'sessionReadsAfterStop'>;
  readonly db: SqlJsDatabase;
  readonly handle: DatabaseHandle;
  readonly repo: ReturnsRepository;
  /** RT-1498 S4: the dispositions of the journal's returns (migration 0070). */
  readonly dispositions: ReturnDispositionsRepository;
  readonly backend: FakeBackend;
  /** The production audit path: 004's validating emitter into `audit_events`. */
  readonly auditSink: ReturnsAuditSink;
  /** The audit rows actually committed to `audit_events`, in insert order. */
  readonly audits: AuditEvent[];
  readonly warnings: string[];
  /** RT-1543: every warning with its structured fields, in order. */
  readonly logs: readonly { readonly msg: string; readonly obj: Record<string, unknown> }[];
  /** Mutable session / flag / token / fault, read per call like production. */
  readonly state: HarnessState;
  close(): void;
}

/** Rows inserted, updated or deleted on the connection so far, in any table (SQLite). */
export function totalChanges(db: SqlJsDatabase): number {
  return Number(db.exec('SELECT total_changes()')[0]?.values[0]?.[0] ?? 0);
}

/** Every committed `audit_events` row, in insert order, payload parsed. */
export function committedAudits(db: SqlJsDatabase): AuditEvent[] {
  const res = db.exec('SELECT * FROM audit_events ORDER BY rowid')[0];
  if (res === undefined) return [];
  return res.values.map((row) => {
    const rec = Object.fromEntries(res.columns.map((c, i) => [c, row[i]]));
    return {
      ...rec,
      payload: JSON.parse(String(rec['payload'])) as Record<string, unknown>,
    } as AuditEvent;
  });
}

/** The composed return domain over a fresh DB and a FakeBackend. */
export function returnsHarness(options: HarnessOptions = {}): ReturnsHarness {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const backend = new FakeBackend();
  const warnings: string[] = [];
  const logs: { msg: string; obj: Record<string, unknown> }[] = [];
  const state: HarnessState = {
    enabled: options.enabled ?? true,
    role: options.role === undefined ? 'manager' : options.role,
    token: options.token === undefined ? ENVELOPE : options.token,
    paired: true,
    locked: false,
    terminalId: SCOPE.terminalId,
    shiftRef: SHIFT_REF,
    shiftCashup: true,
    claimShiftRef: null,
    failShiftRead: false,
    failFlagRead: false,
    now: NOW,
    mono: 1_000,
    onAudit: null,
    failAudit: null,
  };
  const emitter = new AuditEmitter(bindAuditEventsStoreDb(handle));
  const auditSink: ReturnsAuditSink = {
    emit: (event) => {
      state.onAudit?.(event);
      if (state.failAudit?.(event) === true) throw new Error('audit insert failed');
      emitter.emit(event);
    },
  };
  const drawer = new FakeDrawer();
  const printer = new FakePrinter();
  const shiftRecords = createShiftCashupRepo(handle);
  const escalation = options.escalation?.({ handle, state });
  const escalationOf = (): Pick<ComposeReturnsDeps, 'escalation'> =>
    escalation === undefined ? {} : { escalation };
  const actorUserIdOf = (): Pick<ComposeReturnsDeps, 'getActorUserId'> =>
    options.actorUserId === undefined
      ? {}
      : { getActorUserId: () => options.actorUserId?.({ handle, state }) ?? null };
  let killLatest: () => void = () => undefined;
  const lives = new Lives();
  const compose = (): ComposedReturns => {
    const life = lives.next();
    killLatest = () => {
      life.alive = false;
    };
    const domain = composeReturns({
      db: whileAlive(handle, life),
      http: { baseUrl: BASE_URL, fetch: backend.fetch },
      getOperatorEnvelope: () => state.token,
      isEnabled: () => state.enabled,
      // In the app this reads the pairing store (the DB): never after stop.
      getSession: () => {
        assertSessionReadable(life);
        return state.role === null || !state.paired
          ? null
          : {
              ...sessionFor(state.role),
              ...(options.actorUserId === undefined ? {} : { user_id: null }),
              terminal_id: state.terminalId,
            };
      },
      ...actorUserIdOf(),
      isSessionLocked: () => state.locked,
      auditSink: whileAlive(auditSink, life),
      logger: {
        warn: (obj, msg) => {
          warnings.push(msg);
          logs.push({ msg, obj });
        },
        error: (_obj, msg) => warnings.push(msg),
      },
      now: () => state.now,
      // RT-1498 close slice: the quiet period reads the domain clock as its wall clock and `state.mono`.
      clocks: { wall: () => Date.parse(state.now), mono: () => state.mono },
      ...(options.statusAvailability === undefined
        ? {}
        : { statusAvailability: options.statusAvailability }),
      drawer,
      ...(options.drawerSlot === undefined ? {} : { drawerSlot: options.drawerSlot }),
      printer,
      openShiftRef: (scope) => {
        if (state.failShiftRead) throw new Error('shift read failed');
        return options.realShifts === true ? openShiftRefOf(shiftRecords)(scope) : state.shiftRef;
      },
      shiftRefAt: (scope, at) =>
        options.realShifts === true ? shiftRefAtOf(shiftRecords)(scope, at) : state.claimShiftRef,
      isShiftCashupEnabled: () => {
        if (state.failFlagRead) throw new Error('flag read failed');
        return state.shiftCashup;
      },
      ...escalationOf(),
    });
    return {
      ...domain,
      stop: () => {
        life.stopped = true;
        domain.stop();
      },
    };
  };
  const composed = compose();
  let latest = composed;
  return {
    ...composed,
    drawer,
    printer,
    anotherInstance: () => {
      // A second app process on the same database, running at the same time.
      const keep = killLatest;
      const other = compose();
      killLatest = keep;
      return other;
    },
    restart: () => {
      latest.stop();
      // A dead process cannot write: everything the old domain still holds
      // (DB handle, statements, audit sink) now throws, as a closed DB does.
      killLatest();
      latest = compose();
      return latest;
    },
    lives,
    db,
    handle,
    repo: createReturnsRepository(handle),
    dispositions: createReturnDispositionsRepository(handle),
    backend,
    auditSink,
    get audits() {
      return committedAudits(db);
    },
    warnings,
    logs,
    state,
    close: () => {
      db.close();
    },
  };
}

/**
 * RT-15 S4 — journal and confirm one return of one unit of LINE_A through the
 * real submit path (FakeBackend records it); its return id.
 */
export async function confirmedReturn(
  service: Pick<ComposedReturns['service'], 'submit'>,
  saleNumber = SALE_NUMBER,
): Promise<string> {
  const res = await service.submit({ saleNumber, lines: [{ lineRef: LINE_A, quantity: 1 }] });
  if (res.kind !== 'confirmed') throw new Error(`confirmedReturn: ${res.kind}`);
  return res.ret.returnId;
}

/** One composed process: alive until it crashes; what it touched after that. */
interface Life {
  alive: boolean;
  /** Its domain was stopped (the app quits: the DB closes right after). */
  stopped: boolean;
  deadTouches: number;
  sessionReadsAfterStop: number;
}

/** Every process composed over one database, and what the dead ones touched. */
class Lives {
  private readonly all: Life[] = [];

  next(): Life {
    const life = { alive: true, stopped: false, deadTouches: 0, sessionReadsAfterStop: 0 };
    this.all.push(life);
    return life;
  }

  get deadTouches(): number {
    return this.all.reduce((n, life) => n + life.deadTouches, 0);
  }

  get sessionReadsAfterStop(): number {
    return this.all.reduce((n, life) => n + life.sessionReadsAfterStop, 0);
  }
}

/** A dead process cannot touch anything: count the attempt, then refuse it. */
function assertAlive(life: Life): void {
  if (life.alive) return;
  life.deadTouches += 1;
  throw new Error('the process is gone');
}

/**
 * RT-198: the session read goes through the DB in the app, which closes right
 * after stop: count it and refuse it once the domain is stopped (or dead).
 */
function assertSessionReadable(life: Life): void {
  assertAlive(life);
  if (!life.stopped) return;
  life.sessionReadsAfterStop += 1;
  throw new Error('database connection is not open');
}

/**
 * `target`, usable only while `life.alive`: every method call (and every
 * function or object such a call returns: a transaction, a statement) throws
 * once the process is dead, and is counted (`deadTouches`).
 */
function whileAlive<T extends object>(target: T, life: Life): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        assertAlive(life);
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(obj, args);
        if (typeof result === 'function') {
          return whileAlive(result as (...a: unknown[]) => unknown, life);
        }
        return typeof result === 'object' && result !== null ? whileAlive(result, life) : result;
      };
    },
    apply(fn, thisArg, args) {
      assertAlive(life);
      return Reflect.apply(fn as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
}

/** A promise a test settles by hand (an in-flight drawer kick or print). */
export function deferredFake<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * RT-1498 close slice: real time passes: the domain (wall) clock and the monotonic clock both move
 * `ms` forward. A test that steps ONLY `state.now` (or only `state.mono`) models a clock step.
 */
export function elapse(h: Pick<ReturnsHarness, 'state'>, ms: number): void {
  h.state.now = new Date(Date.parse(h.state.now) + ms).toISOString();
  h.state.mono += ms;
}

/** The audit categories written so far, in order. */
export function categories(audits: readonly AuditEvent[]): string[] {
  return audits.map((a) => a.action_category);
}
