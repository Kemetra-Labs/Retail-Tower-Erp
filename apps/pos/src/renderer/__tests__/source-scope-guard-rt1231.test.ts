import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_1231_AUDIT_SYNC_REPIN_BRANCH,
  RT_1231_AUDIT_SYNC_REPIN_EXEMPT_FILES,
  isRt1231ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1231 — the exemption for the audit-sync repin branch is narrow: exactly the
 * regenerated `src/shared/api-types.ts`, on exactly one branch (exact name).
 */

const BRANCH = 'rt-1231-pos-audit-sync';

describe('source-scope guard — RT-1231 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1231_AUDIT_SYNC_REPIN_EXEMPT_FILES]).toEqual(['src/shared/api-types.ts']);
    expect(RT_1231_AUDIT_SYNC_REPIN_BRANCH).toBe(BRANCH);
  });

  it('does not touch the forbidden prefix list', () => {
    expect([...FORBIDDEN_PATH_PREFIXES]).toEqual([
      'src/main/pairing/',
      'src/main/secrets/',
      'src/shared/api-types.ts',
      'scripts/codegen-api.ts',
      'scripts/openapi-snapshot.json',
      '.github/workflows/',
    ]);
  });

  it('allows the regenerated api-types.ts on the RT-1231 branch', () => {
    expect(isRt1231ExemptFile(BRANCH, 'src/shared/api-types.ts')).toBe(true);
  });

  it.each([
    'src/main/pairing/store.ts',
    'src/main/secrets/store.ts',
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1231 branch', (file) => {
    expect(isRt1231ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each(['rt-1231-pos-audit-sync-preflight', 'claude/rt-1231-pos-audit-sync', 'rt-1231', 'main'])(
    'does not allow api-types.ts on branch %s',
    (branch) => {
      expect(isRt1231ExemptFile(branch, 'src/shared/api-types.ts')).toBe(false);
    },
  );
});
