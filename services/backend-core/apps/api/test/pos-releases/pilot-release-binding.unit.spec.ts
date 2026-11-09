/**
 * RT-1297: binding the pilot presigner from the environment, and the boot
 * warnings of a half-configured lane. A fully blank lane is silent; every
 * warning names a closed reason and never a value.
 */
import { bindPilotReleasePresigner } from "../../src/pos-pilot-releases/pilot-release.binding";

const KEY_ID = "AKIAFAKEKEYID000000";
const SECRET = "fake-secret-value-not-real";
const LANE = {
  POS_PILOT_RELEASE_PUBLISHER: "CN=Kemetra POS PILOT, O=Kemetra Labs",
  POS_PILOT_RELEASE_BUCKET: "pilot-bucket",
};
const S3 = {
  POS_PILOT_RELEASE_S3_REGION: "us-east-1",
  POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: KEY_ID,
  POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY: SECRET,
};

/** Bind from an environment and collect the warnings. */
function bind(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const presigner = bindPilotReleasePresigner(env, (message) => warnings.push(message));
  return { presigner, warnings };
}

describe("RT-1297 pilot release presigner binding", () => {
  it("is silent and unbound when nothing is configured", () => {
    expect(bind({})).toEqual({ presigner: null, warnings: [] });
  });

  it("binds a presigner, silently, when the lane and the S3 key are both complete", () => {
    const { presigner, warnings } = bind({ ...LANE, ...S3 });
    expect(presigner).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it("warns, by reason, when the S3 key is partial", () => {
    const { presigner, warnings } = bind({
      ...LANE,
      ...S3,
      POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY: "",
    });
    expect(presigner).toBeNull();
    expect(warnings).toEqual(["pilot release presigner not bound: credentials_partial"]);
  });

  it("warns, by reason, when the region is not a region", () => {
    const { presigner, warnings } = bind({ ...LANE, ...S3, POS_PILOT_RELEASE_S3_REGION: "nowhere" });
    expect(presigner).toBeNull();
    expect(warnings).toEqual(["pilot release presigner not bound: region_invalid"]);
  });

  it("warns when the pin and the bucket are set but the S3 key is blank", () => {
    const { presigner, warnings } = bind(LANE);
    expect(presigner).toBeNull();
    expect(warnings).toEqual(["pilot release lane is configured but the presigner is not bound: not_configured"]);
  });

  it.each([
    ["the pin", { ...S3, POS_PILOT_RELEASE_BUCKET: "pilot-bucket" }, "pin_unset"],
    ["the bucket", { ...S3, POS_PILOT_RELEASE_PUBLISHER: LANE.POS_PILOT_RELEASE_PUBLISHER }, "bucket_unset"],
  ])("warns when the S3 key is set but %s is blank", (_label, env, reason) => {
    const { presigner, warnings } = bind(env);
    expect(presigner).not.toBeNull();
    expect(warnings).toEqual([`pilot release presigner is bound but the lane is off: ${reason}`]);
  });

  it("never puts a key id, a secret or a bucket name in a warning", () => {
    const cases = [
      bind({ ...LANE, ...S3, POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: "" }),
      bind({ ...LANE, ...S3, POS_PILOT_RELEASE_S3_REGION: "bad region" }),
      bind(LANE),
      bind({ ...S3 }),
    ];
    const text = cases.flatMap((c) => c.warnings).join("\n");
    expect(text).not.toBe("");
    for (const value of [SECRET, KEY_ID, "pilot-bucket", LANE.POS_PILOT_RELEASE_PUBLISHER]) {
      expect(text).not.toContain(value);
    }
  });
});
