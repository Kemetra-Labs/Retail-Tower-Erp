#!/usr/bin/env node
// RT-1198: code-health ratchet for apps/pos.
//
// Measures dead code (knip), duplication (jscpd), size/complexity warnings (ESLint, rules in
// scripts/code-health/rules.mjs) and type errors in tests/ (tsconfig.tests.json), then compares
// them with the committed baseline scripts/code-health.baseline.json. It fails (exit 1) when any
// count grows, and passes with a hint when a count shrinks so the PR that cleans up lowers the
// baseline (run with --update to rewrite it).
//
// Usage: node scripts/check-code-health.mjs [--update]
// Exit codes: 0 pass, 1 a count grew past the baseline, 2 a tool or the baseline failed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tsEslint from 'typescript-eslint';

import { BaselineError, METRICS, compare, parseBaseline } from './code-health/compare.mjs';
import { SIZE_RULE_FILES, SIZE_RULE_IGNORES, SIZE_RULES } from './code-health/rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(root, 'scripts', 'code-health.baseline.json');

class ToolError extends Error {}

/** The JS entry point of a locally installed package's binary (no shell, same on every OS). */
function binPath(pkg, bin) {
  // Read the manifest by path: some packages (knip) do not export ./package.json.
  const manifestPath = path.join(root, 'node_modules', pkg, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new ToolError(`${pkg} is not installed (run npm ci): ${err.message}`);
  }
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (typeof relative !== 'string') throw new ToolError(`${pkg} has no "${bin}" binary`);
  return path.join(path.dirname(manifestPath), relative);
}

function run(pkg, bin, args) {
  const result = spawnSync(process.execPath, [binPath(pkg, bin), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new ToolError(`${bin} failed to start: ${result.error.message}`);
  return result;
}

function countEntries(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function expectStatus(name, result, allowed) {
  if (!allowed.includes(result.status)) {
    throw new ToolError(`${name} exited ${String(result.status)}: ${result.stderr.slice(0, 500)}`);
  }
}

function parseToolJson(name, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError(`${name} did not print JSON: ${text.slice(0, 300)}`);
  }
}

function measureKnip() {
  const result = run('knip', 'knip', ['--reporter', 'json', '--no-progress']);
  // knip exits 1 when it finds issues; anything else non-zero is a tool failure.
  expectStatus('knip', result, [0, 1]);
  const report = parseToolJson('knip', result.stdout);
  const sum = (key) => report.issues.reduce((total, issue) => total + countEntries(issue[key]), 0);
  return {
    knipUnusedFiles: sum('files'),
    knipUnusedExports: sum('exports') + sum('nsExports') + sum('enumMembers'),
    knipUnusedTypes: sum('types') + sum('nsTypes'),
    knipUnusedDependencies: sum('dependencies') + sum('devDependencies'),
    knipUnlistedDependencies: sum('unlisted'),
    knipDuplicateExports: sum('duplicates'),
  };
}

function measureJscpd() {
  const out = mkdtempSync(path.join(tmpdir(), 'pos-jscpd-'));
  try {
    const result = run('jscpd', 'jscpd', ['--config', '.jscpd.json', '--output', out]);
    expectStatus('jscpd', result, [0]);
    const report = parseToolJson(
      'jscpd',
      readFileSync(path.join(out, 'jscpd-report.json'), 'utf8'),
    );
    return {
      jscpdClones: report.statistics.total.clones,
      jscpdDuplicatedLines: report.statistics.total.duplicatedLines,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function countRuleMessages(results) {
  const counts = { complexity: 0, 'max-lines-per-function': 0, 'max-lines': 0 };
  const messages = results.flatMap((file) => file.messages.map((message) => ({ file, message })));
  for (const { file, message } of messages) {
    if (message.fatal) throw new ToolError(`eslint could not parse ${file.filePath}`);
    if (Object.hasOwn(counts, message.ruleId ?? '')) counts[message.ruleId] += 1;
  }
  return counts;
}

async function measureEslint() {
  // Only the size/complexity rules, without type information: fast, and independent of the
  // type-aware `npm run lint` job that already runs every other rule.
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: SIZE_RULE_FILES,
        ignores: SIZE_RULE_IGNORES,
        languageOptions: { parser: tsEslint.parser },
        rules: SIZE_RULES,
      },
    ],
  });
  const counts = countRuleMessages(await eslint.lintFiles(SIZE_RULE_FILES));
  return {
    eslintComplexity: counts.complexity,
    eslintMaxLinesPerFunction: counts['max-lines-per-function'],
    eslintMaxLines: counts['max-lines'],
  };
}

function measureTestsTypeErrors() {
  const result = run('typescript', 'tsc', ['-p', 'tsconfig.tests.json', '--pretty', 'false']);
  const output = `${result.stdout}\n${result.stderr}`;
  const errors = output.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line)).length;
  if (result.status !== 0 && errors === 0) {
    throw new ToolError(
      `tsc exited ${String(result.status)} without type errors: ${output.slice(0, 500)}`,
    );
  }
  return { testsTypeErrors: errors };
}

function readBaseline() {
  let text;
  try {
    text = readFileSync(baselineFile, 'utf8');
  } catch (err) {
    throw new BaselineError(`cannot read ${baselineFile}: ${err.message}`);
  }
  try {
    return parseBaseline(JSON.parse(text));
  } catch (err) {
    if (err instanceof BaselineError) throw err;
    throw new BaselineError(`${baselineFile} is not valid JSON: ${err.message}`);
  }
}

function writeBaseline(current) {
  const body = {
    $comment: 'RT-1198 code-health ratchet. Lower is better; counts may only go down.',
  };
  for (const metric of METRICS) body[metric] = current[metric];
  writeFileSync(baselineFile, `${JSON.stringify(body, null, 2)}\n`);
}

async function main() {
  const update = process.argv.slice(2).includes('--update');
  const current = {
    ...measureKnip(),
    ...measureJscpd(),
    ...(await measureEslint()),
    ...measureTestsTypeErrors(),
  };

  if (update) {
    writeBaseline(current);
    console.log('code-health: baseline written.');
    console.table(current);
    return 0;
  }

  const { grew, shrank, ok } = compare(current, readBaseline());
  console.table(current);
  reportShrank(shrank);
  return reportGrew(grew, ok);
}

function reportShrank(shrank) {
  for (const { metric, current: now, baseline } of shrank) {
    console.log(`code-health: hint: ${metric} dropped to ${now} (baseline ${baseline}).`);
  }
  if (shrank.length > 0) {
    console.log('code-health: hint: run `node scripts/check-code-health.mjs --update` in this PR.');
  }
}

function reportGrew(grew, ok) {
  for (const { metric, current: now, baseline } of grew) {
    console.error(
      `code-health: FAIL ${metric} is ${now}, baseline is ${baseline} (+${now - baseline}).`,
    );
  }
  if (ok) {
    console.log('code-health: OK, no count grew.');
    return 0;
  }
  console.error(
    'code-health: remove the new unused code, duplication, oversized function or test type ' +
      'error, or explain in the PR why the baseline must rise (owner approval required).',
  );
  return 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (!(err instanceof ToolError) && !(err instanceof BaselineError)) throw err;
  console.error(`code-health: ERROR ${err.message}`);
  process.exitCode = 2;
}
