/**
 * RT-1344 — the migration NUMBER rules, pure over drizzle directory listings.
 *
 * The runner and the ledger key a migration by its whole file stem, so two
 * different slugs with one four-digit number are both accepted and applied in
 * lexical slug order. These checks close that: no number is used twice, and
 * on a pull request the new migrations are exactly the next numbers after the
 * base branch's tip. Historical gaps (0015, 0049, 0052, 0053, 0069) are fine:
 * only numbers above the base tip are constrained.
 */
import { execFileSync } from "node:child_process";
import { DRIZZLE_DIR, UP_FILE } from "./migration-registry";

interface Migration {
  readonly id: string;
  readonly number: number;
}

/**
 * The up migrations in a directory listing. The file-name rule is the registry's own UP_FILE,
 * so the two guards cannot drift; down files (`<id>.down.sql`) and other names do not match it.
 */
function ups(files: readonly string[]): Migration[] {
  return files.flatMap((file) => {
    const id = UP_FILE.exec(file)?.[1];
    return id === undefined ? [] : [{ id, number: Number(id.slice(0, 4)) }];
  });
}

const pad = (n: number): string => String(n).padStart(4, "0");
const list = (numbers: readonly number[]): string => numbers.map(pad).join(", ");

function duplicateNumbers(migrations: readonly Migration[]): string[] {
  const byNumber = new Map<number, string[]>();
  for (const m of migrations) byNumber.set(m.number, [...(byNumber.get(m.number) ?? []), m.id]);
  return [...byNumber]
    .filter(([, ids]) => ids.length > 1)
    .map(([n, ids]) => `number ${pad(n)} is used by more than one migration: ${[...ids].sort().join(", ")}`);
}

/**
 * The problems with the head listing's migration numbers; empty when it is fine.
 * With `baseFiles` (the base branch's listing) the new migrations, those whose
 * id the base does not hold, must be exactly the numbers after the base tip.
 */
export function checkMigrationNumbers(headFiles: readonly string[], baseFiles?: readonly string[]): string[] {
  const head = ups(headFiles);
  const problems = duplicateNumbers(head);
  if (baseFiles === undefined) return problems;

  const base = ups(baseFiles);
  const baseIds = new Set(base.map((m) => m.id));
  const tip = Math.max(-1, ...base.map((m) => m.number));
  const added = head.filter((m) => !baseIds.has(m.id)).map((m) => m.number).sort((a, b) => a - b);
  const expected = added.map((_, i) => tip + 1 + i);
  if (added.some((n, i) => n !== expected[i])) {
    problems.push(
      `new migration numbers must be exactly ${list(expected)}; got ${list(added)} ` +
        `(the base tip is ${pad(tip)}; rebase on it and renumber, and do not back-fill gaps)`,
    );
  }
  return problems;
}

/**
 * The drizzle directory listing at `ref` (a commit, branch or FETCH_HEAD).
 * Throws on a ref git cannot read, so a missing base fails the check instead
 * of silently skipping it.
 */
export function baseMigrationFiles(ref: string, dir = DRIZZLE_DIR): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-tree", "--name-only", ref, "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter((line) => line !== "");
  } catch (error) {
    throw new Error(`migration numbers: cannot list ${dir} at ${ref}: ${(error as Error).message}`);
  }
}
