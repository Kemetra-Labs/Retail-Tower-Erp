/**
 * RT-1298: maps the registry's domain errors to the contract's HTTP answers, for
 * the two controllers that serve the registry writes. Anything else is rethrown
 * for the global filter (500 `system_failure`).
 *
 *   PilotReleaseNotFoundError            404 `not_found`
 *   PilotReleaseConflictError            409 `release_conflict`
 *   PilotReleaseNotPilotError            422 `release_not_pilot`
 *   PilotReleaseActivationRefusedError   409 `release_withdrawn` | `release_current_exists`
 */
import { HttpException } from "@nestjs/common";

import {
  PilotReleaseActivationRefusedError,
  PilotReleaseConflictError,
  PilotReleaseNotFoundError,
  PilotReleaseNotPilotError,
} from "./pilot-release-registry.rows";

interface HttpAnswer {
  readonly type: new (...args: never[]) => Error;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** The fixed answers; an activation refusal carries its own code and is handled below. */
const ANSWERS: readonly HttpAnswer[] = [
  { type: PilotReleaseNotFoundError, status: 404, code: "not_found", message: "Not found." },
  { type: PilotReleaseConflictError, status: 409, code: "release_conflict", message: "A release with these values already exists." },
  { type: PilotReleaseNotPilotError, status: 422, code: "release_not_pilot", message: "Only a pilot release can be registered." },
];

/** Throw the HTTP answer for a registry error, or rethrow an unknown one. */
export function throwRegistryHttpError(err: unknown): never {
  if (err instanceof PilotReleaseActivationRefusedError) {
    throw new HttpException({ code: err.code, message: "The release cannot be activated." }, 409);
  }
  const answer = ANSWERS.find((candidate) => err instanceof candidate.type);
  if (answer !== undefined) throw new HttpException({ code: answer.code, message: answer.message }, answer.status);
  throw err;
}
