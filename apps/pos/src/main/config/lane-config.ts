import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isDescopeProjectId, isRegionalDescopeProjectId } from '../operator/descope-client.js';
import { UPDATE_CHANNELS } from '../update/update-types.js';
import type { UpdateChannel } from '../update/update-types.js';

/**
 * RT-1346 (RT-1345 D1, D2) — the public, non-secret configuration a build can carry.
 *
 * A packaged POS installed from the downloaded installer has no Windows environment
 * variables. The build stamps `dist/lane-config.json` into the asar (next to
 * `build-identity.json`), so the API address, the Descope project id and the update
 * origin and channel travel inside the signed, integrity-protected app. Never in
 * `resources/`: that folder is writable by the cashier on a per-user install.
 *
 * ONE resolution rule for every setting (D2), `resolveLaneValue`:
 *
 *     process environment  ->  baked file  ->  refuse
 *
 * A non-blank environment value is authoritative, valid or not; it is never replaced
 * by the baked value behind its back (a bad override stays visible, today's
 * behaviour). The file is all-or-nothing: any bad field (unknown field, wrong shape,
 * a value that looks like a secret) refuses the WHOLE file with one log line, and
 * nothing of it is applied. The stamp step (`scripts/stamp-lane-config.ts`) uses the
 * same validator, so a file that would be refused at start-up is never built.
 *
 * Nothing here logs or returns a raw value in a refusal: field names and a closed
 * reason only.
 */

export const LANES = ['lab', 'pilot', 'production'] as const;
export type Lane = (typeof LANES)[number];

/** The file name inside `dist/` (and so inside the asar). */
export const LANE_CONFIG_FILE = 'lane-config.json';

export interface LaneConfig {
  readonly lane: Lane;
  /** Backend-Core base URL (https). */
  readonly apiBaseUrl?: string;
  /** Descope project id: a public client identifier, US region only. */
  readonly descopeProjectId?: string;
  /** Update origin (https). The origin confers no trust; the publisher pin does. */
  readonly updateOrigin?: string;
  readonly updateChannel?: UpdateChannel;
}

type OptionalField = Exclude<keyof LaneConfig, 'lane'>;

const OPTIONAL_FIELDS: readonly OptionalField[] = [
  'apiBaseUrl',
  'descopeProjectId',
  'updateOrigin',
  'updateChannel',
];

/** Every field the file may hold. Anything else refuses the file. */
export const LANE_CONFIG_FIELDS: readonly (keyof LaneConfig)[] = ['lane', ...OPTIONAL_FIELDS];

export type LaneConfigRefusalReason =
  | 'unreadable'
  | 'not_json'
  | 'not_an_object'
  | 'unknown_field'
  | 'missing_lane'
  | 'invalid_value'
  | 'looks_like_secret';

export type LaneConfigVerdict =
  | { readonly ok: true; readonly config: LaneConfig }
  | {
      readonly ok: false;
      readonly reason: LaneConfigRefusalReason;
      /** The offending field NAME, never its value. */
      readonly field?: string;
    };

/** Shapes of well-known credentials; a public configuration value never matches one. */
const SECRET_SHAPES: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /-----BEGIN [A-Z ]+-----/, // a PEM block
  /\bBearer\s+\S/i,
  /\b(?:sk|rk|pk)_(?:live|test)_/i, // Stripe style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens
  /\bxox[abprs]-/, // Slack tokens
];

function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(value));
}

/** An https URL that carries no credential, query or fragment: public by construction. */
function isPublicHttpsUrl(value: string): boolean {
  if (value !== value.trim() || /[?#\s]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
    );
  } catch {
    return false;
  }
}

function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

function isUpdateChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/** The Descope id shape plus the US-region rule `resolve-exchanger` applies today. */
function isUsDescopeProjectId(value: string): boolean {
  return isDescopeProjectId(value) && !isRegionalDescopeProjectId(value);
}

