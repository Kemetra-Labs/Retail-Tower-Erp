/**
 * RT-362 (G1, RT-264 D1: `tenderRef := tender_line_id`) — the tender-line
 * identity frozen into a sale's `tender_lines_summary_json` at finalize.
 *
 * Each applied line keeps its `tender_line_id` and a `sequence`: its 1-based
 * rank among the sale's applied lines by `apply_order` (refused lines use up
 * `apply_order` values too, so the raw value has gaps). An `apply_order` tie
 * is broken by `tender_line_id`, so a replay from the same durable rows ranks
 * the same.
 *
 * All lines or none: when any line lacks a usable identity the sale keeps the
 * legacy summary shape, which every reader (and RT-363's fallback) handles.
 */

export interface TenderLineIdentityInput {
  tender_line_id?: string | undefined;
  apply_order?: number | undefined;
}

export interface FrozenTenderLineIdentity {
  tender_line_id: string;
  /** 1-based rank of the line among the sale's applied lines, by `apply_order`. */
  sequence: number;
}

interface IdentifiedLine {
  tender_line_id: string;
  apply_order: number;
}

function isIdentified(line: TenderLineIdentityInput): line is IdentifiedLine {
  return (
    typeof line.tender_line_id === 'string' &&
    line.tender_line_id !== '' &&
    Number.isSafeInteger(line.apply_order) &&
    (line.apply_order as number) >= 1
  );
}

function byApplyOrderThenId(a: IdentifiedLine, b: IdentifiedLine): number {
  if (a.apply_order !== b.apply_order) return a.apply_order - b.apply_order;
  return a.tender_line_id < b.tender_line_id ? -1 : 1;
}

/**
 * The identity to freeze on each line, in input order, or `null` when the
 * lines cannot all be identified (missing or invalid id or `apply_order`, or
 * a duplicate id).
 */
export function freezeTenderLineIdentities(
  lines: readonly TenderLineIdentityInput[],
): FrozenTenderLineIdentity[] | null {
  if (!lines.every(isIdentified)) return null;
  if (new Set(lines.map((l) => l.tender_line_id)).size !== lines.length) return null;
  const ranked = [...lines].sort(byApplyOrderThenId);
  return lines.map((line) => ({
    tender_line_id: line.tender_line_id,
    sequence: ranked.indexOf(line) + 1,
  }));
}
