/**
 * RT-1297: the S3 settings of the pilot release lane. The presigner is bound only
 * when the region and BOTH key halves are valid; anything else leaves the lane
 * off (fail closed). The settings come from `POS_PILOT_RELEASE_S3_*` only:
 * ambient `AWS_*` variables are never read, so a shared profile or a wider
 * credential can never sign a pilot download.
 */
import { resolvePilotReleaseS3Settings } from "../../src/pos-pilot-releases/pilot-release.s3-settings";

const FULL_ENV = {
  POS_PILOT_RELEASE_S3_REGION: "us-east-1",
  POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: "AKIAFAKEKEYID000000",
  POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY: "fake-secret-value-not-real",
};

describe("RT-1297 pilot release S3 settings", () => {
  it("is ok with a region and both key halves, trimmed", () => {
    expect(
      resolvePilotReleaseS3Settings({
        POS_PILOT_RELEASE_S3_REGION: " us-east-1 ",
        POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: "  AKIAFAKEKEYID000000 ",
        POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY: " fake-secret-value-not-real  ",
      }),
    ).toEqual({
      ok: true,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAFAKEKEYID000000", secretAccessKey: "fake-secret-value-not-real" },
    });
  });

  it("is not configured when all three are unset or blank", () => {
    for (const env of [{}, { POS_PILOT_RELEASE_S3_REGION: "  ", POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: "" }]) {
      expect(resolvePilotReleaseS3Settings(env)).toEqual({ ok: false, reason: "not_configured" });
    }
  });

  it.each([
    ["the access key id", "POS_PILOT_RELEASE_S3_ACCESS_KEY_ID"],
    ["the secret access key", "POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY"],
  ])("is partial when %s is missing or blank", (_label, name) => {
    for (const value of [undefined, "", "   "]) {
      const env = { ...FULL_ENV, [name]: value };
      expect(resolvePilotReleaseS3Settings(env)).toEqual({ ok: false, reason: "credentials_partial" });
    }
  });

  it("is partial when only the region is set", () => {
    expect(resolvePilotReleaseS3Settings({ POS_PILOT_RELEASE_S3_REGION: "us-east-1" })).toEqual({
      ok: false,
      reason: "credentials_partial",
    });
  });

  it.each(["us-east-1", "eu-central-1", "ap-southeast-2", "us-gov-west-1", "me-south-1", "il-central-1"])(
    "accepts the real region %p",
    (region) => {
      expect(resolvePilotReleaseS3Settings({ ...FULL_ENV, POS_PILOT_RELEASE_S3_REGION: region })).toMatchObject({
        ok: true,
        region,
      });
    },
  );

  it.each(["", "US-EAST-1", "us-east", "useast1", "https://s3.amazonaws.com", "us-east-1; rm", "us_east_1"])(
    "refuses the region %p when both keys are set",
    (region) => {
      expect(resolvePilotReleaseS3Settings({ ...FULL_ENV, POS_PILOT_RELEASE_S3_REGION: region })).toEqual({
        ok: false,
        reason: "region_invalid",
      });
    },
  );

  it("never reads the ambient AWS credential variables", () => {
    const ambient = {
      AWS_ACCESS_KEY_ID: "AKIAAMBIENT00000000",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      AWS_REGION: "eu-west-1",
      AWS_PROFILE: "default",
    };
    expect(resolvePilotReleaseS3Settings(ambient)).toEqual({ ok: false, reason: "not_configured" });
    expect(resolvePilotReleaseS3Settings({ ...ambient, ...FULL_ENV })).toMatchObject({
      ok: true,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAFAKEKEYID000000" },
    });
  });

  it("names a refusal only by a closed reason, never by a value", () => {
    const refusal = resolvePilotReleaseS3Settings({ ...FULL_ENV, POS_PILOT_RELEASE_S3_REGION: "bad region" });
    expect(Object.keys(refusal).sort()).toEqual(["ok", "reason"]);
    expect(JSON.stringify(refusal)).not.toContain("fake-secret");
  });
});
