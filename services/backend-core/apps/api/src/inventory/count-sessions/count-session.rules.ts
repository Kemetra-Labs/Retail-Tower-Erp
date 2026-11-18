/**
 * Count Session rules — Jira RT-1420 (RT-292 Gate 6; Confluence "Inventory
 * Gate 6", page 78938114). PURE: no I/O. The service applies these decisions
 * inside one tenant transaction.
 *
 * Lifecycle reached by a command here:
 *   open --cut--> cut_taken --submit--> submitted --approve--> approved
 *   submitted --recount--> cut_taken (listed lines reset)
 *   open | cut_taken | submitted --cancel--> cancelled
 * `posting`, `confirmed`, `needs_attention` and `closed` are set only by later
 * slices (and `needs_attention` by a late event after approval); no command
 * here leaves `approved`.
 */
import { formatQuantity, parseQuantity } from '../../common/quantity/decimal-quantity';

export const COUNT_SESSION_STATES = [
  'open',
  'cut_taken',
  'submitted',
  'approved',
  'posting',
  'confirmed',
  'needs_attention',
  'closed',
  'cancelled',
] as const;
export type CountSessionState = (typeof COUNT_SESSION_STATES)[number];

export type CountCommand = 'observe' | 'cut' | 'submit' | 'recount' | 'approve' | 'cancel';

const ALLOWED_FROM: Readonly<Record<CountCommand, readonly CountSessionState[]>> = {
  observe: ['open', 'cut_taken'],
  cut: ['open'],
  submit: ['cut_taken'],
  recount: ['submitted'],
  approve: ['submitted'],
  cancel: ['open', 'cut_taken', 'submitted'],
};

const TARGET: Readonly<Record<CountCommand, CountSessionState | null>> = {
  observe: null,
  cut: 'cut_taken',
  submit: 'submitted',
  recount: 'cut_taken',
  approve: 'approved',
  cancel: 'cancelled',
};

/** A refusal with a stable machine code of the existing error envelope. */
export class CountRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function canApply(state: CountSessionState, command: CountCommand): boolean {
  return ALLOWED_FROM[command].includes(state);
}

/** The state a command leaves the session in (the same state for `observe`). */
export function nextState(state: CountSessionState, command: CountCommand): CountSessionState {
  if (!canApply(state, command)) {
    throw new CountRuleError(
      'count_session_not_in_state',
      `${command} is not allowed while the session is ${state}.`,
    );
  }
  return TARGET[command] ?? state;
}

// ---- Variance (decision 831: counted minus expected at the cut) -----------

export interface LineQuantities {
  readonly expectedTotal: string;
  readonly countedTotal: string;
  readonly varianceQuantity: string;
}

/** Sum position quantities exactly; refuses a total that leaves numeric(19,4) or 15 integer digits. */
export function sumQuantities(values: readonly string[], field: string): string {
  const total = values.reduce((acc, v) => acc + parseQuantity(v, field), 0n);
  return formatInRange(total, field);
}

function formatInRange(scaled: bigint, field: string): string {
  let text: string;
  try {
    text = formatQuantity(scaled, field);
  } catch {
    throw new CountRuleError('validation_error', `${field} exceeds the numeric(19,4) range.`);
  }
  if (text.replace('-', '').split('.')[0]!.length > 15) {
    throw new CountRuleError('validation_error', `${field} exceeds 15 integer digits.`);
  }
  return text;
}

export function lineQuantities(
  expectedTotal: string,
  countedPositions: readonly string[],
): LineQuantities {
  const counted = parseQuantity(
    sumQuantities(countedPositions, 'countedQuantity'),
    'countedQuantity',
  );
  const expected = parseQuantity(expectedTotal, 'expectedQuantity');
  return {
    expectedTotal: formatQuantity(expected),
    countedTotal: formatQuantity(counted),
    varianceQuantity: formatInRange(counted - expected, 'varianceQuantity'),
  };
}

interface PositionKey {
  readonly locationId: string;
  readonly inventoryStatus: string;
}
export interface PositionQuantity extends PositionKey {
  readonly quantity: string;
}

/**
 * The Retail correction per position (G6-1, decision 833): counted minus
 * expected at that position, for every position that was observed or held
 * stock at the cut. A position left out of the count is counted as 0. The
 * deltas sum to the product's variance. Zero deltas write nothing.
 */
export function positionCorrections(
  expected: readonly PositionQuantity[],
  observed: readonly PositionQuantity[],
): PositionQuantity[] {
  const key = (p: PositionKey): string => `${p.locationId}|${p.inventoryStatus}`;
  const positions = new Map<string, { exp: bigint; obs: bigint; p: PositionKey }>();
  for (const e of expected) {
    positions.set(key(e), { exp: parseQuantity(e.quantity), obs: 0n, p: e });
  }
  for (const o of observed) {
    const cur = positions.get(key(o)) ?? { exp: 0n, obs: 0n, p: o };
    positions.set(key(o), { ...cur, obs: parseQuantity(o.quantity) });
  }
  return [...positions.values()]
    .map(({ exp, obs, p }) => ({
      locationId: p.locationId,
      inventoryStatus: p.inventoryStatus,
      delta: obs - exp,
    }))
    .filter((x) => x.delta !== 0n)
    .map((x) => ({
      locationId: x.locationId,
      inventoryStatus: x.inventoryStatus,
      quantity: formatQuantity(x.delta),
    }))
    .sort((a, b) =>
      (a.locationId + a.inventoryStatus).localeCompare(b.locationId + b.inventoryStatus),
    );
}

