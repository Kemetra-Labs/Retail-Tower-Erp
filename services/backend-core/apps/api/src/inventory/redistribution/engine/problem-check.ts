/**
 * RT-1598 — the engine's input checks. A malformed problem is reported as violations (status `invalid`); the
 * engine never throws and never guesses.
 */
import { TRANSFER_LINE_MAX } from '../policy';
import { UNIT, parseQty } from '../quantity';
import type {
  BufferPolicyV1,
  RedistributionProblemV1,
  RedistributionRowV1,
  RedistributionViolationV1,
} from '../types';

const isPositiveInteger = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** The problem kind and limits; checked before the caps are compared (P-6). */
export function checkProblemShape(problem: RedistributionProblemV1): RedistributionViolationV1[] {
  const violations: RedistributionViolationV1[] = [];
  if (problem.kind !== 'store_redistribution' || problem.version !== 1) {
    violations.push({ code: 'input_unsupported_problem' });
  }
  const l = problem.limits;
  const usable =
    isPositiveInteger(l.maxStores) &&
    isPositiveInteger(l.maxRows) &&
    isPositiveInteger(l.deadlineMs) &&
    isPositiveInteger(l.maxLinesPerTransfer) &&
    l.maxLinesPerTransfer <= TRANSFER_LINE_MAX;
  if (!usable) violations.push({ code: 'input_invalid_limits' });
  return violations;
}

function isUsableBufferPolicy(policy: BufferPolicyV1): boolean {
  const minimum = parseQty(policy.minimum);
  return (
    minimum !== null &&
    // At least one stocking unit (P-10): with the inclusive floor, a source then always ends above its level.
    minimum >= UNIT &&
    Number.isInteger(policy.percentOfReorderLevel) &&
    policy.percentOfReorderLevel >= 0 &&
    policy.percentOfReorderLevel <= 100 &&
    (policy.rounding === 'scale' || policy.rounding === 'whole_unit')
  );
}

/** Stores, rows and quantities: one tenant, known stores, one row per (store, product), well-formed decimals. */
export function checkProblemInput(
  problem: RedistributionProblemV1,
  policy: BufferPolicyV1,
): RedistributionViolationV1[] {
  const violations: RedistributionViolationV1[] = [];
  if (!isUsableBufferPolicy(policy)) violations.push({ code: 'input_invalid_buffer_policy' });
  const storeIds = new Set<string>();
  for (const s of problem.stores) {
    if (storeIds.has(s.storeId)) violations.push({ code: 'input_duplicate_store', storeId: s.storeId });
    storeIds.add(s.storeId);
    if (s.tenantId !== problem.tenantId) violations.push({ code: 'input_tenant_mismatch', storeId: s.storeId });
  }
  const rowKeys = new Set<string>();
  for (const r of problem.rows) {
    const at = { storeId: r.storeId, productId: r.productId };
    if (!storeIds.has(r.storeId)) violations.push({ code: 'input_unknown_store', ...at });
    const key = `${r.storeId}\u0000${r.productId}`;
    if (rowKeys.has(key)) violations.push({ code: 'input_duplicate_row', ...at });
    rowKeys.add(key);
    const field = malformedField(r);
    if (field !== null) violations.push({ code: 'input_malformed_quantity', ...at, detail: field });
  }
  return violations;
}

/** The first field that is not a valid quantity for its role (ATS may be negative; the others may not). */
function malformedField(r: RedistributionRowV1): string | null {
  if (parseQty(r.availableToSell) === null) return 'availableToSell';
  if (r.reorderLevel !== null && !isNonNegative(r.reorderLevel)) return 'reorderLevel';
  if (!isNonNegative(r.openOutboundDraft)) return 'openOutboundDraft';
  if (!isNonNegative(r.openInbound)) return 'openInbound';
  return null;
}

function isNonNegative(value: string): boolean {
  const q = parseQty(value);
  return q !== null && q >= 0n;
}
