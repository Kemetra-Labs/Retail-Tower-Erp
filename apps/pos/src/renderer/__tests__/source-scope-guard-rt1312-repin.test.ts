import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_1312_QUARANTINE_REPIN_BRANCH,
  RT_1312_QUARANTINE_REPIN_EXEMPT_FILES,
  isRt1312QuarantineRepinExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1312 — the source-scope guard exemption for the quarantine contract repin is NARROW: exactly
 * the generated `src/shared/api-types.ts`, on exactly one branch (exact name). The forbidden prefix
 * list is unchanged, so the codegen tool, the snapshot and every other path stay blocked.
 */

const BRANCH = 'claude/eager-turing-0o0mhg-pos-repin';

describe('source-scope guard — RT-1312 quarantine repin exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1312_QUARANTINE_REPIN_EXEMPT_FILES]).toEqual(['src/shared/api-types.ts']);
    expect(RT_1312_QUARANTINE_REPIN_BRANCH).toBe(BRANCH);
    expect(FORBIDDEN_PATH_PREFIXES).toContain('src/shared/api-types.ts');
  });

  it('allows the generated types on that branch only', () => {
    expect(isRt1312QuarantineRepinExemptFile(BRANCH, 'src/shared/api-types.ts')).toBe(true);
    for (const branch of [
      'main',
      '',
      `${BRANCH}-preflight`,
      `${BRANCH}/extra`,
      'claude/eager-turing',
    ]) {
      expect(isRt1312QuarantineRepinExemptFile(branch, 'src/shared/api-types.ts'), branch).toBe(
        false,
      );
    }
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/main/pairing/store.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/pos.yml',
    'src/shared/api-types.ts.orig',
  ])('does not allow %s on that branch', (file) => {
    expect(isRt1312QuarantineRepinExemptFile(BRANCH, file)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt1312QuarantineRepinExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /ExemptFile\(currentBranch, file\) &&\s*!isRt1312QuarantineRepinExemptFile\(currentBranch, file\)/,
    );
  });
});
