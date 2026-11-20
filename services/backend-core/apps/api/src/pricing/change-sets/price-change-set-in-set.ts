/**
 * RT-1484 (RT-282 PR-10a, PR-4b; review round 1, M1) — overlaps between the lines of ONE Change
 * Set. Spec 041 (spec.md, "DB exclusion constraint + Change Set validation") keeps one price key
 * free of overlaps; validation must catch a set that contradicts itself before publish would hit
 * the exclusion constraint. Pure.
 *
 * Lines are grouped by key: (scope, Zone or Store, product, Sell Unit) for priced, ended and reset
 * lines, and the Store for Zone moves. Two lines of one group whose intervals overlap in any of the
 * time zones they apply in (each line's own Store, or every live Store for a Book or Zone line) are
 * both `invalid` with `overlaps_line_in_set`; when their time bases differ they also carry
 * `mixed_time_basis` (spec 041 §4.3, Q-6: one key never mixes bases while active).
 */
import { overlaps } from "./price-change-set-validation.types";
import { intervalIn, type Bounds } from "./price-change-set-bounds";

/** One materialized line as the in-set check sees it. */
export interface InSetLine {
  readonly key: string;
  readonly bounds: Bounds;
  /** The IANA zones the line applies in. */
  readonly zones: readonly string[];
}

function overlapIn(a: InSetLine, b: InSetLine): boolean {
  const zones = new Set([...a.zones, ...b.zones]);
  for (const zone of zones) {
    const x = intervalIn(a.bounds, zone);
    const y = intervalIn(b.bounds, zone);
    if (x !== null && y !== null && overlaps(x, y)) return true;
  }
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
        if (!overlapIn(a, b)) continue;
        for (const index of [group[i]!, group[j]!]) {
          add(index, "overlaps_line_in_set");
          if (a.bounds.timeBasis !== b.bounds.timeBasis) add(index, "mixed_time_basis");
        }
      }
    }
  }
  return new Map([...found].map(([index, set]) => [index, [...set]]));
}
