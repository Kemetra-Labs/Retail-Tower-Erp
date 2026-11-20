/**
 * RT-1484 (RT-282 PR-10a, PR-4b; review round 1, M1, and round 3, MAJOR-1) — overlaps between the
 * lines of ONE Change Set. Spec 041 (spec.md, "DB exclusion constraint + Change Set validation")
 * keeps one price key free of overlaps; validation must catch a set that contradicts itself
 * before publish would hit the exclusion constraint. Pure.
 *
 * Lines are grouped by key: (scope, Zone or Store, product, Sell Unit) for priced, ended and reset
 * lines, and the Store for Zone moves. Within a group, compared in each time zone the two lines
 * apply in (the zones of the Stores they reach):
 *   - two priced lines (or two moves) conflict when their intervals overlap;
 *   - an end or reset is the instant T it takes effect, `[T, T+1ms)`: it conflicts with a priced
 *     line that is already in effect across T (starts before T and has not ended by T), and with
 *     another end or reset at the same instant. An end at T followed by a price from T, or a price
 *     after the end, is the normal "end, then re-price" and is valid.
 * Both lines of a conflict are `invalid` with `overlaps_line_in_set`; when their time bases differ
 * they also carry `mixed_time_basis` (spec 041 §4.3, Q-6: one key never mixes bases while active).
 */
import type { Interval } from "../resolution/resolve";
import { overlaps } from "./price-change-set-validation.types";
import { intervalIn, type Bounds } from "./price-change-set-bounds";

/** One materialized line as the in-set check sees it. */
export interface InSetLine {
  readonly key: string;
  readonly bounds: Bounds;
  /** An end or reset: only its start instant counts. */
  readonly point: boolean;
  /** The IANA zones the line applies in (its reached Stores'). */
  readonly zones: readonly string[];
}

function conflictAt(a: InSetLine, b: InSetLine, zone: string): boolean {
  const x = intervalIn(a.bounds, zone);
  const y = intervalIn(b.bounds, zone);
  if (x === null || y === null) return false;
  if (a.point && b.point) return x.from === y.from;
  if (!a.point && !b.point) return overlaps(x, y);
  const [instant, span]: [Interval, Interval] = a.point ? [x, y] : [y, x];
  return span.from < instant.from && (span.to === null || instant.from < span.to);
}

function conflict(a: InSetLine, b: InSetLine): boolean {
  for (const zone of new Set([...a.zones, ...b.zones])) if (conflictAt(a, b, zone)) return true;
  return false;
}

/** The in-set findings of each line, by its index in `lines` (lines with none are absent). */
export function inSetFindings(lines: readonly InSetLine[]): Map<number, string[]> {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const group = groups.get(line.key);
    if (group === undefined) groups.set(line.key, [index]);
    else group.push(index);
  });
  const found = new Map<number, Set<string>>();
  const add = (index: number, message: string): void => {
    const set = found.get(index) ?? new Set<string>();
    set.add(message);
    found.set(index, set);
  };
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = lines[group[i]!]!;
        const b = lines[group[j]!]!;
        if (!conflict(a, b)) continue;
        for (const index of [group[i]!, group[j]!]) {
          add(index, "overlaps_line_in_set");
          if (a.bounds.timeBasis !== b.bounds.timeBasis) add(index, "mixed_time_basis");
        }
      }
    }
  }
  return new Map([...found].map(([index, set]) => [index, [...set]]));
}
