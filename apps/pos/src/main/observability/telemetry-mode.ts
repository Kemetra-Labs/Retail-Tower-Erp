import type { UpdateChannel } from '../update/update-types.js';

/**
 * RT-1253 R3 (owner decision 2026-11-05, RT-1251 comment 15670) — which Sentry
 * path this build uses.
 *
 *   production    a shipped build on update channel `canary` or `stable`
 *   lab           a shipped build on channel `lab`
 *   dev           a build that is not shipped (RT-165 `isShippedApp`)
 *   unclassified  a shipped build whose channel is not a known one
 *
 * Production and unclassified builds IGNORE the env `SENTRY_DSN` and report only
 * through the Backend-Core tunnel, so production egress is Backend-Core only.
 * Lab and dev keep honouring an env `SENTRY_DSN` (direct mode, RT-1243). Without
 * an env DSN a lab terminal uses the tunnel (it is paired and provisioned like a
 * production one); a dev build stays inert.
 *
 * The channel is a provisioning env var (`POS_PULSE_UPDATE_CHANNEL`, RT-772), so
 * this classification is only as strong as provisioning is.
 */

export type BuildClass = 'production' | 'lab' | 'dev' | 'unclassified';

export type TelemetryMode =
  | { readonly mode: 'tunnel'; readonly build: BuildClass }
  | { readonly mode: 'direct'; readonly build: BuildClass }
  | { readonly mode: 'inert'; readonly build: BuildClass };

export interface BuildClassInput {
  /** `isShippedApp(...)`. */
  readonly shipped: boolean;
  /** `resolveUpdateConfig(env).channel`; null when the variable holds an unknown value. */
  readonly channel: UpdateChannel | null;
}

export function classifyBuild(input: BuildClassInput): BuildClass {
  if (!input.shipped) return 'dev';
  if (input.channel === 'canary' || input.channel === 'stable') return 'production';
  if (input.channel === 'lab') return 'lab';
  return 'unclassified';
}

export function resolveTelemetryMode(
  input: BuildClassInput & { readonly env: Readonly<Record<string, string | undefined>> },
): TelemetryMode {
  const build = classifyBuild(input);
  if (build === 'production' || build === 'unclassified') return { mode: 'tunnel', build };
  const hasEnvDsn = (input.env['SENTRY_DSN']?.trim() ?? '') !== '';
  if (hasEnvDsn) return { mode: 'direct', build };
  return build === 'lab' ? { mode: 'tunnel', build } : { mode: 'inert', build };
}
