/**
 * RT-1043 — the server secret the public-auth rate-limit keys are HMAC'd under.
 *
 * Posture (criterion 4): a deployed environment refuses to boot without a
 * usable secret; a test run falls back to a fixed test default; any other run
 * (local development) gets a random per-process secret, so no known constant
 * ever keys a real Redis. None of the messages may contain the secret value.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PUBLIC_AUTH_KEY_SECRET_ENV,
  PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH,
  assertPublicAuthKeySecretConfigured,
  resolvePublicAuthKeySecret,
} from "../../src/auth/public-auth-key-secret";

const GOOD = "a".repeat(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH);

type Env = Record<string, string | undefined>;

describe("RT-1043 public-auth key secret", () => {
  describe("deployed environments refuse to boot without a usable secret", () => {
    const deployed: ReadonlyArray<[string, Env]> = [
      ["NODE_ENV=production", { NODE_ENV: "production" }],
      ["DEPLOYMENT_ENVIRONMENT=staging", { NODE_ENV: "development", DEPLOYMENT_ENVIRONMENT: "staging" }],
      ["DEPLOYMENT_ENVIRONMENT=pilot", { DEPLOYMENT_ENVIRONMENT: "pilot" }],
      ["DEPLOYMENT_ENVIRONMENT=prod", { DEPLOYMENT_ENVIRONMENT: "prod" }],
      // A test runner cannot hide a deployed environment.
      ["NODE_ENV=test with DEPLOYMENT_ENVIRONMENT=prod", { NODE_ENV: "test", DEPLOYMENT_ENVIRONMENT: "prod" }],
    ];

    it.each(deployed)("%s: unset -> throws and names the variable", (_name, env) => {
      expect(() => assertPublicAuthKeySecretConfigured(env)).toThrow(PUBLIC_AUTH_KEY_SECRET_ENV);
      expect(() => resolvePublicAuthKeySecret(env)).toThrow(PUBLIC_AUTH_KEY_SECRET_ENV);
    });

    it.each(deployed)("%s: blank -> throws", (_name, env) => {
      expect(() => assertPublicAuthKeySecretConfigured({ ...env, [PUBLIC_AUTH_KEY_SECRET_ENV]: "   " })).toThrow(
        PUBLIC_AUTH_KEY_SECRET_ENV,
      );
    });

    it("too short -> throws, and the message does not contain the value", () => {
      const short = "s3cr3t-too-short";
      expect(short.length).toBeLessThan(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH);
      let message = "";
      try {
        assertPublicAuthKeySecretConfigured({ NODE_ENV: "production", [PUBLIC_AUTH_KEY_SECRET_ENV]: short });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(String(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH));
      expect(message).not.toContain(short);
    });

    it("padding does not count towards the minimum length, and is not part of the secret", () => {
      const padded = `${"a".repeat(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH - 1)}  
`;
      expect(() =>
        assertPublicAuthKeySecretConfigured({ NODE_ENV: "production", [PUBLIC_AUTH_KEY_SECRET_ENV]: padded }),
      ).toThrow(String(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH));
      expect(resolvePublicAuthKeySecret({ NODE_ENV: "production", [PUBLIC_AUTH_KEY_SECRET_ENV]: ` ${GOOD}
` })).toBe(GOOD);
    });

    it("a long enough value boots and is the secret", () => {
      const env = { NODE_ENV: "production", [PUBLIC_AUTH_KEY_SECRET_ENV]: GOOD };
      expect(() => assertPublicAuthKeySecretConfigured(env)).not.toThrow();
      expect(resolvePublicAuthKeySecret(env)).toBe(GOOD);
    });
  });

  describe("tests", () => {
    it("NODE_ENV=test without a value uses one fixed default, never a deployed one", () => {
      const a = resolvePublicAuthKeySecret({ NODE_ENV: "test" });
      const b = resolvePublicAuthKeySecret({ NODE_ENV: "test" });
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH);
      expect(() => assertPublicAuthKeySecretConfigured({ NODE_ENV: "test" })).not.toThrow();
    });

    it("NODE_ENV=test with a value uses that value", () => {
      expect(resolvePublicAuthKeySecret({ NODE_ENV: "test", [PUBLIC_AUTH_KEY_SECRET_ENV]: "x" })).toBe("x");
    });
  });

  it("main.ts runs the boot check before Nest starts, so a missing secret stops the process at boot", () => {
    const main = readFileSync(resolve(__dirname, "..", "..", "src", "main.ts"), "utf8");
    const check = main.indexOf("assertPublicAuthKeySecretConfigured();");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(main.indexOf("NestFactory.create("));
  });

  describe("local development (neither deployed nor test)", () => {
    const dev: Env = { NODE_ENV: "development" };

    it("without a value: a random secret, stable for the process and different from the test default", () => {
      const a = resolvePublicAuthKeySecret(dev);
      expect(a).toBe(resolvePublicAuthKeySecret({}));
      expect(a).not.toBe(resolvePublicAuthKeySecret({ NODE_ENV: "test" }));
      expect(a.length).toBeGreaterThanOrEqual(PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH);
      expect(() => assertPublicAuthKeySecretConfigured(dev)).not.toThrow();
    });

    it("with a value: that value", () => {
      expect(resolvePublicAuthKeySecret({ ...dev, [PUBLIC_AUTH_KEY_SECRET_ENV]: GOOD })).toBe(GOOD);
    });
  });
});
