import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1114_VOUCHER_TENDER_REPIN_BRANCH,
  RT_1114_VOUCHER_TENDER_REPIN_EXEMPT_FILES,
  isRt1114ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1114 — the exemption that lets the repin to the voucher-tender contract (`pos-sales/sales.yaml`
 * 1.23.0-draft) regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'rt-1114-voucher-tender';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1114 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1114_VOUCHER_TENDER_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1114_VOUCHER_TENDER_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1114ExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1114 branch', (file) => {
    expect(isRt1114ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'rt-1114-voucher-tender-preflight',
    'rt-1114-voucher-tender/extra',
    'claude/rt-1110-voucher-va-amendment',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1114ExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1114ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1316ExemptFile\(currentBranch, file\) &&\s*!isRt1114ExemptFile\(currentBranch, file\)/,
    );
  });
});
