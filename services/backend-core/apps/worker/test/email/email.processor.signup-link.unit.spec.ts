/**
 * RT-1350 slice 3: the `auth.signup-link` email job (self-signup, fallback A). The wording
 * is a DRAFT pending the owner's approval (open item for launch gate G); these tests pin
 * the behaviour that does not depend on the wording: the link, the languages, the token
 * handling, the escaping and the job-name contract with the API producer.
 */
jest.mock("../../src/observability/metrics/worker.metrics", () => ({
  recordWorkerJobDuration: jest.fn(),
  recordWorkerProcessingFailure: jest.fn(),
  sanitizeErrorClass: jest.fn((name: string | null | undefined) => name ?? "UnknownError"),
}));

import { RecordingEmailAdapter } from "../../src/email/email.adapter";
import { EMAIL_JOB_NAMES, EmailProcessor, MalformedEmailJobError } from "../../src/email/email.processor";

const BASE = "https://console.example.test";
const TOKEN = "raw-signup-token_0123456789-abcdefghijklmnop";
const EMAIL = "owner@example.com";

let adapter: RecordingEmailAdapter;
let processor: EmailProcessor;

beforeEach(() => {
  adapter = new RecordingEmailAdapter();
  processor = new EmailProcessor(adapter, BASE);
});

describe("auth.signup-link", () => {
  it("has the literal job name the API producer writes", () => {
    expect(EMAIL_JOB_NAMES.signupLink).toBe("auth.signup-link");
  });

  it("sends exactly one message, to the address, with the Console completion link", async () => {
    await processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: "ar" });

    expect(adapter.sent).toHaveLength(1);
    const message = adapter.sent[0]!;
    const link = `${BASE}/signup/complete?token=${TOKEN}`;
    expect(message.to).toBe(EMAIL);
    expect(message.textBody).toContain(link);
    expect(message.htmlBody).toContain(`<a href="${link}">`);
    expect(message.tags).toEqual({ template_id: "auth.signup-link" });
    expect(message.subject.length).toBeGreaterThan(0);
  });

  it("is bilingual, the form's language first (ar -> Arabic block first, en -> English block first)", async () => {
    await processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: "ar" });
    await processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: "en" });
    await processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: null });

    const [ar, en, none] = adapter.sent;
    const arabicFirst = (m: { textBody: string }): boolean => m.textBody.search(/[؀-ۿ]/) < m.textBody.search(/[A-Za-z]{4}/);
    expect(arabicFirst(ar!)).toBe(true);
    expect(arabicFirst(en!)).toBe(false);
    expect(arabicFirst(none!)).toBe(true);
    for (const m of [ar!, en!, none!]) {
      expect(m.textBody).toMatch(/[؀-ۿ]/);
      expect(m.textBody).toContain("24");
      expect(m.htmlBody).toContain('dir="rtl"');
      expect(m.htmlBody).toContain('dir="ltr"');
    }
  });

  it("URL-encodes the token in the link and HTML-escapes it where it is shown", async () => {
    await processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: 'a&b"<c>', locale: "en" });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(`${BASE}/signup/complete?token=a%26b%22%3Cc%3E`);
    expect(message.htmlBody).not.toContain('"<c>');
    expect(message.htmlBody).not.toContain("<c>");
  });

  it("falls back to the bare token only when the worker has no Console URL (never in production)", async () => {
    const bare = new EmailProcessor(adapter);
    await bare.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: "en" });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(TOKEN);
    expect(message.textBody).not.toContain("/signup/complete");
  });

  it("puts nothing about the owner, the business or the account in the message beyond the recipient", async () => {
    await processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: "en" });
    const message = adapter.sent[0]!;
    for (const text of [message.subject, message.textBody, message.htmlBody ?? ""]) {
      expect(text).not.toContain(EMAIL);
    }
  });

  it.each([
    ["a missing token", { email: EMAIL, locale: "ar" }],
    ["an invalid address", { email: "nope", rawToken: TOKEN, locale: "ar" }],
    ["an unknown locale", { email: EMAIL, rawToken: TOKEN, locale: "fr" }],
    ["a non-object payload", "text"],
  ])("rejects %s BEFORE anything is sent", async (_label, data) => {
    await expect(processor.process(EMAIL_JOB_NAMES.signupLink, data)).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("propagates a transport failure so the queue retries", async () => {
    adapter.reject = new Error("smtp down");
    await expect(
      processor.process(EMAIL_JOB_NAMES.signupLink, { email: EMAIL, rawToken: TOKEN, locale: "ar" }),
    ).rejects.toThrow("smtp down");
  });
});
