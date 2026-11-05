/**
 * RT-1061 (RT-973 §7 slice 1) — every write that sets `sales.sync_status`
 * also moves `sales.sync_status_version` by one, in the same statement.
 *
 * A static enumeration over the production sources of the api, the worker
 * and the shared packages: every SQL statement (a template or string literal)
 * that UPDATEs `sales` and assigns `sync_status` in its SET clause must also
 * assign `sync_status_version = [alias.]sync_status_version + 1` there. The
 * writer list is pinned, so a NEW writer fails this test until it is added
 * here, after it carries the increment. Capture (the INSERT) must not set the
 * version: it starts at the column default 0.
 *
 * The behaviour over real Postgres is `sale-sync-status-version.integration.spec.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const SOURCE_DIRS = ["apps/api/src", "apps/worker/src", "packages/db/src", "packages/shared/src"];

/** The pinned writers: file → number of `sync_status` UPDATE statements in it. */
const WRITERS: Readonly<Record<string, number>> = {
  "apps/worker/src/sales/sale-processing.processor.ts": 1, // the drain → synced
  // the dead-letter producer: quarantine → failed-*, and (RT-1233) the
  // drain-failure status-only write → failed-retryable
  "apps/worker/src/sales/sale-sync-deadletter.producer.ts": 2,
  "apps/api/src/catalog/sale-sync-ops/sale-sync-ops.read-model.service.ts": 1, // the console repair → failed-retryable
};

function sources(dir: string): string[] {
  const abs = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(abs, name);
    if (statSync(path).isDirectory()) return sources(relative(ROOT, path));
    return /\.ts$/.test(name) && !/\.(spec|d)\.ts$/.test(name) ? [relative(ROOT, path)] : [];
  });
}

/** Every string / template literal of a source file (SQL lives in them). */
function literals(text: string): string[] {
  const out: string[] = [];
  const re = /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  for (const m of text.matchAll(re)) out.push(m[0].slice(1, -1));
  return out;
}

/**
 * The SET clause of an `UPDATE sales` statement, or null when the literal is
 * not one: from SET to the first WHERE / RETURNING / FROM outside parentheses
 * (a subquery in the SET list has its own FROM and WHERE).
 */
function setClauseOfSalesUpdate(sql: string): string | null {
  const m = /\bUPDATE\s+sales\b(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b/i.exec(sql);
  if (!m) return null;
  const rest = sql.slice(m.index + m[0].length);
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /\s/.test(ch ?? "") && /^\s(?:WHERE|RETURNING|FROM)\b/i.test(rest.slice(i))) {
      return rest.slice(0, i);
    }
  }
  return rest;
}

const SETS_STATUS = /(?:^|[\s,.])sync_status\s*=/;
const BUMPS_VERSION = /(?:^|[\s,])(?:\w+\.)?sync_status_version\s*=\s*(?:\w+\.)?sync_status_version\s*\+\s*1\b/;

interface Found {
  readonly file: string;
  readonly bumps: boolean;
}

function statusWriters(): Found[] {
  const found: Found[] = [];
  for (const file of SOURCE_DIRS.flatMap(sources)) {
    for (const lit of literals(readFileSync(join(ROOT, file), "utf8"))) {
      const set = setClauseOfSalesUpdate(lit);
      if (set === null || !SETS_STATUS.test(set.replace(/--[^\n]*/g, ""))) continue;
      found.push({ file, bumps: BUMPS_VERSION.test(set.replace(/--[^\n]*/g, "")) });
    }
  }
  return found;
}

describe("RT-1061 sync_status writers", () => {
  it("the scan is not vacuous: it reads the api and worker sources", () => {
    const files = SOURCE_DIRS.flatMap(sources);
    expect(files.length).toBeGreaterThan(100);
    for (const file of Object.keys(WRITERS)) expect(files).toContain(file);
  });

  it("the writers are exactly the pinned ones (a new writer must be added here)", () => {
    const counts: Record<string, number> = {};
    for (const w of statusWriters()) counts[w.file] = (counts[w.file] ?? 0) + 1;
    expect(counts).toEqual(WRITERS);
  });

  it("every writer moves sync_status_version by one in the same UPDATE", () => {
    expect(statusWriters().filter((w) => !w.bumps)).toEqual([]);
  });

  it("nothing outside an UPDATE that sets sync_status writes the version, and capture leaves it at its default", () => {
    const strays: string[] = [];
    for (const file of SOURCE_DIRS.flatMap(sources)) {
      for (const lit of literals(readFileSync(join(ROOT, file), "utf8"))) {
        const clean = lit.replace(/--[^\n]*/g, "");
        if (!/sync_status_version\s*=|INSERT\s+INTO\s+sales\b[^;]*sync_status_version/i.test(clean)) continue;
        const set = setClauseOfSalesUpdate(clean);
        if (set === null || !SETS_STATUS.test(set)) strays.push(file);
      }
    }
    expect(strays).toEqual([]);
  });

  it("the detector itself: catches a writer without the increment, accepts an aliased increment", () => {
    const missing = setClauseOfSalesUpdate("UPDATE sales SET sync_status = $2 WHERE id = $1")!;
    expect(SETS_STATUS.test(missing)).toBe(true);
    expect(BUMPS_VERSION.test(missing)).toBe(false);
    const aliased = setClauseOfSalesUpdate(
      "UPDATE sales AS s SET processed_at = now(), sync_status = 'synced', sync_status_version = s.sync_status_version + 1 WHERE s.id = $1",
    )!;
    expect(BUMPS_VERSION.test(aliased)).toBe(true);
    expect(setClauseOfSalesUpdate("UPDATE sale_sync_deadletters SET resolved_at = now() WHERE sale_id = $1")).toBeNull();
    expect(SETS_STATUS.test(setClauseOfSalesUpdate("UPDATE sales SET mismatch_flag = true WHERE sync_status = 'x'")!)).toBe(false);
    const subquery = setClauseOfSalesUpdate(
      "UPDATE sales AS s SET mismatch_flag = (SELECT SUM(x) FROM sale_lines WHERE sale_id = s.id) <> 0, sync_status = 'synced' WHERE s.id = $1",
    )!;
    expect(SETS_STATUS.test(subquery)).toBe(true);
    expect(BUMPS_VERSION.test(subquery)).toBe(false);
  });
});
