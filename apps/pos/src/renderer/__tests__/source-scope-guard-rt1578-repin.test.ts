import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1578_AVAILABILITY_REPIN_BRANCH,
  RT_1578_AVAILABILITY_REPIN_EXEMPT_FILES,
  isRt1578AvailabilityRepinExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1578 — the exemption that lets the repin to 3f17bed05 (RT-1577, `posGetStoreAvailability`)
 * regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/rt-1578-s3-ats-2e2482';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1578 repin exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1578_AVAILABILITY_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1578_AVAILABILITY_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1578AvailabilityRepinExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the repin branch', (file) => {
    expect(isRt1578AvailabilityRepinExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1578-s3-ats-2e2482-preflight',
    'claude/rt-1578-s3-ats-2e2482/extra',
    'claude/rt-1578-s3-ats',
    'rt-1498-close-unknown-return',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1578AvailabilityRepinExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1578AvailabilityRepinExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt373ExemptFile\(currentBranch, file\) &&\s*!isRt1578AvailabilityRepinExemptFile\(currentBranch, file\)/,
    );
  });
});
