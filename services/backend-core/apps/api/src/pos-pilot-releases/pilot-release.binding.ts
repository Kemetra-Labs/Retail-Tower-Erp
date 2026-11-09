/**
 * RT-1297: binds the pilot release presigner from the environment and says, in
 * one closed-string line, when the pilot lane is half configured. Pure apart
 * from the `warn` callback, so it is testable without Nest.
 *
 * A fully unset lane (the normal state before the owner switches it on) is
 * silent. Every warning names a closed reason, never a value.
 */
import { resolvePilotReleaseConfig } from "./pilot-release.config";
import type { PilotReleasePresigner } from "./pilot-release.presigner";
import { createPilotReleasePresigner } from "./pilot-release.s3-presigner";

type Env = Readonly<Record<string, string | undefined>>;

/** The presigner for the environment, or null (the lane answers `available:false`); warns on a half-configured lane. */
export function bindPilotReleasePresigner(env: Env, warn: (message: string) => void): PilotReleasePresigner | null {
  const { presigner, reason } = createPilotReleasePresigner(env);
  const config = resolvePilotReleaseConfig(env);
  if (presigner === null && reason !== "not_configured") {
    warn(`pilot release presigner not bound: ${reason}`);
  } else if (presigner === null && config.enabled) {
    warn(`pilot release lane is configured but the presigner is not bound: ${reason}`);
  } else if (presigner !== null && !config.enabled) {
    warn(`pilot release presigner is bound but the lane is off: ${config.reason}`);
  }
  return presigner;
}
