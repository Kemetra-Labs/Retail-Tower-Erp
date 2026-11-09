/**
 * RT-1297: the S3 presigner of the pilot release lane.
 *
 * Presigning is a local signature computation: these specs use the real AWS SDK
 * client with fake static credentials and never touch the network. They pin the
 * shape of the URL (version, attachment, bounded expiry), the refusal of a bad
 * lifetime BEFORE any signing, the explicit-credentials rule (no ambient AWS
 * variable can sign), and that a failure or a log line never carries a secret.
 */
import { S3Client } from "@aws-sdk/client-s3";

import {
  PilotReleasePresignError,
  S3PilotReleasePresigner,
  createPilotReleasePresigner,
} from "../../src/pos-pilot-releases/pilot-release.s3-presigner";

const KEY_ID = "AKIAFAKEKEYID000000";
const SECRET = "fake-secret-value-not-real";
const S3_ENV = {
  POS_PILOT_RELEASE_S3_REGION: "us-east-1",
  POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: KEY_ID,
  POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY: SECRET,
};

const REQUEST = {
  bucket: "pilot-bucket",
  key: "pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe",
  versionId: "verid-1.4.0",
  fileName: "POS-Pulse-Setup-1.4.0.exe",
  ttlSeconds: 300,
};

const NOW = new Date("2026-11-09T12:00:00.000Z");

/** A real client with fake static credentials, and a spy on how often it is asked to sign. */
function fakeClient(): { client: S3Client; credentialReads: jest.Mock } {
  const credentialReads = jest.fn(async () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }));
  return { client: new S3Client({ region: "us-east-1", credentials: credentialReads }), credentialReads };
}

