/**
 * signup-dto.unit.spec.ts — RT-1350 slice 3: the request bodies of the two public
 * signup routes and the ONE generic 400 they share (contract `signups.openapi.yaml`:
 * `code: validation_error`, one fixed message, no field details, so a malformed
 * body, a non-current terms version and a failed human proof cannot be told apart).
 */
import "reflect-metadata";

import { BadRequestException } from "@nestjs/common";

import {
  SIGNUP_INVALID_MESSAGE,
  SignupCompleteSchema,
  SignupRequestSchema,
  SignupValidationPipe,
  signupInvalid,
} from "../../src/signups/signup.dto";

const valid = {
  email: "  Owner@Example.COM ",
  name: "Mona Hassan",
  businessName: "Hassan Market",
  locale: "ar",
  termsVersion: "2026-11",
  termsAccepted: true,
  humanProof: "turnstile-token",
};

describe("SignupRequestSchema", () => {
  it("accepts a valid body and normalizes the email (trimmed, lower-cased)", () => {
    const parsed = SignupRequestSchema.parse(valid);
    expect(parsed.email).toBe("owner@example.com");
    expect(parsed.locale).toBe("ar");
  });

  it("does not require a locale", () => {
    const { locale: _locale, ...rest } = valid;
    expect(SignupRequestSchema.safeParse(rest).success).toBe(true);
  });

  it.each([
    ["an unknown property", { ...valid, extra: 1 }],
    ["termsAccepted false", { ...valid, termsAccepted: false }],
    ["a locale outside ar|en", { ...valid, locale: "fr" }],
    ["an empty name", { ...valid, name: "" }],
    ["a 121 character business name", { ...valid, businessName: "x".repeat(121) }],
    ["a 65 character terms version", { ...valid, termsVersion: "v".repeat(65) }],
    ["a 4097 character human proof", { ...valid, humanProof: "p".repeat(4097) }],
    ["a missing human proof", { ...valid, humanProof: undefined }],
    ["an email over 254 characters", { ...valid, email: `${"a".repeat(250)}@example.com` }],
    ["a non-email", { ...valid, email: "not-an-email" }],
  ])("rejects %s", (_label, body) => {
    expect(SignupRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("SignupCompleteSchema", () => {
  it("accepts a token and a password", () => {
    expect(SignupCompleteSchema.safeParse({ token: "t", password: "p" }).success).toBe(true);
  });

  it.each([
    ["a missing password", { token: "t" }],
    ["an empty token", { token: "", password: "p" }],
    ["a 2049 character token", { token: "t".repeat(2049), password: "p" }],
    ["a password over 1024 code points", { token: "t", password: "p".repeat(1025) }],
    ["an unknown property", { token: "t", password: "p", extra: true }],
  ])("rejects %s", (_label, body) => {
    expect(SignupCompleteSchema.safeParse(body).success).toBe(false);
  });

  it("counts the password in Unicode code points, as OpenAPI maxLength does", () => {
    // 1024 astral characters are 2048 UTF-16 units but 1024 code points: allowed.
    expect(SignupCompleteSchema.safeParse({ token: "t", password: "\u{1F600}".repeat(1024) }).success).toBe(true);
    expect(SignupCompleteSchema.safeParse({ token: "t", password: "\u{1F600}".repeat(1025) }).success).toBe(false);
  });
});

describe("generic 400", () => {
  it("signupInvalid() is a 400 with code validation_error, one fixed message and no details", () => {
    const err = signupInvalid();
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({ code: "validation_error", message: SIGNUP_INVALID_MESSAGE });
  });

  it("the pipe turns every schema failure into that one body, whatever the field", () => {
    const pipe = new SignupValidationPipe(SignupRequestSchema);
    const bodies: unknown[] = [{}, null, "text", [], { ...valid, termsAccepted: false }, { ...valid, name: "" }];
    const responses = bodies.map((b) => {
      try {
        pipe.transform(b, { type: "body" });
        return "no-throw";
      } catch (e) {
        return (e as BadRequestException).getResponse();
      }
    });
    for (const r of responses) expect(r).toEqual({ code: "validation_error", message: SIGNUP_INVALID_MESSAGE });
  });

  it("the pipe returns the parsed value on success", () => {
    const pipe = new SignupValidationPipe(SignupCompleteSchema);
    expect(pipe.transform({ token: "t", password: "p" }, { type: "body" })).toEqual({ token: "t", password: "p" });
  });
});
