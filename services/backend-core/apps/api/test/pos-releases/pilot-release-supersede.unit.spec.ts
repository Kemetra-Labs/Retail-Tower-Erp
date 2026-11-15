/**
 * RT-1418: the pure rules of `platformSupersedeCurrentPilotRelease`, no database:
 *
 *   - `isNewerVersion`: only a plain X.Y.Z strictly greater than the current one
 *     is newer; equal, lower, a pre-release or any other shape is not (fail
 *     closed, because terminals refuse a downgrade);
 *   - `isRunOf`: the run itself or one of its attempts, never a longer run id
 *     that merely starts with it;
 *   - the HTTP answers: `release_withdrawn` / `release_not_newer` are 409 and a
 *     keeper of another run is 403 `forbidden`.
 *
 * The transaction itself (locks, never the keeper, audit) is proven against
 * real Postgres in `pos-pilot-release.writes.spec.ts`.
 */
import { HttpException } from "@nestjs/common";

import { throwRegistryHttpError } from "../../src/pos-pilot-releases/pilot-release-registry.http";
import {
  PilotReleaseNotOwnedError,
  PilotReleaseSupersedeRefusedError,
  isNewerVersion,
  isRunOf,
} from "../../src/pos-pilot-releases/pilot-release-registry.rows";

/** The status and body of the HTTP answer a registry error maps to. */
function answerOf(err: Error): { status: number; body: unknown } {
  try {
    throwRegistryHttpError(err);
  } catch (thrown) {
    if (thrown instanceof HttpException) return { status: thrown.getStatus(), body: thrown.getResponse() };
    throw thrown;
  }
  throw new Error("throwRegistryHttpError returned");
}

describe("RT-1418 isNewerVersion", () => {
  it.each([
    ["0.1.5", "0.1.4"],
    ["0.2.0", "0.1.99"],
    ["1.0.0", "0.9.9"],
    ["0.1.10", "0.1.9"],
    ["10.0.0", "9.99.99"],
    ["99999999999999999999.0.0", "99999999999999999998.9.9"],
  ])("treats %s as newer than %s", (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(true);
  });

  it.each([
    ["0.1.4", "0.1.4", "equal"],
    ["0.1.3", "0.1.4", "lower patch"],
    ["0.1.9", "0.2.0", "lower minor"],
    ["0.9.9", "1.0.0", "lower major"],
    ["0.1.5-rc.1", "0.1.4", "a pre-release candidate"],
    ["0.1.5", "0.1.4-rc.1", "a pre-release current"],
    ["0.1", "0.0.9", "not X.Y.Z"],
    ["01.2.3", "1.2.2", "a leading zero"],
    ["", "0.1.4", "empty"],
  ])("does not treat %s as newer than %s (%s)", (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(false);
  });
});

describe("RT-1418 isRunOf", () => {
  const RUN = "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/987654321";

  it("accepts the run and its attempts", () => {
    expect(isRunOf(RUN, RUN)).toBe(true);
    expect(isRunOf(`${RUN}/attempts/2`, RUN)).toBe(true);
  });

  it("refuses another run, and a longer run id that starts with it", () => {
    expect(isRunOf("https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/111", RUN)).toBe(false);
    expect(isRunOf(`${RUN}0`, RUN)).toBe(false);
    expect(isRunOf(`${RUN}0/attempts/1`, RUN)).toBe(false);
  });
});

describe("RT-1418 supersede HTTP answers", () => {
  it.each(["release_withdrawn", "release_not_newer"] as const)("answers %s with 409 and that code", (code) => {
    expect(answerOf(new PilotReleaseSupersedeRefusedError(code))).toMatchObject({ status: 409, body: { code } });
  });

  it("answers a keeper of another run with 403 `forbidden`, naming no cause", () => {
    expect(answerOf(new PilotReleaseNotOwnedError())).toEqual({ status: 403, body: { code: "forbidden", message: "Forbidden" } });
  });
});
