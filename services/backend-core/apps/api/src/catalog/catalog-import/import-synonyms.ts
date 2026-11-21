/**
 * RT-1505 part B (spec 049 section 5 and 12.1 "Profile selection rule"): the mapping suggestion of a new batch.
 *
 * A suggestion is a hint the merchant confirms with `consoleSetCatalogImportMapping`; it is never applied by itself.
 * It draws on two sources, in this order:
 *
 *   1. The tenant's saved mapping profile (header text -> field, matched on the exact trimmed header).
 *      The profile that fits the file best is chosen: the one whose entries cover the most of the file's usable
 *      headers (non-empty, appearing once), at least one; a tie goes to the most recently updated profile, then to
 *      the smaller name, then to the smaller id (all by code units), so the choice is deterministic.
 *   2. The header synonyms (English and Arabic, `import-synonym-data.ts`) for the columns the profile did not place,
 *      matched after `normalizeHeader`.
 *
 * Every field is suggested at most once (`barcode` up to 5 columns): a field a profile entry already holds is left
 * out of the synonym pass, and a column that cannot be placed is absent. `ignore` is only ever suggested by a
 * profile. Pure: no I/O.
 */
import { compareCodeUnits } from "../../common/compare-code-units";
import { HEADER_SYNONYMS } from "./import-synonym-data";
import {
  CANONICAL_FIELDS,
  MAX_BARCODE_COLUMNS,
  type CanonicalField,
  type ColumnMapping,
  type MappingTarget,
} from "./import-mapping";

/** A saved profile as the suggestion reads it. */
export interface SuggestionProfile {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date;
  /** Header text -> target. Read with `Object.hasOwn` only. */
  readonly entries: Readonly<Record<string, string>>;
}

export interface SuggestionColumn {
  readonly columnNumber: number;
  readonly header: string;
}

export interface Suggestion {
  readonly suggested: ColumnMapping[];
  /** The profile that placed at least one column, or null. */
  readonly profileId: string | null;
}

/** Combining marks of Arabic (tashkeel, dagger alef) and the tatweel: dropped. */
const ARABIC_MARKS = /[\u{064B}-\u{065F}\u{0670}\u{0640}]/gu;
/** Alef with hamza or madda, and alef wasla: one alef. */
const ALEF_VARIANTS = /[\u{0622}\u{0623}\u{0625}\u{0671}]/gu;
/** Anything that is not a letter or a digit: a run of it is one space. */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * The lookup key of a header: NFKC, lower case, no Arabic marks, one alef, alef maqsura as ya, ta marbuta as ha, and a
 * run of anything that is not a letter or a digit as one space ("Tax-Category", "tax_category" and "TAX CATEGORY" are
 * the same header). Every pattern is a single character class with one quantifier: linear on any input.
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKC")
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(ALEF_VARIANTS, "\u{0627}")
    .replace(/\u{0649}/gu, "\u{064A}")
    .replace(/\u{0629}/gu, "\u{0647}")
    .replace(SEPARATORS, " ")
    .trim();
}

const SYNONYM_FIELD = new Map<string, CanonicalField>();
for (const field of CANONICAL_FIELDS) {
  for (const word of HEADER_SYNONYMS[field]) SYNONYM_FIELD.set(normalizeHeader(word), field);
}

/** The field a header names by synonym, or null. A header over 200 characters is never one. */
export function synonymFieldOf(header: string): CanonicalField | null {
  if (header.length > 200) return null;
  return SYNONYM_FIELD.get(normalizeHeader(header)) ?? null;
}

/** Whether `target` may still be placed: a field once, `barcode` up to 5 times, `ignore` any number of times. */
class Placement {
  private readonly used = new Map<string, number>();
  readonly placed: ColumnMapping[] = [];

  tryPlace(columnNumber: number, target: MappingTarget): boolean {
    if (target !== "ignore") {
      const n = this.used.get(target) ?? 0;
      if (target === "barcode" ? n >= MAX_BARCODE_COLUMNS : n >= 1) return false;
      this.used.set(target, n + 1);
    }
    this.placed.push({ columnNumber, target });
    return true;
  }
}

const TARGETS: ReadonlySet<string> = new Set<string>([...CANONICAL_FIELDS, "ignore"]);

function profileTarget(profile: SuggestionProfile, header: string): MappingTarget | null {
  if (!Object.hasOwn(profile.entries, header)) return null;
  const target = profile.entries[header] as string;
  return TARGETS.has(target) ? (target as MappingTarget) : null;
}

/** Headers that appear once and are not empty: the ones a profile entry can identify. */
function usableColumns(columns: readonly SuggestionColumn[]): SuggestionColumn[] {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(c.header, (counts.get(c.header) ?? 0) + 1);
  return columns.filter((c) => c.header !== "" && counts.get(c.header) === 1);
}

/** The profile covering the most usable headers (at least one), ties broken as the module comment says. */
function bestProfile(usable: readonly SuggestionColumn[], profiles: readonly SuggestionProfile[]): SuggestionProfile | null {
  let best: SuggestionProfile | null = null;
  let bestCover = 0;
  for (const profile of profiles) {
    let cover = 0;
    for (const c of usable) if (profileTarget(profile, c.header) !== null) cover += 1;
    if (cover === 0) continue;
    if (best === null || cover > bestCover || (cover === bestCover && precedes(profile, best))) {
      best = profile;
      bestCover = cover;
    }
  }
  return best;
}

/** The tie-break: newer first, then smaller name, then smaller id. */
function precedes(a: SuggestionProfile, b: SuggestionProfile): boolean {
  const byTime = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (byTime !== 0) return byTime < 0;
  return compareCodeUnits(a.name, b.name) !== 0 ? compareCodeUnits(a.name, b.name) < 0 : compareCodeUnits(a.id, b.id) < 0;
}

/**
 * The suggestion for a file. `carried` (a re-upload, `import-replace-carry.ts`) are entries already decided: they are
 * placed first and take priority, so the profile and the synonyms fill only the other columns and leave out every field
 * a carried entry holds (`barcode` while the total stays at most 5).
 */
export function suggestMapping(columns: readonly SuggestionColumn[], profiles: readonly SuggestionProfile[], carried: readonly ColumnMapping[] = []): Suggestion {
  const placement = new Placement();
  const taken = new Set<number>();
  for (const entry of carried) {
    if (placement.tryPlace(entry.columnNumber, entry.target)) taken.add(entry.columnNumber);
  }
  const usable = usableColumns(columns).filter((c) => !taken.has(c.columnNumber));
  const profile = bestProfile(usable, profiles);
  let profileContributed = false;
  if (profile !== null) {
    for (const c of usable) {
      const target = profileTarget(profile, c.header);
      if (target !== null && placement.tryPlace(c.columnNumber, target)) {
        taken.add(c.columnNumber);
        profileContributed = true;
      }
    }
  }
  for (const c of columns) {
    if (taken.has(c.columnNumber)) continue;
    const field = synonymFieldOf(c.header);
    if (field !== null) placement.tryPlace(c.columnNumber, field);
  }
  const suggested = [...placement.placed].sort((a, b) => a.columnNumber - b.columnNumber);
  return { suggested, profileId: profileContributed && profile !== null ? profile.id : null };
}
