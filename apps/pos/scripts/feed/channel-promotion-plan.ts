import { createHash } from 'node:crypto';
import { dump, load } from 'js-yaml';

/**
 * RT-1393 (RT-1390 decision record, sections 4 and 5) — the offline, fail-closed plan for one
 * promotion or halt of a POS update feed.
 *
 * Given the facts of one attested release (its manifest, channel file, installer and blockmap
 * digests, and the Authenticode publisher the caller read from the installer), the feed state
 * of one trust lane and a request, it returns either an ordered write plan or a refusal with a
 * stable reason code. It performs no network call and writes nothing: a later promotion
 * workflow executes the plan.
 *
 * Rules (owner decisions O-2 and O-6 of 2026-11-14):
 *   - one directory per trust lane; a lane is one signing class and one publisher pin; fan-out
 *     to earlier channels never leaves the lane, and a lab-marked publisher never leaves the
 *     lab lane;
 *   - installers and blockmaps are immutable: written first, never overwritten with other bytes;
 *     channel files are written last, earliest stage first;
 *   - a promotion never lowers a channel; only a halt does, with a reason, latest stage first.
 */

const LANES = ['lab', 'pilot', 'production'] as const;
type Lane = (typeof LANES)[number];

/** Channels in stage order: a release reaches `lab`, then `canary`, then `stable`. */
export const CHANNELS = ['lab', 'canary', 'stable'] as const;
type Channel = (typeof CHANNELS)[number];

interface LaneRule {
  /** `product` in release-manifest.json (.github/release/manifest.py). */
  readonly product: string;
  /** `signing` in the manifest; `undefined` means the field must be absent (the lab product). */
  readonly signing: string | undefined;
  readonly channels: readonly Channel[];
  readonly labPublisherAllowed: boolean;
}

/**
 * The lane rules as data. The lab product carries no `signing` field and serves only `lab`;
 * the pilot product carries `signing: pilot` (RT-1294); `production` is reserved for RT-321.
 * Whether the pilot lane gets a feed at all is RT-1345 D5/D6: it is supported here as data only.
 */
const LANE_RULES: Readonly<Record<Lane, LaneRule>> = {
  lab: { product: 'pos', signing: undefined, channels: ['lab'], labPublisherAllowed: true },
  pilot: { product: 'pos-pilot', signing: 'pilot', channels: CHANNELS, labPublisherAllowed: false },
  production: {
    product: 'pos',
    signing: 'production',
    channels: CHANNELS,
    labPublisherAllowed: false,
  },
};

type RefusalReason =
  | 'unknown_lane'
  | 'unknown_channel'
  | 'missing_evidence'
  | 'lab_publisher_outside_lab'
  | 'signing_mismatch'
  | 'publisher_mismatch'
  | 'manifest_mismatch'
  | 'channel_file_invalid'
  | 'channel_file_unsafe_reference'
  | 'channel_file_mismatch'
  | 'invalid_staging_percentage'
  | 'staging_percentage_lowered'
  | 'stage_skipped'
  | 'version_not_higher'
  | 'artifact_name_reused'
  | 'artifact_name_unsafe'
  | 'halt_reason_missing'
  | 'halt_not_lower'
  | 'halt_artifact_missing';

export interface ArtifactFacts {
  readonly name: string;
  /** `sha256:<64 hex>`, as release-manifest.json records digests. */
  readonly sha256: string;
}

interface InstallerFacts extends ArtifactFacts {
  /** Base64 SHA-512, as electron-builder writes it into the channel file. */
  readonly sha512: string;
  readonly size: number;
}

export interface ReleaseFacts {
  /** The parsed release-manifest.json. */
  readonly manifest: unknown;
  readonly channelFileName: string;
  readonly channelFileText: string;
  readonly installer: InstallerFacts;
  readonly blockmap?: ArtifactFacts | undefined;
  /** The Authenticode signer subject the caller read from the installer itself. */
  readonly publisher: string;
}

