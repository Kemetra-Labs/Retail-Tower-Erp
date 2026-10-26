#!/usr/bin/env node
// RT-893 step 2a: line ratchet for src/main/index.ts.
//
// The main-process entry point must not grow. New wiring goes in
// src/main/bootstrap/<area>.ts exporting register<Area>(deps). This check fails (exit 1) when
// src/main/index.ts has more lines than the committed baseline in scripts/index-size.baseline,
// and passes with a hint when it has fewer, so the PR that shrinks the file lowers the baseline.
//
// Lines are counted the way `wc -l` counts them: the number of newline (LF, 0x0A) bytes. A last
// line without a trailing newline is not counted, and CRLF counts once.
//
// Usage: node scripts/check-index-size.mjs [--index <path>] [--baseline <path>]
// Both paths default to this checkout (the options exist for the unit test).
// Exit codes: 0 pass, 1 file grew past the baseline, 2 usage error or unreadable/invalid input.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  index: path.resolve(scriptDir, '..', 'src', 'main', 'index.ts'),
  baseline: path.resolve(scriptDir, 'index-size.baseline'),
};

class InputError extends Error {}

function parseArgs(argv) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--index' && flag !== '--baseline') || value === undefined) {
      throw new InputError(
        `unexpected argument '${flag}'. Usage: check-index-size.mjs [--index <path>] [--baseline <path>]`,
      );
    }
    out[flag.slice(2)] = path.resolve(value);
  }
  return out;
}

function read(file) {
  try {
    return readFileSync(file);
  } catch (err) {
    throw new InputError(`cannot read ${file}: ${err.message}`);
  }
}

/** `wc -l`: the number of LF bytes. */
function countLines(buf) {
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n += 1;
  return n;
}

/** One non-negative integer; blank lines and lines starting with `#` are comments. */
function parseBaseline(text, file) {
  const values = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (values.length !== 1 || !/^\d+$/.test(values[0])) {
    throw new InputError(`${file} must hold exactly one non-negative integer (plus # comments)`);
  }
  return Number(values[0]);
}

function main() {
  const { index, baseline: baselineFile } = parseArgs(process.argv.slice(2));
  const lines = countLines(read(index));
  const baseline = parseBaseline(read(baselineFile).toString('utf8'), baselineFile);
  const name = 'src/main/index.ts';

  if (lines > baseline) {
    console.error(
      `index-size: FAIL ${name} has ${lines} lines, baseline is ${baseline} (+${lines - baseline}).\n` +
        'No new wiring in src/main/index.ts: put new areas in src/main/bootstrap/<area>.ts ' +
        'exporting register<Area>(deps), and call it from index.ts.',
    );
    return 1;
  }
  console.log(`index-size: OK ${name} has ${lines} lines, baseline is ${baseline}.`);
  if (lines < baseline) {
    console.log(
      `index-size: hint: ${name} shrank by ${baseline - lines} lines. ` +
        `Lower scripts/index-size.baseline to ${lines} in this PR.`,
    );
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  if (!(err instanceof InputError)) throw err;
  console.error(`index-size: ERROR ${err.message}`);
  process.exitCode = 2;
}
