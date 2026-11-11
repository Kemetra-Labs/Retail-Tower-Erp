import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * RT-1324 — `synchronous` is a per-connection setting. The till sets FULL in
 * `openDatabase` (`db/client.ts`), so that must stay the only file that loads
 * better-sqlite3. A second open site would silently get SQLite's NORMAL
 * default back. If you need another connection, open it through
 * `openDatabase`, not by importing better-sqlite3.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWED = path.join('main', 'db', 'client.ts');
const LOADS_BINDING = /(?:from\s+|require\(\s*|import\(\s*)['"]better-sqlite3['"]/;

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionSources(full);
    return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [full]
      : [];
  });
}

describe('better-sqlite3 open sites (RT-1324)', () => {
  it('only db/client.ts loads better-sqlite3', () => {
    const loaders = productionSources(SRC)
      .filter((file) => LOADS_BINDING.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));

    expect(loaders).toEqual([ALLOWED]);
  });
});