describe("RT-1297 S3PilotReleasePresigner", () => {
  it("presigns a GET that names the bucket, key and verified object version, as an attachment", async () => {
    const { client } = fakeClient();
    const { url } = await new S3PilotReleasePresigner(client, () => NOW).presignGet(REQUEST);

    const parsed = new URL(url);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("pilot-bucket.s3.us-east-1.amazonaws.com");
    expect(parsed.pathname).toBe("/pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe");
    expect(parsed.searchParams.get("versionId")).toBe("verid-1.4.0");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(parsed.searchParams.get("response-content-disposition")).toMatch(/^attachment; filename="/);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("never puts the secret key in the URL", async () => {
    const { client } = fakeClient();
    const { url } = await new S3PilotReleasePresigner(client, () => NOW).presignGet(REQUEST);
    expect(url).not.toContain(SECRET);
  });

  it("reports an expiry that is the issue time plus the lifetime", async () => {
    const { client } = fakeClient();
    const { expiresAt } = await new S3PilotReleasePresigner(client, () => NOW).presignGet(REQUEST);
    expect(expiresAt.toISOString()).toBe("2026-11-09T12:05:00.000Z");
  });

  it("reports exactly the expiry that is signed, even when the issue time has milliseconds", async () => {
    const { client } = fakeClient();
    const late = new Date("2026-11-09T12:00:00.900Z");
    const { url, expiresAt } = await new S3PilotReleasePresigner(client, () => late).presignGet(REQUEST);

    const signedAt = new URL(url).searchParams.get("X-Amz-Date");
    expect(signedAt).toBe("20261109T120000Z");
    expect(expiresAt.toISOString()).toBe("2026-11-09T12:05:00.000Z");
  });

  it.each([1, 300, 900])("accepts the lifetime %p", async (ttlSeconds) => {
    const { client, credentialReads } = fakeClient();
    const { url } = await new S3PilotReleasePresigner(client, () => NOW).presignGet({ ...REQUEST, ttlSeconds });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe(String(ttlSeconds));
    expect(credentialReads).toHaveBeenCalled();
  });

  it.each([0, -1, 901, 3600, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses the lifetime %p before any signing",
    async (ttlSeconds) => {
      const { client, credentialReads } = fakeClient();
      await expect(
        new S3PilotReleasePresigner(client, () => NOW).presignGet({ ...REQUEST, ttlSeconds }),
      ).rejects.toBeInstanceOf(PilotReleasePresignError);
      expect(credentialReads).not.toHaveBeenCalled();
    },
  );

  it("cannot be steered into another header by the file name", async () => {
    const { client } = fakeClient();
    const hostile = 'x"; filename=evil.exe\r\nSet-Cookie: a=b';
    const { url } = await new S3PilotReleasePresigner(client, () => NOW).presignGet({ ...REQUEST, fileName: hostile });
    const disposition = new URL(url).searchParams.get("response-content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9._%-]+$/);
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it("fails with the error name only, never the SDK message, a cause or a secret", async () => {
    const credentialReads = jest.fn(async () => {
      throw Object.assign(new Error(`leaked ${SECRET} and ${KEY_ID}`), { name: "CredentialsProviderError" });
    });
    const client = new S3Client({ region: "us-east-1", credentials: credentialReads });

    const failure: unknown = await new S3PilotReleasePresigner(client, () => NOW)
      .presignGet(REQUEST)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PilotReleasePresignError);
    const error = failure as PilotReleasePresignError;
    expect(error.message).toContain("CredentialsProviderError");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(KEY_ID);
    expect(error.cause).toBeUndefined();
  });
});

describe("RT-1297 createPilotReleasePresigner", () => {
  const savedEnv = process.env;

  afterEach(() => {
    process.env = savedEnv;
  });

  it("binds a presigner only when the region and both key halves are set", () => {
    const bound = createPilotReleasePresigner(S3_ENV);
    expect(bound.presigner).not.toBeNull();
    expect(bound.reason).toBeNull();
  });

  it.each([
    ["nothing is set", {}, "not_configured"],
    ["the secret is blank", { ...S3_ENV, POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY: " " }, "credentials_partial"],
    ["the key id is unset", { ...S3_ENV, POS_PILOT_RELEASE_S3_ACCESS_KEY_ID: undefined }, "credentials_partial"],
    ["the region is not a region", { ...S3_ENV, POS_PILOT_RELEASE_S3_REGION: "nowhere" }, "region_invalid"],
  ])("leaves the lane off when %s", (_label, env, reason) => {
    expect(createPilotReleasePresigner(env)).toEqual({ presigner: null, reason });
  });

  it("signs with the explicit pilot key, never with an ambient AWS variable", async () => {
    process.env = {
      ...savedEnv,
      AWS_ACCESS_KEY_ID: "AKIAAMBIENT00000000",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      AWS_REGION: "eu-west-1",
    };
    const { presigner } = createPilotReleasePresigner(S3_ENV);
    const { url } = await (presigner as NonNullable<typeof presigner>).presignGet(REQUEST);

    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(`${KEY_ID}/`);
    expect(parsed.searchParams.get("X-Amz-Credential")).not.toContain("AMBIENT");
    expect(parsed.hostname).toBe("pilot-bucket.s3.us-east-1.amazonaws.com");
  });

  it("does not fall back to an ambient credential when the pilot key is not set", () => {
    process.env = { ...savedEnv, AWS_ACCESS_KEY_ID: "AKIAAMBIENT00000000", AWS_SECRET_ACCESS_KEY: "ambient-secret" };
    expect(createPilotReleasePresigner({ POS_PILOT_RELEASE_S3_REGION: "us-east-1" }).presigner).toBeNull();
    expect(createPilotReleasePresigner({}).presigner).toBeNull();
  });

  it("writes nothing that holds the key or the secret, on binding or on a failed presign", async () => {
    const written: string[] = [];
    const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const log = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => void written.push(args.join(" ")));
    const warn = jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void written.push(args.join(" ")));
    const error = jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => void written.push(args.join(" ")));

    const bound = createPilotReleasePresigner(S3_ENV);
    // A real failure from inside the SDK: the credential provider throws, quoting the secret.
    const failing = new S3PilotReleasePresigner(
      new S3Client({
        region: "us-east-1",
        credentials: async () => {
          throw Object.assign(new Error(`leaked ${SECRET} and ${KEY_ID}`), { name: "CredentialsProviderError" });
        },
      }),
    );
    await failing.presignGet(REQUEST).catch(() => undefined);
    await (bound.presigner as NonNullable<typeof bound.presigner>).presignGet(REQUEST);

    for (const spy of [out, err, log, warn, error]) spy.mockRestore();
    expect(written.join("\n")).not.toContain(SECRET);
    expect(written.join("\n")).not.toContain(KEY_ID);
    expect(JSON.stringify(bound.reason)).not.toContain(SECRET);
  });
});