const FIELD_SHAPES: Readonly<Record<keyof LaneConfig, (value: string) => boolean>> = {
  lane: isLane,
  apiBaseUrl: isPublicHttpsUrl,
  descopeProjectId: isUsDescopeProjectId,
  updateOrigin: isPublicHttpsUrl,
  updateChannel: isUpdateChannel,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field name from a file is logged only when it looks like a name (it is untrusted text). */
function safeFieldName(key: string): string {
  return /^[A-Za-z0-9_]{1,40}$/.test(key) ? key : '(invalid name)';
}

function refuse(reason: LaneConfigRefusalReason, field?: string): LaneConfigVerdict {
  return field === undefined ? { ok: false, reason } : { ok: false, reason, field };
}

/**
 * Validates a parsed `lane-config.json` (or the stamp step's input object). Only
 * listed fields; `lane` is required; every value is a string of the field's shape.
 * The first problem refuses the whole object.
 */
export function validateLaneConfig(raw: unknown): LaneConfigVerdict {
  if (!isRecord(raw)) return refuse('not_an_object');
  const known = LANE_CONFIG_FIELDS as readonly string[];
  const unknown = Object.keys(raw).find((key) => !known.includes(key));
  if (unknown !== undefined) return refuse('unknown_field', safeFieldName(unknown));
  if (!('lane' in raw)) return refuse('missing_lane', 'lane');
  for (const field of LANE_CONFIG_FIELDS) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (typeof value !== 'string') return refuse('invalid_value', field);
    if (looksLikeSecret(value)) return refuse('looks_like_secret', field);
    if (!FIELD_SHAPES[field](value)) return refuse('invalid_value', field);
  }
  // The channel drives the telemetry class and the heartbeat channel (`lab` is the lab
  // class), so a pilot or production build must not claim it.
  if (raw['updateChannel'] === 'lab' && raw['lane'] !== 'lab') {
    return refuse('invalid_value', 'updateChannel');
  }
  return { ok: true, config: pickValidated(raw) };
}

/** A fresh object holding only the allowed, already validated fields. */
function pickValidated(raw: Record<string, unknown>): LaneConfig {
  const lane = raw['lane'] as Lane;
  const optional = OPTIONAL_FIELDS.filter((field) => field in raw).map(
    (field) => [field, raw[field]] as const,
  );
  return { lane, ...Object.fromEntries(optional) };
}

/** Parses the file text; never throws, never echoes a value. */
export function parseLaneConfig(text: string): LaneConfigVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse('not_json');
  }
  return validateLaneConfig(raw);
}

export interface LaneConfigLogger {
  info(payload: object, msg: string): void;
  warn(payload: object, msg: string): void;
}

function isMissingFile(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Reads and validates the baked file. An absent file is today's behaviour (null, one
 * info line). A file that cannot be read or fails validation is refused entirely
 * (null, one warning with the reason and the field name, never a value).
 */
export function loadLaneConfig(
  file: string,
  logger?: LaneConfigLogger,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): LaneConfig | null {
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    if (isMissingFile(err)) {
      logger?.info({ event: 'lane_config.absent' }, 'no baked lane configuration');
    } else {
      logger?.warn(
        { event: 'lane_config.refused', reason: 'unreadable' },
        'baked lane configuration refused',
      );
    }
    return null;
  }
  const verdict = parseLaneConfig(text);
  if (verdict.ok) return verdict.config;
  logger?.warn(
    { event: 'lane_config.refused', reason: verdict.reason, field: verdict.field },
    'baked lane configuration refused; none of it is applied',
  );
  return null;
}

/** What a setting resolved from. Logged by name, never with the value. */
export type ConfigSource = 'env' | 'baked' | 'none';

export interface ResolvedValue {
  /** The raw environment string when the environment supplied it, else the baked value. */
  readonly value: string | undefined;
  readonly source: ConfigSource;
}

/**
 * THE precedence rule (D2): a non-blank environment value wins; otherwise the baked
 * value; otherwise nothing (the caller then refuses, fail closed). A blank or
 * whitespace-only environment value counts as unset, as it does today; a caller whose
 * setting is stricter today (the update channel: only the empty string is unset, so a
 * stray space is refused) passes its own `isBlank`.
 */
