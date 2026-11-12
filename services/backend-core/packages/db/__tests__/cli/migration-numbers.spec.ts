/**
 * RT-1344 — the migration NUMBER gate. The registry (RT-812) already fails a
 * duplicate full id, but the ledger key is the whole file stem, so two PRs
 * that each add `0102_<other slug>.sql` merge without a git conflict and both
 * get applied. These specs pin the number rules: no number is used twice, and
 * a PR's new migrations are exactly the next numbers after the base tip.
 *
 * Docker-free. The last block reads the real drizzle directory (always) and,
 * when CI sets MIGRATION_BASE_REF, compares it with that ref's directory.
 */
import { readdirSync } from "node:fs";
import { DRIZZLE_DIR } from "./migration-registry";
import { baseMigrationFiles, checkMigrationNumbers } from "./migration-numbers";

const files = (...ids: string[]): string[] => ids.flatMap((id) => [`${id}.sql`, `${id}.down.sql`]);

// A base with a historical gap (0002 was never used), like main's 0049, 0052, 0053 and 0069.
const BASE = files("0000_a", "0001_b", "0003_c");

describe("checkMigrationNumbers: one listing", () => {
  it("passes a chain with a historical gap", () => {
    expect(checkMigrationNumbers(BASE)).toEqual([]);
  });

  it("fails two different slugs that share a four-digit number", () => {
    const problems = checkMigrationNumbers(files("0000_a", "0001_foo", "0001_bar"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/number 0001 is used by more than one migration: 0001_bar, 0001_foo/);
  });

  it("ignores files that are not migrations", () => {
    expect(checkMigrationNumbers([...BASE, "meta", "README.md"])).toEqual([]);
  });
});

describe("checkMigrationNumbers: against the base", () => {
  it("passes a PR that does not touch drizzle", () => {
    expect(checkMigrationNumbers(BASE, BASE)).toEqual([]);
  });

  it("passes a PR that adds exactly the next number", () => {
    expect(checkMigrationNumbers([...BASE, ...files("0004_d")], BASE)).toEqual([]);
  });

  it("passes a PR that adds the next two numbers", () => {
    expect(checkMigrationNumbers([...BASE, ...files("0004_d", "0005_e")], BASE)).toEqual([]);
  });

  it("fails a PR that reuses a number the base already has under another slug", () => {
    const problems = checkMigrationNumbers([...BASE, ...files("0003_other")], BASE);
    expect(problems.join("\n")).toMatch(/number 0003 is used by more than one migration/);
    expect(problems.join("\n")).toMatch(/new migration numbers must be exactly 0004; got 0003/);
  });

  it("fails a PR whose new number is below the base tip", () => {
    const problems = checkMigrationNumbers([...BASE, ...files("0002_fill")], BASE);
    expect(problems.join("\n")).toMatch(/new migration numbers must be exactly 0004; got 0002/);
  });

  it("fails a PR that skips the next number", () => {
    const problems = checkMigrationNumbers([...BASE, ...files("0005_e")], BASE);
    expect(problems.join("\n")).toMatch(/new migration numbers must be exactly 0004; got 0005/);
  });

  it("fails a PR that leaves a hole between its own migrations", () => {
    const problems = checkMigrationNumbers([...BASE, ...files("0004_d", "0006_f")], BASE);
    expect(problems.join("\n")).toMatch(/new migration numbers must be exactly 0004, 0005; got 0004, 0006/);
  });

  it("fails a PR that renames a base migration to another slug (a new id on a taken number)", () => {
    const renamed = files("0000_a", "0001_b", "0003_renamed");
    const problems = checkMigrationNumbers(renamed, BASE);
    expect(problems.join("\n")).toMatch(/new migration numbers must be exactly 0004; got 0003/);
  });

  it("starts from 0000 when the base holds no migrations", () => {
    expect(checkMigrationNumbers(files("0000_a"), [])).toEqual([]);
    expect(checkMigrationNumbers(files("0001_b"), []).join("\n")).toMatch(/must be exactly 0000; got 0001/);
  });

  it("fails a PR whose two new migrations share a number", () => {
    const problems = checkMigrationNumbers([...BASE, ...files("0004_d", "0004_e")], BASE);
    expect(problems.join("\n")).toMatch(/number 0004 is used by more than one migration/);
  });
});

describe("baseMigrationFiles", () => {
  it("fails loudly on a ref git cannot resolve", () => {
    expect(() => baseMigrationFiles("refs/does-not-exist")).toThrow(/migration numbers: cannot list/);
  });
});

describe("the real drizzle directory", () => {
  it("uses each four-digit number once (historical gaps are allowed)", () => {
    expect(checkMigrationNumbers(readdirSync(DRIZZLE_DIR))).toEqual([]);
  });

  const baseRef = process.env.MIGRATION_BASE_REF;

  // CI sets MIGRATION_BASE_REF on pull_request events (backend-core.yml bc/db-package). A missing
  // one there would silently skip the comparison below, so it fails instead.
  it("has a base ref to compare with on a pull request event", () => {
    if (process.env.GITHUB_EVENT_NAME === "pull_request") expect(baseRef).toBeTruthy();
  });

  (baseRef ? it : it.skip)("adds only the next numbers after MIGRATION_BASE_REF", () => {
    expect(checkMigrationNumbers(readdirSync(DRIZZLE_DIR), baseMigrationFiles(baseRef as string))).toEqual([]);
  });
});
