import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1343_CREDIT_VOID_REPIN_BRANCH,
  RT_1343_CREDIT_VOID_REPIN_EXEMPT_FILES,
  isRt1343CreditVoidExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1343 item 2 — the exemption that lets the repin to the credit-void voucher contract
 * (`pos-sales/sales.yaml` 1.24.0-draft) regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'rt-1343-credit-void-voucher';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1343 item 2 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1343_CREDIT_VOID_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1343_CREDIT_VOID_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1343CreditVoidExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1343 item 2 branch', (file) => {
    expect(isRt1343CreditVoidExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'rt-1343-credit-void-voucher-preflight',
    'rt-1343-credit-void-voucher/extra',
    'claude/rt-1343-voucher-response-enums',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1343CreditVoidExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1343CreditVoidExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1343ExemptFile\(currentBranch, file\) &&\s*!isRt1343CreditVoidExemptFile\(currentBranch, file\)/,
    );
  });
});
