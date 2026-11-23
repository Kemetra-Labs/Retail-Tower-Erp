import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_373_DEVICE_TOKEN_ROTATION_BRANCH,
  RT_373_DEVICE_TOKEN_ROTATION_EXEMPT_FILES,
  isRt373ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-373 — the exemption that lets the device token rotation keep `expires_at` beside the sealed
 * device token is narrow: three pairing files, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'rt-373-device-token-rotation';
const FILES = [
  'src/main/pairing/service.ts',
  'src/main/pairing/store.ts',
  'src/main/pairing/token-binding.ts',
];

describe('source-scope guard — RT-373 exemption is narrow', () => {
  it('exempts exactly three files on exactly one branch', () => {
    expect([...RT_373_DEVICE_TOKEN_ROTATION_EXEMPT_FILES]).toEqual(FILES);
    expect(RT_373_DEVICE_TOKEN_ROTATION_BRANCH).toBe(BRANCH);
    for (const file of FILES) expect(isRt373ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/device-token.ts',
    'src/main/pairing/device-auth-detector.ts',
    'src/main/pairing/network.ts',
    'src/main/pairing/__tests__/store.test.ts',
    'src/main/secrets/safe-storage.ts',
    'src/shared/api-types.ts',
    'scripts/codegen-api.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the branch', (file) => {
    expect(isRt373ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'rt-373-device-token-rotation-preflight',
    'rt-373-device-token-rotation/extra',
    'rt-373',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of FILES) expect(isRt373ExemptFile(branch, file)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt373ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1498CloseRepinExemptFile\(currentBranch, file\) &&\s*!isRt373ExemptFile\(currentBranch, file\)/,
    );
  });
});
