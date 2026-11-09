/**
 * RT-1297: the S3 settings of the POS pilot release lane. Pure: it reads an
 * environment object and answers either the region and the explicit key, or the
 * closed reason the presigner stays unbound. An unbound presigner makes the
 * resolver answer `available:false` (fail closed), never an error.
 *
 * | Variable                                  | Meaning |
 * |-------------------------------------------|---------|
 * | `POS_PILOT_RELEASE_S3_REGION`             | AWS region of the private pilot bucket, such as `us-east-1`. |
 * | `POS_PILOT_RELEASE_S3_ACCESS_KEY_ID`      | Access key id of the read-only IAM user (`s3:GetObject` and `s3:GetObjectVersion` on `pos/pilot/*`). |
 * | `POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY`  | SECRET. Its secret access key. Kept in the root-only host env file; never logged. |
 *
 * The standard `AWS_*` credential variables are deliberately NOT used: the key is
 * passed to the SDK explicitly, so a shared profile, an instance role or any wider
 * ambient credential can never sign a pilot download. (The SDK still honours
 * non-credential ambient settings such as `AWS_ENDPOINT_URL_S3`; the api container
 * is given no `AWS_*` variable at all, see `docker-compose.prod.yml`.) The result
 * carries the secret: callers pass it to the SDK client and nothing else, and never log it.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Why the presigner stays unbound; the reason never carries a value. */
export type PilotReleaseS3Refusal = "not_configured" | "credentials_partial" | "region_invalid";

export type PilotReleaseS3Settings =
  | {
      readonly ok: true;
      readonly region: string;
      readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
    }
  | { readonly ok: false; readonly reason: PilotReleaseS3Refusal };

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** Resolve the S3 settings from an environment object; any refusal leaves the presigner unbound. */
export function resolvePilotReleaseS3Settings(env: Env): PilotReleaseS3Settings {
  // Literal keys: test/deploy/compose-api-env.spec.ts finds every setting the api reads by them.
  const region = (env["POS_PILOT_RELEASE_S3_REGION"] ?? "").trim();
  const accessKeyId = (env["POS_PILOT_RELEASE_S3_ACCESS_KEY_ID"] ?? "").trim();
  const secretAccessKey = (env["POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY"] ?? "").trim();

  if ([region, accessKeyId, secretAccessKey].every((value) => value === "")) {
    return { ok: false, reason: "not_configured" };
  }
  if ([accessKeyId, secretAccessKey].includes("")) return { ok: false, reason: "credentials_partial" };
  if (!REGION_PATTERN.test(region)) return { ok: false, reason: "region_invalid" };
  return { ok: true, region, credentials: { accessKeyId, secretAccessKey } };
}
