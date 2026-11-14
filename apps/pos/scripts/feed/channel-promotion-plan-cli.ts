import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CHANNELS,
  planPromotion,
  type ArtifactFacts,
  type LaneState,
  type PlanResult,
  type PromotionRequest,
  type ReleaseFacts,
} from './channel-promotion-plan.js';

/**
 * RT-1393 — read-only CLI around `planPromotion`. It reads a release directory, a lane
 * directory (a local copy of the feed) and a request file, and prints the plan or the refusal
 * as JSON. It only reads files; executing the plan belongs to a later promotion workflow.
 *
 *   tsx scripts/feed/channel-promotion-plan-cli.ts \
 *     --request <request.json> --release-dir <dir> --lane-dir <dir>
 *
 * request.json: the PromotionRequest fields plus `publisher` (the Authenticode subject the
 * caller read from the installer), `installer`, optional `blockmap` and `channelFile` (file
 * names inside the release directory; the manifest is `release-manifest.json`).
 * Exit codes: 0 plan, 1 refused, 2 bad usage or unreadable input.
 */

interface RequestFile {
  readonly request: PromotionRequest;
  readonly publisher: string;
  readonly installer: string;
  readonly blockmap?: string | undefined;
  readonly channelFile: string;
}

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const REQUIRED_FLAGS = ['request', 'release-dir', 'lane-dir'] as const;
type Flag = (typeof REQUIRED_FLAGS)[number];

/** `--name value` pairs; exactly the three required flags. */
function readArgs(argv: readonly string[]): Record<Flag, string> {
  if (argv.length !== REQUIRED_FLAGS.length * 2) throw new Error('bad arguments');
  const pairs = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) pairs.set(String(argv[i]), String(argv[i + 1]));
  const value = (flag: Flag): string => {
    const found = pairs.get(`--${flag}`);
    if (found === undefined) throw new Error(`--${flag} is required`);
    return found;
  };
  return {
    request: value('request'),
    'release-dir': value('release-dir'),
    'lane-dir': value('lane-dir'),
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`request.json needs ${name} as a string`);
  return value;
}

function parseRequestFile(text: string): RequestFile {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const { publisher, installer, blockmap, channelFile, ...request } = raw;
  return {
    request: request as unknown as PromotionRequest,
    publisher: requireString(publisher, 'publisher'),
    installer: requireString(installer, 'installer'),
    blockmap: blockmap === undefined ? undefined : requireString(blockmap, 'blockmap'),
    channelFile: requireString(channelFile, 'channelFile'),
  };
}

/** Reads one release from `dir`: the manifest, the channel file and the artifact digests. */
export function readRelease(dir: string, spec: RequestFile): ReleaseFacts {
  const installerBytes = readFileSync(path.join(dir, spec.installer));
  const blockmap: ArtifactFacts | undefined =
    spec.blockmap === undefined
      ? undefined
      : { name: spec.blockmap, sha256: sha256(readFileSync(path.join(dir, spec.blockmap))) };
  return {
    manifest: JSON.parse(readFileSync(path.join(dir, 'release-manifest.json'), 'utf8')) as unknown,
    channelFileName: spec.channelFile,
    channelFileText: readFileSync(path.join(dir, spec.channelFile), 'utf8'),
    installer: {
      name: spec.installer,
      sha256: sha256(installerBytes),
      sha512: createHash('sha512').update(installerBytes).digest('base64'),
      size: installerBytes.length,
    },
    blockmap,
    publisher: spec.publisher,
  };
}

/** Reads the lane state from a local copy of one lane directory. */
export function readLaneState(dir: string): LaneState {
  return { channels: readChannels(dir), files: readArtifactDigests(dir) };
}

function readChannels(dir: string): LaneState['channels'] {
  const present = CHANNELS.filter((channel) => existsSync(path.join(dir, `${channel}.yml`)));
  return Object.fromEntries(
    present.map((channel) => [channel, readFileSync(path.join(dir, `${channel}.yml`), 'utf8')]),
  );
}

/** Every regular, non-channel file of the lane: name -> sha256. */
function readArtifactDigests(dir: string): Record<string, string> {
  const isArtifact = (name: string): boolean =>
    !name.endsWith('.yml') && lstatSync(path.join(dir, name)).isFile();
  return Object.fromEntries(
    readdirSync(dir)
      .filter(isArtifact)
      .map((name) => [name, sha256(readFileSync(path.join(dir, name)))]),
  );
}

/** Runs the CLI; returns the exit code. */
export function runCli(
  argv: readonly string[],
  print: (line: string) => void = console.log,
): number {
  let result: PlanResult;
  try {
    const args = readArgs(argv);
    const spec = parseRequestFile(readFileSync(args.request, 'utf8'));
    result = planPromotion(
      spec.request,
      readRelease(args['release-dir'], spec),
      readLaneState(args['lane-dir']),
    );
  } catch (error) {
    print(JSON.stringify({ ok: false, reason: 'usage', detail: (error as Error).message }));
    return 2;
  }
  print(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function isEntryPoint(entry: string | undefined): boolean {
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint(process.argv[1])) process.exitCode = runCli(process.argv.slice(2));
