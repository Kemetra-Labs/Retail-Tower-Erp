/**
 * RT-217 / RT-889 — refresh the vendored Backend-Core OpenAPI snapshot from the
 * in-tree Backend-Core contract of this monorepo.
 *
 *   npm run contracts:repin                       # re-pin every pinned file at `main`
 *   npm run contracts:repin -- --ref <sha|branch|tag>
 *   npm run contracts:repin -- --add pos-cashier-admissions.openapi.yaml
 *   npm run contracts:repin -- --remove pos-payments/vouchers.yaml
 *
 * Paths are relative to `services/backend-core/packages/contracts/openapi/`. The
 * ref is resolved to a full commit SHA of this repository first and every file is
 * read AT THAT SHA from local git (`git rev-parse <commit>:<path>`, `git cat-file
 * blob`), so a snapshot always comes from exactly one commit. Each file's bytes
 * must hash to the blob SHA git reports for it, or nothing is written. No network
 * and no GitHub API (RT-889): pin a commit that is on `main`, and fetch it first
 * if the clone is shallow.
 *
 * It never runs in CI (`pos.yml` stays offline and reads only the committed
 * snapshot). A re-pin also regenerates `src/shared/api-types.ts` (RT-869: codegen
 * reads only this contract set), so `codegen:verify` stays green. After a re-pin,
 * run `npx vitest run tests/contract/backend-core` and commit
 * `contracts/backend-core/` and `src/shared/api-types.ts` together with any
 * registry change.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTRACTS_DIR, DEFAULT_OUT_PATH, generateApiTypes } from './codegen-api.js';
import {
  BACKEND_CORE_OPENAPI_ROOT,
  BACKEND_CORE_REPO,
  assertSafeRelativePath,
  formatPin,
  gitBlobSha,
  parsePin,
  parseRepinArgs,
  type PinnedFile,
} from './contracts-pin.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'contracts', 'backend-core');
const OPENAPI_DIR = path.join(SNAPSHOT_DIR, 'openapi');
const PIN_PATH = path.join(SNAPSHOT_DIR, 'PIN');

/** `git` in this repository. Resolved from PATH: a developer tool run from the caller's shell. */
function git(args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** `git` output as trimmed text, or null when git fails (unknown ref, missing path). */
function gitText(args: readonly string[]): string | null {
  try {
    return git(args).toString('utf-8').trim();
  } catch {
    return null;
  }
}

function resolveCommit(ref: string): string {
  const sha = gitText(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not resolve ref "${ref}" to a commit of ${BACKEND_CORE_REPO}`);
  }
  return sha;
}

function readPinned(commit: string, rel: string): { file: PinnedFile; bytes: Buffer } {
  const spec = `${commit}:${BACKEND_CORE_OPENAPI_ROOT}/${rel}`;
  const sha = gitText(['rev-parse', '--verify', '--quiet', spec]) ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha) || gitText(['cat-file', '-t', sha]) !== 'blob') {
    throw new Error(`${rel} is not a file at ${commit}`);
  }
  const bytes = git(['cat-file', 'blob', sha]);
  const blobSha = gitBlobSha(bytes);
  if (blobSha !== sha) {
    throw new Error(`${rel}: read blob ${blobSha} != git blob ${sha}; aborting`);
  }
  return { file: { path: rel, blobSha }, bytes };
}

function listVendored(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listVendored(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

async function main(): Promise<void> {
  const args = parseRepinArgs(process.argv.slice(2));
  const current = existsSync(PIN_PATH)
    ? parsePin(readFileSync(PIN_PATH, 'utf-8')).files.map((f) => f.path)
    : [];
  const wanted = [...new Set([...current, ...args.add])].filter((p) => !args.remove.includes(p));
  wanted.forEach(assertSafeRelativePath);
  if (wanted.length === 0) throw new Error('nothing to pin: pass --add <path>');

  const commit = resolveCommit(args.ref);
  // Read everything before touching the snapshot, so a failure leaves it intact.
  const fetched = wanted.map((rel) => readPinned(commit, rel));

  const stale = listVendored(OPENAPI_DIR).filter((p) => !wanted.includes(p));
  rmSync(OPENAPI_DIR, { recursive: true, force: true });
  for (const { file, bytes } of fetched) {
    const target = path.join(OPENAPI_DIR, ...file.path.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(
    PIN_PATH,
    formatPin({
      repo: BACKEND_CORE_REPO,
      commit,
      source: BACKEND_CORE_OPENAPI_ROOT,
      files: fetched.map((f) => f.file),
    }),
  );
  await generateApiTypes({ contractsDir: DEFAULT_CONTRACTS_DIR, outPath: DEFAULT_OUT_PATH });
  process.stdout.write(
    `Pinned ${String(fetched.length)} Backend-Core contract(s) at ${commit}:\n` +
      fetched.map((f) => `  ${f.file.path} ${f.file.blobSha}\n`).join('') +
      stale.map((p) => `  removed ${p}\n`).join(''),
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(
    `contracts:repin failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
