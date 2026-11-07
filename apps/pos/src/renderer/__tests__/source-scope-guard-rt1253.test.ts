import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1253_TELEMETRY_TUNNEL_BRANCH,
  RT_1253_TELEMETRY_TUNNEL_EXEMPT_FILES,
  isRt1253ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1253 — the exemption that lets the telemetry contract pin regenerate
 * `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/sentry-pathway-completion-b6a25b';
const EXEMPT_FILES = ['src/shared/api-types.ts'];

describe('source-scope guard — RT-1253 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1253_TELEMETRY_TUNNEL_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_1253_TELEMETRY_TUNNEL_BRANCH).toBe(BRANCH);
  });

  it('allows the file on the RT-1253 branch', () => {
    expect(isRt1253ExemptFile(BRANCH, 'src/shared/api-types.ts')).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1253 branch', (file) => {
    expect(isRt1253ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each(['main', `${BRANCH}-x`, `${BRANCH}/extra`, 'claude/rt-1181-pos-pin-repin', ''])(
    'does not allow the file on branch %j',
    (branch) => {
      expect(isRt1253ExemptFile(branch, 'src/shared/api-types.ts'), branch).toBe(false);
    },
  );

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1253ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1231ExemptFile\(currentBranch, file\) &&\s*!isRt1253ExemptFile\(currentBranch, file\)/,
    );
  });
});
