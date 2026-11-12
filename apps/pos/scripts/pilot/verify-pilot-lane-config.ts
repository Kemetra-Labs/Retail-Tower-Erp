/**
 * RT-1347 (RT-1345 D1, S2) — the pilot release build proves its package carries the pilot lane
 * configuration, before any signing job sees the package.
 *
 *   tsx scripts/pilot/verify-pilot-lane-config.ts [path/to/app.asar]
 *
 * Reads `dist/lane-config.json` OUT OF the packaged `app.asar` (default
 * `dist-electron/win-unpacked/resources/app.asar`): the file the installed app will read, inside the
 * integrity-protected archive, not the copy `npm run build` left in `dist/`. It accepts exactly one shape:
 *
 *   - the same validator the POS runs at start-up accepts the file (`parseLaneConfig`);
 *   - `lane` is `pilot`;
 *   - `apiBaseUrl` and `descopeProjectId` are both present: a stamp that holds only the lane is refused;
 *   - `updateOrigin` and `updateChannel` are absent (RT-1345 D5, the pilot update path, is not approved);
 *   - when the release variables are in the environment (`POS_PILOT_LANE_API_BASE_URL`,
 *     `POS_PILOT_LANE_DESCOPE_PROJECT_ID`, as the workflow passes them), the packaged values equal them, so a
 *     stale or altered `dist/lane-config.json` cannot carry another backend into a release. A mismatch names the
 *     field and the variable, never a value.
 *
 * On success it prints the lane and the SHA-256 of the file's bytes as they sit in the archive, and appends
 * `lane_config_digest=sha256:<hex>` to `$GITHUB_OUTPUT` when that is set: the release manifest records it.
 * On failure it prints a GitHub error annotation per problem and exits 1. It never prints a configuration
 * value, only field names and a closed reason (the values are public, but the log is not the place for them).
 *
 * Reads only the archive header and the one entry (stdlib; `@electron/asar` is not a direct dependency).
 * Read-only: nothing here writes to the build output.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANE_CONFIG_FILE, parseLaneConfig } from '../../src/main/config/lane-config.js';
import type { LaneConfig } from '../../src/main/config/lane-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ASAR = path.join(ROOT, 'dist-electron', 'win-unpacked', 'resources', 'app.asar');

/** `dist/lane-config.json` inside the archive. */
const ENTRY = ['dist', LANE_CONFIG_FILE] as const;

/** A lane configuration is a few hundred bytes; anything near this is not one. */
const MAX_ENTRY_BYTES = 64 * 1024;
/** The archive header lists every packaged file; a few MB is normal. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const PREFIX_BYTES = 16;

type Env = Readonly<Record<string, string | undefined>>;

function readExact(fd: number, position: number, length: number, what: string): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error(`asar archive is truncated (${what})`);
    done += read;
  }
  return buffer;
}

interface AsarNode {
  readonly files?: Readonly<Record<string, AsarNode>>;
  readonly size?: number;
  readonly offset?: string;
  readonly unpacked?: boolean;
  readonly integrity?: { readonly algorithm?: string; readonly hash?: string };
}

/**
 * The header of an asar archive: Chromium Pickle `[4][pickleSize][payloadSize][jsonLength][json]`, and the
 * file bodies start at `8 + pickleSize`. Every unclear situation throws.
 */
function readHeader(fd: number, archiveBytes: number): { tree: AsarNode; dataStart: number } {
  if (archiveBytes < PREFIX_BYTES) {
    throw new Error(`asar archive is shorter than its ${String(PREFIX_BYTES)}-byte prefix`);
  }
  const prefix = readExact(fd, 0, PREFIX_BYTES, 'prefix');
  const pickleSize = prefix.readUInt32LE(4);
  const payloadSize = prefix.readUInt32LE(8);
  const jsonLength = prefix.readUInt32LE(12);
  const consistent =
    prefix.readUInt32LE(0) === 4 && payloadSize === pickleSize - 4 && jsonLength <= payloadSize - 4;
  if (!consistent || jsonLength > MAX_HEADER_BYTES) throw new Error('not an asar archive');
  const json = readExact(fd, PREFIX_BYTES, jsonLength, 'header');
  let tree: unknown;
  try {
    tree = JSON.parse(json.toString('utf8'));
  } catch {
    throw new Error('not an asar archive (the header is not JSON)');
  }
  return { tree: tree as AsarNode, dataStart: 8 + pickleSize };
}

function findNode(tree: AsarNode, entry: readonly string[]): AsarNode {
  let node: AsarNode = tree;
  for (const part of entry) {
    const next =
      node.files !== undefined && Object.hasOwn(node.files, part) ? node.files[part] : undefined;
    if (next === undefined) throw new Error(`${entry.join('/')} is not in the archive`);
    node = next;
  }
  return node;
}

/**
 * electron-builder records a SHA-256 of each packed file in the header (`integrity.hash`). It must be there and
 * must equal the bytes just read: that proves the offset and size were read the way the archive means them.
 * A missing or unknown hash is refused (fail closed), never skipped.
 */