export interface LaneState {
  /** The current text of each channel file the lane serves. */
  readonly channels: Readonly<Partial<Record<Channel, string>>>;
  /** Every artifact already on the lane: file name -> `sha256:<hex>`. */
  readonly files: Readonly<Record<string, string>>;
}

export type PromotionRequest =
  | {
      readonly mode: 'promote';
      readonly lane: string;
      readonly stage: string;
      readonly pin: string;
      /** Link to the previous stage's exit evidence (https). */
      readonly evidenceRef: string;
      /** Required for `stable`, forbidden elsewhere: an integer 1..100. */
      readonly stagingPercentage?: number | undefined;
    }
  | {
      readonly mode: 'halt';
      readonly lane: string;
      readonly channel: string;
      readonly pin: string;
      readonly reason: string;
    };

type Write =
  | { readonly kind: 'artifact'; readonly file: string; readonly sha256: string }
  | {
      readonly kind: 'channel';
      readonly channel: Channel;
      readonly file: string;
      readonly version: string;
      readonly content: string;
    };

interface Plan {
  readonly mode: 'promote' | 'halt';
  readonly lane: Lane;
  readonly version: string;
  readonly writes: readonly Write[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

class Refused extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

function fail(reason: RefusalReason, detail: string): never {
  throw new Refused(reason, detail);
}

/** The single entry point: a plan, or a refusal. Never throws for bad input. */
export function planPromotion(
  request: PromotionRequest,
  release: ReleaseFacts,
  state: LaneState,
): PlanResult {
  try {
    const plan =
      request.mode === 'halt'
        ? planHalt(request, release, state)
        : planPromote(request, release, state);
    return { ok: true, plan };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason, detail: error.detail };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Promotion and halt

function planPromote(
  request: Extract<PromotionRequest, { mode: 'promote' }>,
  release: ReleaseFacts,
  state: LaneState,
): Plan {
  const lane = resolveLane(request.lane);
  const rule = LANE_RULES[lane];
  const stage = resolveChannel(rule, request.stage);
  if (!isHttpsUrl(request.evidenceRef))
    fail('missing_evidence', 'evidenceRef must be an https URL');
  const parsed = verifyRelease(lane, request.pin, release);
  const staging = checkStaging(stage, request.stagingPercentage);
  checkNoStageSkip(rule, stage, parsed, state);

  const channelWrites = fanOutWrites(rule, stage, parsed, state);
  if (targetNeedsWrite(stage, parsed, staging, currentChannel(state, stage))) {
    channelWrites.push(channelWrite(stage, parsed, staging));
  }
  return {
    mode: 'promote',
    lane,
    version: parsed.version,
    writes: [...artifactWrites(release, state), ...channelWrites],
  };
}

/** Earlier channels of the same lane that serve a lower version get the release too. */
function fanOutWrites(
  rule: LaneRule,
  stage: Channel,
  parsed: ChannelFile,
  state: LaneState,
): Write[] {
  const earlier = rule.channels.slice(0, rule.channels.indexOf(stage));
  return earlier
    .filter((channel) => servesLower(currentChannel(state, channel), parsed))
    .map((channel) => channelWrite(channel, parsed, undefined));
}

function planHalt(
  request: Extract<PromotionRequest, { mode: 'halt' }>,
  release: ReleaseFacts,
  state: LaneState,
): Plan {
  const lane = resolveLane(request.lane);
  const rule = LANE_RULES[lane];
  const channel = resolveChannel(rule, request.channel);
  if (!isString(request.reason) || request.reason.trim() === '')
    fail('halt_reason_missing', 'a halt needs a reason');
  const parsed = verifyRelease(lane, request.pin, release);
  presentArtifacts(release).forEach((artifact) => {
    if (state.files[artifact.name] !== artifact.sha256) {
      fail('halt_artifact_missing', `${artifact.name} is not on the feed with the release digest`);
    }
  });
  if (!servesHigher(currentChannel(state, channel), parsed)) {
    fail('halt_not_lower', `${channel} does not serve a version higher than ${parsed.version}`);
  }
  const affected = rule.channels.slice(rule.channels.indexOf(channel)).reverse();
  const writes = affected
    .filter((c) => servesHigher(currentChannel(state, c), parsed))
    .map((c) => channelWrite(c, parsed, undefined));
  return { mode: 'halt', lane, version: parsed.version, writes };
}

function servesLower(served: ChannelFile | null, release: ChannelFile): boolean {
  return served === null || compareVersions(served.version, release.version) < 0;
}

function servesHigher(served: ChannelFile | null, release: ChannelFile): boolean {
  return served !== null && compareVersions(served.version, release.version) > 0;
}

/** Whether the target channel is written; refuses a lower or equal version (stable may raise its %). */
function targetNeedsWrite(
  stage: Channel,
  release: ChannelFile,
  staging: number | undefined,
  current: ChannelFile | null,
): boolean {
  if (current === null) return true;
  const order = compareVersions(release.version, current.version);
  if (order > 0) return true;
  if (order === 0 && staging !== undefined) return raisesStaging(release, staging, current);
  return fail('version_not_higher', `${stage} already serves ${current.version}`);
}

/** Same version on stable: only a higher stagingPercentage is a change. */
function raisesStaging(release: ChannelFile, staging: number, current: ChannelFile): boolean {
  const served = current.stagingPercentage ?? 100;
  const at = `stable serves ${release.version} at ${String(served)}%`;
  if (!samePayload(release, current)) {
    fail('channel_file_mismatch', `${at} with another installer; a new version is required`);
  }
  if (staging < served) fail('staging_percentage_lowered', at);
  if (staging === served) fail('version_not_higher', at);
  return true;
}

/** Same installer reference, hash and size in both channel files. */
function samePayload(a: ChannelFile, b: ChannelFile): boolean {
  const sameFile = (f: FileEntry, i: number): boolean => {
    const g = b.files[i];
    return g !== undefined && f.url === g.url && f.sha512 === g.sha512 && f.size === g.size;
  };
  return (
    a.path === b.path &&
    a.sha512 === b.sha512 &&
    a.files.length === b.files.length &&
    a.files.every(sameFile)
  );
}

function checkStaging(stage: Channel, pct: number | undefined): number | undefined {
  if (stage !== 'stable') {
    requireNoStaging(pct);
    return undefined;
  }
  if (!isPercentage(pct)) {
    fail('invalid_staging_percentage', 'stable needs an integer stagingPercentage from 1 to 100');
  }
  return pct;
}

function requireNoStaging(pct: number | undefined): void {
  if (pct !== undefined) {
    fail('invalid_staging_percentage', 'stagingPercentage applies to stable only');
  }
}

function isPercentage(pct: number | undefined): pct is number {
  return pct !== undefined && Number.isInteger(pct) && pct >= 1 && pct <= 100;
}

function checkNoStageSkip(
  rule: LaneRule,
  stage: Channel,
  release: ChannelFile,
  state: LaneState,
): void {
  const previous = rule.channels[rule.channels.indexOf(stage) - 1];
  if (previous === undefined) return;
  if (servesLower(currentChannel(state, previous), release)) {
    fail('stage_skipped', `${previous} must serve ${release.version} or higher before ${stage}`);
  }
}

function presentArtifacts(release: ReleaseFacts): ArtifactFacts[] {
  return release.blockmap === undefined
    ? [release.installer]
    : [release.installer, release.blockmap];
}

function artifactWrites(release: ReleaseFacts, state: LaneState): Write[] {
  return presentArtifacts(release)
    .filter((artifact) => isNewArtifact(artifact, state.files[artifact.name]))
    .map((artifact) => ({ kind: 'artifact', file: artifact.name, sha256: artifact.sha256 }));
}

/** True for a file not yet on the feed; refuses a name already there with other bytes. */
function isNewArtifact(artifact: ArtifactFacts, existing: string | undefined): boolean {
  if (existing === undefined) return true;
  if (existing !== artifact.sha256) {
    fail('artifact_name_reused', `${artifact.name} exists with other bytes`);
  }
  return false;
}

function channelWrite(channel: Channel, parsed: ChannelFile, staging: number | undefined): Write {
  // The release's own stagingPercentage never carries over: only the request sets it.
  const rest = Object.fromEntries(
    Object.entries(parsed.raw).filter(([key]) => key !== 'stagingPercentage'),
  );
  const body = staging === undefined ? rest : { ...rest, stagingPercentage: staging };
  return {
    kind: 'channel',
    channel,
    file: `${channel}.yml`,
    version: parsed.version,
    content: dump(body, { lineWidth: 8000, noRefs: true }),
  };
}

// ---------------------------------------------------------------------------------------------
// Release verification

/** Every check on the release itself, in a fixed order; returns its parsed channel file. */
function verifyRelease(lane: Lane, pin: string, release: ReleaseFacts): ChannelFile {
  const rule = LANE_RULES[lane];
  checkPublisher(rule, lane, pin, release.publisher);
  presentArtifacts(release).forEach(checkArtifactName);
  const manifest = asRecord(release.manifest);
  if (manifest === null) fail('manifest_mismatch', 'the manifest is not an object');
  checkSigning(rule, lane, manifest);
  if (release.publisher !== pin || pin.trim() === '') {
    fail('publisher_mismatch', 'the installer publisher is not the lane pin');
  }
  const parsed = parseChannelFile(release.channelFileText, 'release');
  checkTag(rule, manifest['tag'], parsed.version);
  checkArtifacts(manifest['artifacts'], release);
  checkChannelMatchesInstaller(parsed, release.installer);
  return parsed;
}

/** An artifact lands in the lane directory: a bare file name that is not a channel file. */
function checkArtifactName(artifact: ArtifactFacts): void {
  if (!isSafeName(artifact.name) || artifact.name.toLowerCase().endsWith('.yml')) {
    fail('artifact_name_unsafe', `${artifact.name} is not a bare, non-channel file name`);
  }
}

const LAB_MARKER = /LAB TEST|NOT FOR PRODUCTION/i;

function isLabMarked(publisher: string, pin: string): boolean {
  return LAB_MARKER.test(publisher) || LAB_MARKER.test(pin);
}

function checkPublisher(rule: LaneRule, lane: Lane, pin: string, publisher: string): void {
  if (!rule.labPublisherAllowed && isLabMarked(publisher, pin)) {
    fail('lab_publisher_outside_lab', `a lab-marked publisher cannot enter the ${lane} lane`);
  }
}

function checkSigning(rule: LaneRule, lane: Lane, manifest: Record<string, unknown>): void {
  const signingOk =
    rule.signing === undefined ? !('signing' in manifest) : manifest['signing'] === rule.signing;
  if (manifest['product'] !== rule.product || !signingOk) {
    fail('signing_mismatch', `the release is not a ${lane}-lane release`);
  }
}

function checkTag(rule: LaneRule, tag: unknown, version: string): void {
  const prefix = `${rule.product}/v`;
  const tagged = taggedVersion(tag, prefix);
  if (tagged === null) fail('manifest_mismatch', `the manifest tag is not ${prefix}<version>`);
  if (tagged !== version) {
    fail('channel_file_mismatch', `the channel file version is not the tagged ${tagged}`);
  }
}

function taggedVersion(tag: unknown, prefix: string): string | null {
  if (!isString(tag) || !tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return SEMVER.test(version) ? version : null;
}

function checkArtifacts(value: unknown, release: ReleaseFacts): void {
  const artifacts = Array.isArray(value) ? value.map(asRecord) : [];
  const find = (name: string) => artifacts.find((a) => a?.['name'] === name) ?? null;
  matchArtifact(find('pos-installer'), release.installer, 'pos-installer');
  matchOptionalArtifact(find('pos-blockmap'), release.blockmap, 'pos-blockmap');
  // Required, as release-pos.yml emits it and deploy-pos-lab.yml requires it: an unattested
  // channel file would have its content copied into every channel write.
  const channelFacts = { name: release.channelFileName, sha256: sha256(release.channelFileText) };
  matchArtifact(find('pos-channel'), channelFacts, 'pos-channel');
}

/** Present in both or in neither; when present, the same file and digest. */
function matchOptionalArtifact(
  entry: Record<string, unknown> | null,
  facts: ArtifactFacts | undefined,
  label: string,
): void {
  if (facts !== undefined) {
    matchArtifact(entry, facts, label);
  } else if (entry !== null) {
    fail('manifest_mismatch', `${label} is in the manifest but not supplied`);
  }
}

function matchArtifact(
  entry: Record<string, unknown> | null,
  facts: ArtifactFacts,
  label: string,
): void {
  if (!sameArtifact(entry, facts)) {
    fail('manifest_mismatch', `${label} in the manifest is not ${facts.name} with its digest`);
  }
}

function sameArtifact(entry: Record<string, unknown> | null, facts: ArtifactFacts): boolean {
  return entry?.['file'] === facts.name && entry['digest'] === facts.sha256;
}

function checkChannelMatchesInstaller(parsed: ChannelFile, installer: InstallerFacts): void {
  const [file, ...more] = parsed.files;
  const matches =
    more.length === 0 &&
    file !== undefined &&
    parsed.path === installer.name &&
    parsed.sha512 === installer.sha512 &&
    file.url === installer.name &&
    file.sha512 === installer.sha512 &&
    file.size === installer.size;
  if (!matches) {
    fail('channel_file_mismatch', `the channel file does not describe ${installer.name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Channel files

interface FileEntry {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

interface ChannelFile {
  readonly version: string;
  readonly path: string;
  readonly sha512: string;
  readonly files: readonly FileEntry[];
  readonly stagingPercentage: number | undefined;
  readonly raw: Record<string, unknown>;
}

const ALLOWED_KEYS = new Set([
  'version',
  'files',
  'path',
  'sha512',
  'releaseDate',
  'releaseName',
  'releaseNotes',
  'stagingPercentage',
]);
/** A bare file name: no scheme, no directory, no `..`. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseChannelFile(text: string, label: string): ChannelFile {
  const raw = loadMapping(text, label);
  const files = parseFiles(raw['files'], label);
  const { version, path, sha512 } = raw;
  requireSafeReference(path, `the ${label} channel file path`);
  if (!isSemver(version)) fail('channel_file_invalid', `the ${label} channel file has no version`);
  if (!isString(path) || !isString(sha512)) {
    fail('channel_file_invalid', `the ${label} channel file lacks path or sha512`);
  }
  const pct = raw['stagingPercentage'];
  return {
    version,
    path,
    sha512,
    files,
    stagingPercentage: typeof pct === 'number' ? pct : undefined,
    raw,
  };
}

function loadMapping(text: string, label: string): Record<string, unknown> {
  const raw = tryLoad(text);
  if (raw === null) fail('channel_file_invalid', `the ${label} channel file is not a YAML mapping`);
  const unknown = Object.keys(raw).find((key) => !ALLOWED_KEYS.has(key));
  if (unknown !== undefined) {
    fail('channel_file_invalid', `the ${label} channel file has key ${unknown}`);
  }
  return raw;
}

function tryLoad(text: string): Record<string, unknown> | null {
  try {
    return asRecord(load(text));
  } catch {
    return null;
  }
}

function parseFiles(value: unknown, label: string): FileEntry[] {
  const entries = Array.isArray(value) ? value.map(parseFileEntry) : [];
  const files = entries.filter((f): f is FileEntry => f !== null);
  if (files.length === 0 || files.length !== entries.length) {
    fail('channel_file_invalid', `the ${label} channel file has no valid files[] entry`);
  }
  return files;
}

function parseFileEntry(value: unknown): FileEntry | null {
  const entry = asRecord(value);
  if (entry === null) return null;
  const { url, sha512, size } = entry;
  requireSafeReference(url, 'a files[].url');
  if (!isString(url) || !isString(sha512)) return null;
  return typeof size === 'number' ? { url, sha512, size } : null;
}

/** A reference that is present must be a bare file name (no URL, directory or `..`). */
function requireSafeReference(value: unknown, what: string): void {
  if (isString(value) && !isSafeName(value)) {
    fail('channel_file_unsafe_reference', `${what} is not a bare file name`);
  }
}

function currentChannel(state: LaneState, channel: Channel): ChannelFile | null {
  const text = state.channels[channel];
  return text === undefined ? null : parseChannelFile(text, `current ${channel}`);
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function resolveLane(value: string): Lane {
  const lane = LANES.find((l) => l === value);
  return lane ?? fail('unknown_lane', 'the lane is not lab, pilot or production');
}

function resolveChannel(rule: LaneRule, value: string): Channel {
  const channel = rule.channels.find((c) => c === value);
  return channel ?? fail('unknown_channel', 'the channel is not one this lane serves');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isSemver(value: unknown): value is string {
  return isString(value) && SEMVER.test(value);
}

function isSafeName(value: string): boolean {
  return SAFE_NAME.test(value) && !value.includes('..');
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const isMapping = typeof value === 'object' && value !== null && !Array.isArray(value);
  return isMapping ? (value as Record<string, unknown>) : null;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const NUMERIC = /^\d+$/;

/** Semantic-version precedence (no build metadata). Both values are already SEMVER-valid. */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = a.split(/-(.*)/s);
  const [coreB = '', preB] = b.split(/-(.*)/s);
  const core = compareCore(coreA, coreB);
  if (core !== 0) return core;
  // A version without a pre-release ranks above the same version with one.
  return comparePrerelease(preA?.split('.') ?? null, preB?.split('.') ?? null);
}

function compareCore(a: string, b: string): number {
  const [x, y] = [a.split('.'), b.split('.')];
  const diff = [0, 1, 2].map((i) => compareNumeric(x[i] ?? '0', y[i] ?? '0')).find((d) => d !== 0);
  return diff ?? 0;
}

/** Exact comparison of two decimal digit strings (no Number precision loss). */
function compareNumeric(p: string, q: string): number {
  const [bp, bq] = [BigInt(p), BigInt(q)];
  if (bp === bq) return 0;
  return bp < bq ? -1 : 1;
}

function comparePrerelease(a: readonly string[] | null, b: readonly string[] | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const order = compareIdentifier(a[i], b[i]);
    if (order !== 0) return order;
  }
  return 0;
}

function compareIdentifier(p: string | undefined, q: string | undefined): number {
  if (p === undefined || q === undefined) return compareMissing(p, q);
  return p === q ? 0 : compareValues(p, q);
}

/** A shorter pre-release (missing identifier) ranks lower. */
function compareMissing(p: string | undefined, q: string | undefined): number {
  if (p === q) return 0;
  return p === undefined ? -1 : 1;
}

/** Numeric identifiers compare numerically and rank below alphanumeric ones. */
function compareValues(p: string, q: string): number {
  const [pn, qn] = [NUMERIC.test(p), NUMERIC.test(q)];
  if (pn !== qn) return pn ? -1 : 1;
  if (pn) return compareNumeric(p, q);
  return p < q ? -1 : 1;
}
