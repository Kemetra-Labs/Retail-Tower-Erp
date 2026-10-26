import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_889_IN_TREE_CONTRACTS_BRANCH,
  RT_889_IN_TREE_CONTRACTS_EXEMPT_FILES,
  isRt889ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-889 — the exemption that lets the repin to the in-tree Backend-Core
 * contract regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/rt-889-in-tree-contracts';
const EXEMPT_FILES = ['src/shared/api-types.ts'];

describe('source-scope guard — RT-889 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_889_IN_TREE_CONTRACTS_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_889_IN_TREE_CONTRACTS_BRANCH).toBe(BRANCH);
  });

  it('allows src/shared/api-types.ts on the RT-889 branch', () => {
    expect(isRt889ExemptFile(BRANCH, 'src/shared/api-types.ts')).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/network.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-889 branch', (file) => {
    expect(isRt889ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-889-in-tree-contracts-x',
    'claude/rt-889-in-tree-contracts/extra',
    'claude/rt-889',
    'bot/backend-core-repin',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt889ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt889ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt869ExemptFile\(currentBranch, file\) &&\s*!isRt889ExemptFile\(currentBranch, file\)/,
    );
  });
});