function assertIntegrity(node: AsarNode, bytes: Buffer, name: string): void {
  const { integrity } = node;
  if (integrity?.algorithm !== 'SHA256' || typeof integrity.hash !== 'string') {
    throw new Error(`${name} has no SHA256 integrity hash in the archive header`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== integrity.hash.toLowerCase()) {
    throw new Error(`${name} does not match the integrity hash in the archive header`);
  }
}

/** The bytes of one packed file of an asar archive, as stored. */
export function readAsarEntry(asarFile: string, entry: readonly string[]): Buffer {
  const fd = openSync(asarFile, 'r');
  try {
    const archiveBytes = fstatSync(fd).size;
    const { tree, dataStart } = readHeader(fd, archiveBytes);
    const node = findNode(tree, entry);
    const name = entry.join('/');
    const { size, offset } = node;
    if (node.unpacked === true || typeof offset !== 'string' || typeof size !== 'number') {
      throw new Error(`${name} is not a packed file of the archive`);
    }
    if (!/^\d{1,15}$/.test(offset) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${name} has a malformed archive entry`);
    }
    if (size > MAX_ENTRY_BYTES)
      throw new Error(`${name} is larger than ${String(MAX_ENTRY_BYTES)} bytes`);
    const start = dataStart + Number(offset);
    if (start + size > archiveBytes) throw new Error(`asar archive is truncated (${name})`);
    const bytes = readExact(fd, start, size, name);
    assertIntegrity(node, bytes, name);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export type PilotLaneVerdict =
  | { readonly ok: true; readonly digest: string; readonly config: LaneConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The problems of a parsed file that the shared validator accepted but the pilot lane does not. */
function pilotProblems(config: LaneConfig): string[] {
  const problems: string[] = [];
  if (config.lane !== 'pilot') problems.push("lane is not 'pilot'");
  if (config.apiBaseUrl === undefined) problems.push('apiBaseUrl is missing');
  if (config.descopeProjectId === undefined) problems.push('descopeProjectId is missing');
  if (config.updateOrigin !== undefined) {
    problems.push('updateOrigin must be absent for the pilot lane (RT-1345 D5)');
  }
  if (config.updateChannel !== undefined) {
    problems.push('updateChannel must be absent for the pilot lane (RT-1345 D5)');
  }
  return problems;
}

/** The values the release expects the packaged file to carry; a field left out is not compared. */
export interface ExpectedPilotValues {
  readonly apiBaseUrl?: string;
  readonly descopeProjectId?: string;
}

function mismatchProblems(config: LaneConfig, expected: ExpectedPilotValues): string[] {
  const problems: string[] = [];
  if (expected.apiBaseUrl !== undefined && config.apiBaseUrl !== expected.apiBaseUrl) {
    problems.push('apiBaseUrl does not match the release variable POS_PILOT_LANE_API_BASE_URL');
  }
  if (
    expected.descopeProjectId !== undefined &&
    config.descopeProjectId !== expected.descopeProjectId
  ) {
    problems.push(
      'descopeProjectId does not match the release variable POS_PILOT_LANE_DESCOPE_PROJECT_ID',
    );
  }
  return problems;
}

/** The expected values from the workflow's variables (trimmed, as the stamp step trims); blank means none. */
function expectedFromEnv(env: Env): ExpectedPilotValues {
  const api = (env['POS_PILOT_LANE_API_BASE_URL'] ?? '').trim();
  const project = (env['POS_PILOT_LANE_DESCOPE_PROJECT_ID'] ?? '').trim();
  return {
    ...(api === '' ? {} : { apiBaseUrl: api }),
    ...(project === '' ? {} : { descopeProjectId: project }),
  };
}

/** Checks the bytes of a packaged `lane-config.json`; the digest is of exactly these bytes. */
export function checkPilotLaneConfig(
  bytes: Buffer,
  expected: ExpectedPilotValues = {},
): PilotLaneVerdict {
  const verdict = parseLaneConfig(bytes.toString('utf8'));
  if (!verdict.ok) {
    const field = verdict.field === undefined ? '' : ` (${verdict.field})`;
    return { ok: false, problems: [`${LANE_CONFIG_FILE} is refused: ${verdict.reason}${field}`] };
  }
  const problems = [
    ...pilotProblems(verdict.config),
    ...mismatchProblems(verdict.config, expected),
  ];
  if (problems.length > 0) return { ok: false, problems };
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return { ok: true, digest, config: verdict.config };
}

/** Verifies a packaged app.asar; returns the process exit code (0 ok, 1 refused or unreadable). */
export function verifyPackagedPilotLane(
  asarFile: string,
  env: Env,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): number {
  const fail = (problem: string): number => {
    logError(`::error title=Pilot lane configuration::${problem}`);
    return 1;
  };
  let bytes: Buffer;
  try {
    bytes = readAsarEntry(asarFile, ENTRY);
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : 'unreadable';
    return fail(`the packaged app has no readable ${LANE_CONFIG_FILE}: ${why}`);
  }
  const verdict = checkPilotLaneConfig(bytes, expectedFromEnv(env));
  if (!verdict.ok) {
    for (const problem of verdict.problems) fail(problem);
    return 1;
  }
  const output = env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    appendFileSync(output, `lane_config_digest=${verdict.digest}\n`);
  }
  log(
    `[verify-pilot-lane-config] ${LANE_CONFIG_FILE} in the packaged app: lane pilot, API address and Descope ` +
      `project id present, no update origin or channel; ${verdict.digest}`,
  );
  return 0;
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript)
  process.exit(verifyPackagedPilotLane(process.argv[2] ?? DEFAULT_ASAR, process.env));
