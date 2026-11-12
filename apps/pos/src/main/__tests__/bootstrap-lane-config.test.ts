import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-1346 — composition-root guard for the baked lane configuration.
 *
 * A static check, like `bootstrap-cashier-profile.test.ts`: `src/main/index.ts` calls
 * `app.whenReady()` at module load, so it cannot be imported under vitest. The loader and
 * the resolution rule are unit-tested in `config/__tests__/lane-config.test.ts`; this pins
 * WHERE they are wired. Deleting either line would silently turn the feature off: the
 * baked file would never load, or sign-in would go back to the generic refusal (D4).
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

function indexOfOrFail(needle: string | RegExp): number {
  const idx = typeof needle === 'string' ? source.indexOf(needle) : source.search(needle);
  if (idx < 0) throw new Error(`index.ts: ${String(needle)} not found`);
  return idx;
}

describe('main/index.ts wires the baked lane configuration (RT-1346)', () => {
  it('imports the loader and the assessment from config/lane-config', () => {
    expect(source).toMatch(
      /import\s+\{[^}]*\bassessRuntimeConfig\b[^}]*\binitBakedLaneConfig\b[^}]*\}\s+from\s+'\.\/config\/lane-config\.js'/,
    );
  });

  it('loads the baked file after the main logger exists and before anything resolves a setting', () => {
    const init = indexOfOrFail(/initBakedLaneConfig\(\{[^}]*logger: mainLogger/);
    expect(init).toBeGreaterThan(indexOfOrFail('const mainLogger = await createLogger('));
    expect(init).toBeLessThan(indexOfOrFail(/registerTelemetry\(\{/));
    expect(init).toBeLessThan(indexOfOrFail(/resolveApiBaseUrl\(\)/));
    expect(init).toBeLessThan(indexOfOrFail(/resolveAuthExchanger\(/));
  });

  it('gives the manager sign-in handler the configuration assessment (D4)', () => {
    const handler = indexOfOrFail('new SignInHandler({');
    const wiring = indexOfOrFail(
      /configProblem:\s*\(\)\s*=>\s*assessRuntimeConfig\(process\.env\)/,
    );
    expect(wiring).toBeGreaterThan(handler);
    // Inside the same constructor call: before the next top-level statement ends it.
    expect(source.slice(handler, wiring)).not.toContain('});');
  });
});
