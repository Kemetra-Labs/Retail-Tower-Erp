import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_1183_STOP_STORING_PRINTER_FIELDS_BRANCH,
  RT_1183_STOP_STORING_PRINTER_FIELDS_EXEMPT_FILES,
  isRt1183ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1183 — the exemption for the stop-storing-printer-fields branch is narrow:
 * exactly seven files under `src/main/pairing/`, exactly one branch (exact name).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/rt-1183-pos-stop-storing-printer-fields';
const EXEMPT_FILES = [
  'src/main/pairing/__tests__/service.test.ts',
  'src/main/pairing/__tests__/store-device-revoked.test.ts',
  'src/main/pairing/__tests__/store-token-binding.test.ts',
  'src/main/pairing/__tests__/store.test.ts',
  'src/main/pairing/dev-skip-pairing.ts',
  'src/main/pairing/service.ts',
  'src/main/pairing/store.ts',
];

describe('source-scope guard — RT-1183 exemption is narrow', () => {
  it('exempts exactly seven files on exactly one branch', () => {
    expect([...RT_1183_STOP_STORING_PRINTER_FIELDS_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_1183_STOP_STORING_PRINTER_FIELDS_BRANCH).toBe(BRANCH);
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

  it.each(EXEMPT_FILES)('allows %s on the RT-1183 branch', (file) => {
    expect(isRt1183ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/network.ts',
    'src/main/pairing/token-binding.ts',
    'src/main/pairing/__tests__/sub/service.test.ts',
    'src/main/secrets/store.ts',
    'src/shared/api-types.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1183 branch', (file) => {
    expect(isRt1183ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each(['main', 'claude/rt-1183-', 'claude/rt-1183-pos-stop-storing-printer-fields-x', 'claude/rt-1183-pos-stop-storing-printer-fields/extra', ''])(
    'does not allow the files on branch %j',
    (branch) => {
      for (const file of EXEMPT_FILES) {
        expect(isRt1183ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
      }
    },
  );

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1183ExemptFile/g)).toHaveLength(2); // import + use
  });
});
