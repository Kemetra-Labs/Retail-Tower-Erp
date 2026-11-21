import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_592_POLICY_FLAG_REPIN_BRANCH,
  RT_592_POLICY_FLAG_REPIN_EXEMPT_FILES,
  isRt592ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-592 — the exemption that lets the repin to `pos-shifts.openapi.yaml` 1.6.0-draft
 * (`policy_revision_stale_at_receipt`) regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'rt-592-stale-policy-flag';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-592 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_592_POLICY_FLAG_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_592_POLICY_FLAG_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt592ExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-592 branch', (file) => {
    expect(isRt592ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'rt-592-stale-policy-flag-preflight',
    'rt-592-stale-policy-flag-preflight-db',
    'rt-592-stale-policy-flag/extra',
    'rt-592-stale-policy',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt592ExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt592ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1312QuarantineRepinExemptFile\(currentBranch, file\) &&\s*!isRt592ExemptFile\(currentBranch, file\)/,
    );
  });
});