export function resolveLaneValue(
  fromEnv: string | undefined,
  baked: string | undefined,
  isBlank: (value: string) => boolean = (value) => value.trim().length === 0,
): ResolvedValue {
  if (typeof fromEnv === 'string' && !isBlank(fromEnv)) {
    return { value: fromEnv, source: 'env' };
  }
  if (baked !== undefined) return { value: baked, source: 'baked' };
  return { value: undefined, source: 'none' };
}

// The baked file is read once, at start-up, by `initBakedLaneConfig`. The resolvers
// read it through this holder so their ~12 call sites keep their signatures.
let bakedConfig: LaneConfig | null = null;

/** The configuration this build carries, or null (no file, or a refused one). */
export function getBakedLaneConfig(): LaneConfig | null {
  return bakedConfig;
}

/** Replaces the holder. Production calls it once through `initBakedLaneConfig`. */
export function setBakedLaneConfig(config: LaneConfig | null): void {
  bakedConfig = config;
}

export const ENV_API_BASE_URL = 'VITE_API_BASE_URL';
export const ENV_DESCOPE_PROJECT_ID = 'DESCOPE_PROJECT_ID';
export const ENV_UPDATE_ORIGIN = 'ELECTRON_UPDATE_FEED_URL';
export const ENV_UPDATE_CHANNEL = 'POS_PULSE_UPDATE_CHANNEL';

type Env = Readonly<Record<string, string | undefined>>;

export interface InitBakedLaneConfigDeps {
  /** `app.getAppPath()`: the asar root, which holds `dist/lane-config.json`. */
  readonly appPath: string;
  readonly logger: LaneConfigLogger;
  readonly env: Env;
}

/**
 * Loads the baked file into the holder and logs where each setting comes from.
 * Best-effort: any failure leaves the holder empty (today's behaviour).
 */
export function initBakedLaneConfig(deps: InitBakedLaneConfigDeps): void {
  let config: LaneConfig | null = null;
  try {
    config = loadLaneConfig(path.join(deps.appPath, 'dist', LANE_CONFIG_FILE), deps.logger);
  } catch {
    config = null;
  }
  setBakedLaneConfig(config);
  if (config === null) return;
  deps.logger.info(
    {
      event: 'lane_config.loaded',
      lane: config.lane,
      api_base_url: resolveLaneValue(deps.env[ENV_API_BASE_URL], config.apiBaseUrl).source,
      descope_project_id: resolveLaneValue(
        deps.env[ENV_DESCOPE_PROJECT_ID],
        config.descopeProjectId,
      ).source,
      update_origin: resolveLaneValue(deps.env[ENV_UPDATE_ORIGIN], config.updateOrigin).source,
      update_channel: resolveLaneValue(
        deps.env[ENV_UPDATE_CHANNEL],
        config.updateChannel,
        (value) => value === '',
      ).source,
    },
    'baked lane configuration loaded',
  );
}

/**
 * D4 — the two settings whose absence makes the terminal unusable. After resolution:
 * `server_address` is missing or not a URL; `identity_provider` is the Descope project
 * id missing, malformed or regional. A different `OPERATOR_IDENTITY_PROVIDER` is not a
 * missing setting (it keeps its own generic refusal).
 */
export type RuntimeConfigProblem = 'server_address' | 'identity_provider';

/** An http(s) URL with a host. `host:8443` and `file:` parse as URLs but are not an address. */
function isUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export function assessRuntimeConfig(
  env: Env,
  baked: LaneConfig | null = getBakedLaneConfig(),
): RuntimeConfigProblem | null {
  const address = resolveLaneValue(env[ENV_API_BASE_URL], baked?.apiBaseUrl).value;
  if (address === undefined || !isUrl(address)) return 'server_address';
  const provider = (env['OPERATOR_IDENTITY_PROVIDER'] ?? '').trim().toLowerCase();
  if (provider !== '' && provider !== 'descope') return null;
  const projectId = resolveLaneValue(env[ENV_DESCOPE_PROJECT_ID], baked?.descopeProjectId).value;
  if (projectId === undefined || !isUsDescopeProjectId(projectId.trim())) {
    return 'identity_provider';
  }
  return null;
}
