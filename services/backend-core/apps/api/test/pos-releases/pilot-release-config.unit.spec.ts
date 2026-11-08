/**
 * RT-1292: the pilot release lane's configuration. A pin that could let a lab or
 * production publisher through, or a missing bucket, disables the lane
 * (fail closed): the resolver then answers `available:false`.
 */
import {
  DEFAULT_URL_TTL_SECONDS,
  MAX_URL_TTL_SECONDS,
  resolvePilotReleaseConfig,
} from "../../src/pos-pilot-releases/pilot-release.config";

const PILOT_PIN = "CN=Kemetra POS PILOT, O=Kemetra Labs";
const BASE_ENV = {
  POS_PILOT_RELEASE_PUBLISHER: PILOT_PIN,
  POS_PILOT_RELEASE_BUCKET: "pilot-bucket",
};

describe("RT-1292 pilot release config", () => {
  it("is enabled with a pin and a bucket, and uses the default TTL", () => {
    expect(resolvePilotReleaseConfig(BASE_ENV)).toEqual({
      enabled: true,
      publisher: PILOT_PIN,
      bucket: "pilot-bucket",
      urlTtlSeconds: DEFAULT_URL_TTL_SECONDS,
    });
    expect(DEFAULT_URL_TTL_SECONDS).toBe(300);
    expect(MAX_URL_TTL_SECONDS).toBe(900);
  });

  it.each([
    ["unset", {}],
    ["empty", { POS_PILOT_RELEASE_PUBLISHER: "", POS_PILOT_RELEASE_BUCKET: "b" }],
    ["blank", { POS_PILOT_RELEASE_PUBLISHER: "   ", POS_PILOT_RELEASE_BUCKET: "b" }],
  ])("is disabled when the pin is %s", (_label, env) => {
    expect(resolvePilotReleaseConfig(env)).toEqual({ enabled: false, reason: "pin_unset" });
  });

  it.each([
    "CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION",
    "CN=something lab test here",
    "CN=Kemetra POS not for production",
  ])("is disabled when the pin carries a lab marker: %s", (pin) => {
    expect(resolvePilotReleaseConfig({ ...BASE_ENV, POS_PILOT_RELEASE_PUBLISHER: pin })).toEqual({
      enabled: false,
      reason: "pin_invalid",
    });
  });

  it("is disabled when the pin equals the production pin, whatever the case and spacing", () => {
    for (const production of [PILOT_PIN, ` ${PILOT_PIN.toLowerCase()} `]) {
      expect(resolvePilotReleaseConfig({ ...BASE_ENV, POS_RELEASE_PRODUCTION_PUBLISHER: production })).toEqual({
        enabled: false,
        reason: "pin_invalid",
      });
    }
  });

  it("stays enabled when a different production pin is defined", () => {
    const config = resolvePilotReleaseConfig({ ...BASE_ENV, POS_RELEASE_PRODUCTION_PUBLISHER: "CN=Kemetra Labs, O=Kemetra" });
    expect(config.enabled).toBe(true);
  });

  it.each([
    ["unset", {}],
    ["blank", { POS_PILOT_RELEASE_BUCKET: "  " }],
  ])("is disabled when the bucket is %s", (_label, extra) => {
    expect(resolvePilotReleaseConfig({ POS_PILOT_RELEASE_PUBLISHER: PILOT_PIN, ...extra })).toEqual({
      enabled: false,
      reason: "bucket_unset",
    });
  });

  it("accepts a TTL from 1 to 900 seconds", () => {
    for (const ttl of ["1", "600", "900"]) {
      const config = resolvePilotReleaseConfig({ ...BASE_ENV, POS_PILOT_RELEASE_URL_TTL_SECONDS: ttl });
      expect(config).toMatchObject({ enabled: true, urlTtlSeconds: Number(ttl) });
    }
  });

  it.each(["0", "-5", "901", "3600", "1.5", "abc", "300s"])("is disabled for the TTL %p (never clamped)", (ttl) => {
    expect(resolvePilotReleaseConfig({ ...BASE_ENV, POS_PILOT_RELEASE_URL_TTL_SECONDS: ttl })).toEqual({
      enabled: false,
      reason: "ttl_invalid",
    });
  });
});
