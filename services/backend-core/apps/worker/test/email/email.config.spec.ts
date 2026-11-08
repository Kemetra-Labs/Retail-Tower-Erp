/**
 * RT-1280 — email transport configuration and its provider wiring.
 *
 * Production must fail closed: no NoOp, no missing sender/region/Console
 * URL, and only an https origin for accept links. Error messages must not
 * echo the configured values.
 */
jest.mock("../../src/observability/metrics/worker.metrics", () => ({
  recordWorkerJobDuration: jest.fn(),
  recordWorkerProcessingFailure: jest.fn(),
  sanitizeErrorClass: jest.fn(() => "UnknownError"),
}));

import { Test, type TestingModule } from "@nestjs/testing";
import { EMAIL_ADAPTER, NoOpEmailAdapter } from "../../src/email/email.adapter";
import { EMAIL_CONSOLE_BASE_URL, EmailProcessor } from "../../src/email/email.processor";
import { emailAdapterFromConfig, emailTransportProviders } from "../../src/email/email.providers";
import {
  EmailConfigError,
  parseConsoleBaseUrl,
  resolveEmailConfig,
} from "../../src/email/email.config";
import { SesEmailAdapter } from "../../src/email/ses-email.adapter";

const SES_ENV = {
  NODE_ENV: "production",
  EMAIL_TRANSPORT: "ses",
  EMAIL_FROM: "no-reply@example.test",
  SES_REGION: "us-east-1",
  CONSOLE_BASE_URL: "https://console.example.test",
  // Placeholders only: presence is what the config checks.
  AWS_ACCESS_KEY_ID: "test-key-id",
  AWS_SECRET_ACCESS_KEY: "test-key-secret",
} as const;

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...SES_ENV, ...overrides } as NodeJS.ProcessEnv;
}

describe("resolveEmailConfig — production", () => {
  it("accepts a complete SES configuration", () => {
    expect(resolveEmailConfig(env({}))).toEqual({
      kind: "ses",
      from: "no-reply@example.test",
      region: "us-east-1",
      consoleBaseUrl: "https://console.example.test",
    });
  });

  it.each([
    ["EMAIL_TRANSPORT unset", { EMAIL_TRANSPORT: undefined }],
    ["EMAIL_TRANSPORT=noop", { EMAIL_TRANSPORT: "noop" }],
    ["unknown transport", { EMAIL_TRANSPORT: "smtp" }],
    ["EMAIL_FROM missing", { EMAIL_FROM: undefined }],
    ["EMAIL_FROM with a display name", { EMAIL_FROM: "Retail Tower <no-reply@example.test>" }],
    ["SES_REGION missing", { SES_REGION: undefined }],
    ["SES_REGION malformed", { SES_REGION: "useast1" }],
    ["CONSOLE_BASE_URL missing", { CONSOLE_BASE_URL: undefined }],
    ["CONSOLE_BASE_URL over http", { CONSOLE_BASE_URL: "http://console.example.test" }],
    ["the SES key id missing", { AWS_ACCESS_KEY_ID: undefined }],
    ["the SES key secret blank", { AWS_SECRET_ACCESS_KEY: " " }],
  ])("refuses to boot when %s", (_label, overrides) => {
    expect(() => resolveEmailConfig(env(overrides))).toThrow(EmailConfigError);
  });

  it("never echoes the configured value in the error", () => {
    const secretish = "https://user:pa55@console.example.test";
    let message = "";
    try {
      resolveEmailConfig(env({ CONSOLE_BASE_URL: secretish }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/CONSOLE_BASE_URL/);
    expect(message).not.toContain("pa55");
    expect(message).not.toContain("console.example.test");
  });
});

describe("resolveEmailConfig — outside production", () => {
  it("defaults to noop with no Console URL", () => {
    expect(resolveEmailConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual({
      kind: "noop",
      consoleBaseUrl: null,
    });
  });

  it("keeps a valid Console URL for noop so local links render", () => {
    expect(
      resolveEmailConfig({
        NODE_ENV: "development",
        CONSOLE_BASE_URL: "https://localhost:5173",
      } as NodeJS.ProcessEnv),
    ).toEqual({ kind: "noop", consoleBaseUrl: "https://localhost:5173" });
  });

  it("still validates SES settings when ses is chosen", () => {
    expect(() => resolveEmailConfig(env({ NODE_ENV: "development", SES_REGION: "" }))).toThrow(
      EmailConfigError,
    );
  });
});

describe("parseConsoleBaseUrl", () => {
  it("normalizes a trailing slash to the bare origin", () => {
    expect(parseConsoleBaseUrl("https://console.example.test/")).toBe("https://console.example.test");
  });

  it.each([
    "console.example.test",
    "https://console.example.test/admin",
    "https://console.example.test/?next=x",
    "https://console.example.test/#frag",
    "https://user@console.example.test",
    "javascript:alert(1)",
  ])("rejects %s", (raw) => {
    expect(() => parseConsoleBaseUrl(raw)).toThrow(EmailConfigError);
  });
});

describe("emailTransportProviders in a Nest module", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  async function compile(): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [...emailTransportProviders, EmailProcessor],
    }).compile();
  }

  it("fails module compilation in production without EMAIL_TRANSPORT", async () => {
    process.env = { ...saved, NODE_ENV: "production" };
    delete process.env["EMAIL_TRANSPORT"];
    await expect(compile()).rejects.toBeInstanceOf(EmailConfigError);
  });

  it("injects the SES adapter and Console URL into EmailProcessor in production", async () => {
    process.env = { ...saved, ...SES_ENV };
    const moduleRef = await compile();
    expect(moduleRef.get(EMAIL_ADAPTER)).toBeInstanceOf(SesEmailAdapter);
    expect(moduleRef.get(EMAIL_CONSOLE_BASE_URL)).toBe("https://console.example.test");
    expect(moduleRef.get(EmailProcessor)).toBeInstanceOf(EmailProcessor);
  });

  it("resolves a null Console URL with NoOp outside production", async () => {
    process.env = { ...saved, NODE_ENV: "test" };
    delete process.env["EMAIL_TRANSPORT"];
    delete process.env["CONSOLE_BASE_URL"];
    const moduleRef = await compile();
    expect(moduleRef.get(EMAIL_ADAPTER)).toBeInstanceOf(NoOpEmailAdapter);
    expect(moduleRef.get(EMAIL_CONSOLE_BASE_URL)).toBeNull();
  });
});

describe("emailAdapterFromConfig", () => {
  it("builds the SES adapter for ses", () => {
    expect(
      emailAdapterFromConfig({
        kind: "ses",
        from: "no-reply@example.test",
        region: "us-east-1",
        consoleBaseUrl: "https://console.example.test",
      }),
    ).toBeInstanceOf(SesEmailAdapter);
  });

  it("builds the NoOp adapter only for noop", () => {
    expect(emailAdapterFromConfig({ kind: "noop", consoleBaseUrl: null })).toBeInstanceOf(
      NoOpEmailAdapter,
    );
  });
});
