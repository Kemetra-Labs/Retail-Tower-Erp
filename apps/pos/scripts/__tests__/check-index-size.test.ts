import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * RT-893 step 2a: the line ratchet on src/main/index.ts. The script runs as plain Node in CI, so
 * it is exercised here as a child process against fixture files: over the baseline fails (exit
 * 1), equal passes, under passes with a hint to lower the baseline.
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-index-size.mjs',
);
const BASELINE_HEADER = '# lines counted like `wc -l`\n';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'index-size-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(indexText: string, baselineText: string) {
  const index = path.join(dir, 'index.ts');
  const baseline = path.join(dir, 'index-size.baseline');
  writeFileSync(index, indexText);
  writeFileSync(baseline, baselineText);
  const res = spawnSync(process.execPath, [SCRIPT, '--index', index, '--baseline', baseline], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const lines = (n: number) => 'x;\n'.repeat(n);

describe('check-index-size', () => {
  it('fails with exit 1 when the file has more lines than the baseline', () => {
    const res = run(lines(11), `${BASELINE_HEADER}10\n`);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('FAIL src/main/index.ts has 11 lines, baseline is 10 (+1)');
    expect(res.stderr).toContain('src/main/bootstrap/<area>.ts');
  });

  it('passes with no hint when the file is exactly at the baseline', () => {
    const res = run(lines(10), `${BASELINE_HEADER}10\n`);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('OK src/main/index.ts has 10 lines, baseline is 10.');
    expect(res.stdout).not.toContain('hint');
  });

  it('passes and hints to lower the baseline when the file shrank', () => {
    const res = run(lines(7), `${BASELINE_HEADER}10\n`);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('hint: src/main/index.ts shrank by 3 lines');
    expect(res.stdout).toContain('Lower scripts/index-size.baseline to 7 in this PR.');
  });

  it('counts lines like `wc -l`: LF bytes only, a last line without a newline is not counted', () => {
    expect(run('a\r\nb\nc', '2\n').status).toBe(0);
    expect(run('a\r\nb\nc\n', '2\n').status).toBe(1);
  });

  it.each([
    ['no integer', '# only a comment\n'],
    ['two integers', '10\n11\n'],
    ['a negative number', '-1\n'],
    ['not a number', 'ten\n'],
  ])('refuses a baseline with %s (exit 2)', (_label, baselineText) => {
    const res = run(lines(1), baselineText);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('must hold exactly one non-negative integer');
  });

  it('refuses a missing index file (exit 2)', () => {
    const baseline = path.join(dir, 'index-size.baseline');
    writeFileSync(baseline, '1\n');
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--index', path.join(dir, 'missing.ts'), '--baseline', baseline],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('cannot read');
  });

  it('refuses an unknown argument (exit 2)', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("unexpected argument '--bogus'");
  });

  it('the committed baseline holds exactly one integer and states the `wc -l` rule', () => {
    const committed = readFileSync(path.join(path.dirname(SCRIPT), 'index-size.baseline'), 'utf8');
    const values = committed
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^\d+$/);
    expect(committed).toContain('wc -l');
  });
});
