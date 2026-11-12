/**
 * RT-1346 (RT-1345 D1) — writes `dist/lane-config.json`, the public configuration the
 * packaged POS reads when its process environment holds none
 * (`src/main/config/lane-config.ts`: environment, then this file, then refuse).
 *
 * Run by `stamp-build-identity.ts` at the end of `npm run build:main`, so the packaged
 * exe (`dist/**` is in the asar, covered by the asar integrity fuse) and `electron .`
 * after `npm run build` carry the same file. `dist/` is git-ignored: the file is never
 * committed. It is NOT written to `resources/`: that folder is writable by the cashier
 * on a per-user install, so a file there could redirect the API address.
 *
 * Inputs are dedicated build-time variables, deliberately NOT the runtime names
 * (`VITE_API_BASE_URL`, `DESCOPE_PROJECT_ID`, ...): a developer or lab machine that has
 * those set must never bake them into a build by accident. RT-1347 maps the release
 * lane's GitHub variables onto these names.
 *
 *   POS_LANE_CONFIG_LANE                `lab` | `pilot` | `production`  (required with any other input)
 *   POS_LANE_CONFIG_API_BASE_URL        Backend-Core base URL, https
 *   POS_LANE_CONFIG_DESCOPE_PROJECT_ID  Descope project id (US region)
 *   POS_LANE_CONFIG_UPDATE_ORIGIN       update origin, https
 *   POS_LANE_CONFIG_UPDATE_CHANNEL      `lab` | `canary` | `stable`
 *
 * Rules:
 *   - No input set (all blank): NO file, and a stale one is removed. The build behaves
 *     exactly as before this step existed.
 *   - Any input set: the whole object is validated by the SAME validator the POS runs
 *     at start-up. An unknown `POS_LANE_CONFIG_*` name, a missing lane, a bad shape or a
 *     value that looks like a secret fails the build (exit 1), writes no file and
 *     removes a stale one. Nothing is partly applied, and no value is ever printed.
 *   - The file holds public configuration only. There is no field for a secret.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LANE_CONFIG_FILE, validateLaneConfig } from '../src/main/config/lane-config.js';
import type { LaneConfig, LaneConfigRefusalReason } from '../src/main/config/lane-config.js';

const INPUT_PREFIX = 'POS_LANE_CONFIG_';

/** Build-time input variable -> file field. The complete list: nothing else is read. */
const INPUTS: Readonly<Record<string, keyof LaneConfig>> = {
  POS_LANE_CONFIG_LANE: 'lane',
  POS_LANE_CONFIG_API_BASE_URL: 'apiBaseUrl',
  POS_LANE_CONFIG_DESCOPE_PROJECT_ID: 'descopeProjectId',
  POS_LANE_CONFIG_UPDATE_ORIGIN: 'updateOrigin',
  POS_LANE_CONFIG_UPDATE_CHANNEL: 'updateChannel',
};

type Env = Readonly<Record<string, string | undefined>>;

export type LaneConfigStamp =
  | { readonly kind: 'none' }
  | { readonly kind: 'stamp'; readonly config: LaneConfig }
  | {
      readonly kind: 'refused';
      readonly reason: LaneConfigRefusalReason;
      /** The input variable (or field) NAME, never a value. */
      readonly name?: string;
    };

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

function inputName(field: string | undefined): string | undefined {
  return Object.entries(INPUTS).find(([, f]) => f === field)?.[0] ?? field;
}

/** The stamp the build-time inputs call for: none, a file, or a refusal. */
export function laneConfigStamp(env: Env): LaneConfigStamp {
  const unknown = Object.keys(env).find(
    (name) => name.startsWith(INPUT_PREFIX) && !(name in INPUTS) && isSet(env[name]),
  );
  if (unknown !== undefined) return { kind: 'refused', reason: 'unknown_field', name: unknown };
  const fields = Object.entries(INPUTS)
    .filter(([name]) => isSet(env[name]))
    .map(([name, field]) => [field, (env[name] ?? '').trim()] as const);
  if (fields.length === 0) return { kind: 'none' };
  const verdict = validateLaneConfig(Object.fromEntries(fields));
  return verdict.ok
    ? { kind: 'stamp', config: verdict.config }
    : { kind: 'refused', reason: verdict.reason, name: inputName(verdict.field) };
}

/** Writes the file, or removes a stale one when there is none (null). */
export function writeLaneConfigStamp(file: string, config: LaneConfig | null): void {
  if (config === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config)}\n`);
}

/** Stamps `file` from `env`; returns the process exit code (0 ok, 1 refused). */
export function stampLaneConfig(
  file: string,
  env: Env,
  log: (line: string) => void = console.log,
): number {
  const stamp = laneConfigStamp(env);
  writeLaneConfigStamp(file, stamp.kind === 'stamp' ? stamp.config : null);
  if (stamp.kind === 'none') {
    log('[stamp-lane-config] no lane configuration inputs: no file written');
    return 0;
  }
  if (stamp.kind === 'stamp') {
    log(`[stamp-lane-config] stamped lane configuration for the ${stamp.config.lane} lane`);
    return 0;
  }
  const named = stamp.name === undefined ? '' : `: ${stamp.name}`;
  log(`[stamp-lane-config] REFUSED (${stamp.reason}${named}): no file written`);
  return 1;
}

/** `dist/lane-config.json` under a POS app root. */
export const laneConfigFile = (root: string): string => path.join(root, 'dist', LANE_CONFIG_FILE);