// ---- Flags and refusals (G6-2) --------------------------------------------

export const COUNT_VARIANCE_FLAGS = [
  'divergence',
  'stale_snapshot',
  'pending',
  'unmapped',
  'uom_mismatch',
] as const;
export type CountVarianceFlag = (typeof COUNT_VARIANCE_FLAGS)[number];

/** Flags that need an explicit acknowledgement before approval. */
const ACKNOWLEDGEABLE: readonly CountVarianceFlag[] = ['divergence', 'stale_snapshot', 'pending'];

export function needsAcknowledgement(flags: readonly CountVarianceFlag[]): boolean {
  return flags.some((f) => ACKNOWLEDGEABLE.includes(f));
}

export type CountRefusalCode =
  'count_up_without_valuation_history' | 'count_line_unmapped' | 'count_line_uom_mismatch';

/**
 * A line that cannot post (the rest proceeds). Unmapped and UOM mismatch cannot
 * be acknowledged into posting; a count-up (positive variance) of an item with
 * no stock or valuation history is refused because Retail never supplies a
 * valuation rate.
 */
export function refusalFor(input: {
  readonly flags: readonly CountVarianceFlag[];
  readonly varianceQuantity: string;
  readonly hasValuationHistory: boolean;
}): CountRefusalCode | null {
  if (input.flags.includes('unmapped')) return 'count_line_unmapped';
  if (input.flags.includes('uom_mismatch')) return 'count_line_uom_mismatch';
  if (parseQuantity(input.varianceQuantity) > 0n && !input.hasValuationHistory) {
    return 'count_up_without_valuation_history';
  }
  return null;
}

export interface AcknowledgementInput {
  readonly productId: string;
  readonly lineVersion: string;
}
export interface ReviewedLine {
  readonly productId: string;
  readonly lineVersion: string;
  readonly flags: readonly CountVarianceFlag[];
  readonly refusal: CountRefusalCode | null;
}

/**
 * Decide an approval against the reviewed lines. A stale acknowledgement (its
 * `lineVersion` no longer matches) is refused before a missing one, so a line
 * that changed after review is never approved on an old acknowledgement.
 * A refused line needs no acknowledgement (it cannot post anyway).
 */
export function checkAcknowledgements(
  lines: readonly ReviewedLine[],
  acknowledgements: readonly AcknowledgementInput[],
): void {
  const byProduct = new Map(acknowledgements.map((a) => [a.productId, a]));
  for (const ack of acknowledgements) {
    const line = lines.find((l) => l.productId === ack.productId);
    if (line && line.lineVersion !== ack.lineVersion) {
      throw new CountRuleError('count_line_version_stale', 'A line changed after it was reviewed.');
    }
  }
  for (const line of lines) {
    if (line.refusal !== null || !needsAcknowledgement(line.flags)) continue;
    const ack = byProduct.get(line.productId);
    if (!ack) {
      throw new CountRuleError(
        'count_flagged_line_not_acknowledged',
        'A flagged line needs an acknowledgement.',
      );
    }
  }
}

// ---- Approval policy (G6-10) ----------------------------------------------

type ApprovalPolicy = 'strict_separation' | 'small_merchant_exception';
export interface ApprovalOutcome {
  readonly policy: ApprovalPolicy;
  readonly selfApproved: boolean;
}

/**
 * Strict separation by default: the approver is none of the counters and not
 * the submitter. The tenant owner's audited exception lets them approve; the
 * session is then marked `selfApproved`. No threshold and no override.
 */
export function approvalOutcome(input: {
  readonly approverId: string;
  readonly counterIds: readonly string[];
  readonly submittedBy: string | null;
  readonly exceptionEnabled: boolean;
}): ApprovalOutcome {
  const conflicts =
    input.counterIds.includes(input.approverId) || input.submittedBy === input.approverId;
  if (!conflicts) return { policy: 'strict_separation', selfApproved: false };
  if (!input.exceptionEnabled) {
    throw new CountRuleError(
      'count_approver_conflict',
      'The approver counted or submitted this session and the small-merchant exception does not apply.',
    );
  }
  return { policy: 'small_merchant_exception', selfApproved: true };
}

// ---- Late pre-cut events (G6-4) --------------------------------------------

export interface LateAssessment {
  readonly assessment: 'understated' | 'overstated';
  readonly quantity: string;
  readonly oversellRisk: boolean;
}

/**
 * A late pre-cut effect of signed quantity `q`: the physical count already
 * reflects it but the frozen expected does not. A negative effect (a sale)
 * would be deducted a second time, so Retail availability is understated; a
 * positive one (a receipt) would be added a second time, so it is overstated
 * and selling is at risk of overselling.
 */
export function lateAssessment(signedQuantity: string): LateAssessment {
  const q = parseQuantity(signedQuantity);
  if (q === 0n)
    throw new CountRuleError('validation_error', 'A late event has a non-zero quantity.');
  return {
    assessment: q < 0n ? 'understated' : 'overstated',
    quantity: formatQuantity(q < 0n ? -q : q),
    oversellRisk: q > 0n,
  };
}
