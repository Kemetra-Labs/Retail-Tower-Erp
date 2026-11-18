/**
 * CountLateCompensationService — Jira RT-1424 (RT-292 Gate 6, G6-5; Confluence page 78938114, conditions A to I).
 *
 * The explicit, authorized resolution of ONE late pre-cut event that an ERPNext count already absorbed. It writes a
 * Retail-only `count_correction` effect (the late event's signed quantity, negated, `compensates_effect_id` = the
 * count's correction), the effect's `erp_absorbed` integration state, the compensation record and one audit event, in
 * ONE tenant-context transaction. No ERP intent, work item or document is created, and nothing already written is
 * updated or deleted (771, DC-3, DC-6). It is never reached from a worker, an import, a posting outcome or a schedule.
 *
 * Order inside the transaction: lock the late event (one compensation per event, whichever session found it); a
 * replay returns the existing record and writes nothing (G); evaluate A to H from the evidence the Connector read
 * back (`late-compensation.rules.ts`); write; re-read the books and verify the invariants of condition I. ANY failure
 * throws, so the transaction rolls back whole: no compensation, the Health finding stays.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../database';
import { MembershipRepository } from '../../context/membership.repository';
import { writeAudit } from '../position-events/position-event.writer';
import { assertCountSessionsEnabled, loadSession, type FindingCompensation } from './count-session.store';
import {
  COMPENSATION_ROLES,
  compensationKey,
  dec,
  evaluateCompensation,
  type CompensationRefusalCode,
} from './late-compensation.rules';
import {
  findCompensation,
  loadEvidence,
  loadFinding,
  lockLateEvent,
  readBook,
  writeCompensation,
  type CompensationRow,
} from './late-compensation.store';

export interface CountCaller {
  readonly tenantId: string;
  readonly userId: string;
}

export type CompensationBody = FindingCompensation;

const AUDIT_TARGET = 'count_session';

export function compensationBody(row: CompensationRow, findingId: string): CompensationBody {
  let document: CompensationBody['absorbingDocument'] = null;
  try {
    const v = JSON.parse(row.absorbing_document_ref) as { doctype?: unknown; name?: unknown };
    if (typeof v.doctype === 'string' && typeof v.name === 'string') document = { doctype: v.doctype, name: v.name };
  } catch {
    document = null;
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    findingId,
    lateEffectId: row.late_effect_id,
    countEffectId: row.count_effect_id,
    compensationEffectId: row.compensation_effect_id,
    quantity: row.quantity,
    absorbingDocument: document,
    integrationState: 'erp_absorbed',
    reason: row.reason,
    approvedBy: row.approved_by,
    createdAt: row.created_at.toISOString(),
  };
}

function refusal(code: CompensationRefusalCode, message: string, condition: string): ConflictException {
  return new ConflictException({ code, message, condition });
}

@Injectable()
export class CountLateCompensationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  async resolve(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    findingId: string,
    reasonInput: string,
  ): Promise<CompensationBody> {
    // E: the reason is mandatory and recorded with the audit event.
    const reason = reasonInput.trim();
    if (reason.length < 1 || reason.length > 500) {
      throw new BadRequestException({ code: 'validation_error', message: 'A reason of 1 to 500 characters is required.' });
    }
    return await runWithTenantContext(
      this.pool,
      { tenantId: caller.tenantId, isPlatformAdmin: false },
      async (client) => {
        await assertCountSessionsEnabled(client, caller.tenantId);
        // E: the caller's OWN role in this tenant, so a platform admin (whom the route guard admits first) or a
        // store_manager is refused; there is no platform override of this resolution.
        const role = await this.memberships.findRoleCodeForUserInTenant(caller.userId, caller.tenantId, client);
        if (role === null || !(COMPENSATION_ROLES as readonly string[]).includes(role)) {
          throw new ForbiddenException({
            code: 'count_compensation_role_forbidden',
            message: 'Only the tenant owner or a tenant admin can resolve a late event.',
          });
        }
        return await this.resolveInTransaction(client, caller, storeId, sessionId, findingId, reason);
      },
    );
  }

  private async resolveInTransaction(
    client: PoolClient,
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    findingId: string,
    reason: string,
  ): Promise<CompensationBody> {
    const session = await loadSession(client, storeId, sessionId, true);
    if (!session) throw new NotFoundException('Not Found');
    const finding = await loadFinding(client, sessionId, findingId);
    if (!finding || finding.store_id !== storeId || finding.tenant_id !== caller.tenantId) {
      throw new NotFoundException('Not Found');
    }
    await lockLateEvent(client, caller.tenantId, finding.effect_id);

    // G: a replay or a concurrent retry returns the existing effect and writes nothing; a compensation of the same
    // late event under another session blocks any second one.
    const existing = await findCompensation(client, caller.tenantId, finding.effect_id);
    if (existing) {
      if (existing.session_id === sessionId) return compensationBody(existing, finding.id);
      throw refusal('compensation_already_exists', 'This late event was already compensated by another session.', 'G');
    }

    const evidence = await loadEvidence(client, session, finding);
    const plan = evaluateCompensation(evidence);
    if (!plan.ok) throw refusal(plan.code, plan.message, plan.condition);
    const late = evidence.late!;
    const key = compensationKey({ sessionId, countEffectId: plan.countEffectId, lateEffectId: finding.effect_id });

    const before = await readBook(client, storeId);
    const written = await writeCompensation(client, {
      tenantId: caller.tenantId,
      storeId,
      sessionId,
      finding,
      plan,
      lateUnit: late.unit,
      locationId: late.locationId,
      status: late.status,
      stockCountId: evidence.stockCountId!,
      approvedBy: caller.userId,
      reason,
      key,
    });

    // I: every invariant, in this transaction, before commit; a failure throws and rolls everything back.
    const after = await readBook(client, storeId);
    const problem = checkInvariants(before, after, finding.tenant_product_ref, plan.quantity, plan.projectedExpected, evidence.bin!.quantity);
    if (problem !== null) throw refusal('compensation_invariant_failed', problem, 'I');
    const written1 = await client.query<{ effects: string; states: string }>(
      `SELECT (SELECT count(*) FROM stock_movements WHERE id = $1 AND tenant_product_ref = $2 AND store_id = $3)::text AS effects,
              (SELECT count(*) FROM inventory_effect_integration WHERE effect_id = $1 AND state = 'erp_absorbed')::text AS states`,
      [written.effectId, finding.tenant_product_ref, storeId],
    );
    if (written1.rows[0]?.effects !== '1' || written1.rows[0]?.states !== '1') {
      throw refusal('compensation_invariant_failed', 'The compensation is not exactly one effect with one integration row.', 'I');
    }
    const copies = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM count_late_compensations WHERE tenant_id = $1 AND late_effect_id = $2`,
      [caller.tenantId, finding.effect_id],
    );
    if (copies.rows[0]?.n !== '1') {
      throw refusal('compensation_invariant_failed', 'More than one compensation exists for the late event.', 'I');
    }

    await writeAudit(client, {
      tenantId: caller.tenantId,
      userId: caller.userId,
      action: 'inventory.count_session.late_compensation',
      targetType: AUDIT_TARGET,
      targetId: sessionId,
      metadata: {
        storeId,
        findingId: finding.id,
        lateEffectId: finding.effect_id,
        countEffectId: plan.countEffectId,
        compensationEffectId: written.effectId,
        quantity: plan.quantity,
        absorbingDocument: plan.absorbingDocument,
        reason,
        evidence: plan.evidence,
        erpDocumentCreated: false,
      },
    });
    return compensationBody(written.row, finding.id);
  }
}

type Book = Awaited<ReturnType<typeof readBook>>;

/** Condition I (1) to (3), on the compensated line; (4) is checked on what the transaction wrote. Returns the first violated invariant's description, or null. */
export function checkInvariants(
  before: Book,
  after: Book,
  productId: string,
  quantity: string,
  projectedExpected: string,
  binQuantity: string,
): string | null {
  const was = before.get(productId);
  const now = after.get(productId);
  if (!was || !now) return 'The line has no pending-aware position.';
  // (1) operational position equals the projected expected book and the Bin read in D.
  if (dec(now.operationalPosition) !== dec(projectedExpected) || dec(projectedExpected) !== dec(binQuantity)) {
    return 'The operational position does not equal the projected expected ERP book and the Bin.';
  }
  if (dec(now.expectedErpBook) !== dec(projectedExpected)) return 'The expected ERP book is not the projected value.';
  // (2) no pending ERP term and no pending Retail term was added.
  if (dec(now.pendingErp) !== dec(was.pendingErp) || dec(now.pendingRetail) !== dec(was.pendingRetail)) {
    return 'The compensation changed a pending ERP or pending Retail term.';
  }
  if (dec(now.operationalPosition) - dec(was.operationalPosition) !== dec(quantity)) {
    return 'The operational position moved by more than the compensation.';
  }
  // (4) no other line, bucket or tenant changes is guaranteed by what the transaction writes (exactly one effect and
  // one integration row, verified by `checkWritten` against the database); it is not read back from the live book of
  // the whole store, which unrelated traffic committing in between would move.
  return null;
}
