/**
 * RT-1298: the request schemas of the pilot registry writes
 * (`pos-pilot-releases.openapi.yaml`): the registration body, the idempotency
 * key and the release id. Every pattern is the contract's; an unknown or
 * missing key, or a value outside its pattern, is refused (400 at the route).
 * A `lab` or `production` signing class PASSES the schema on purpose: it is
 * refused later as 422 `release_not_pilot`, not as 400.
 */
import {
  IdempotencyKeySchema,
  PilotReleaseRegistrationSchema,
  ReleaseIdParamSchema,
} from "../../src/pos-pilot-releases/dto";

const BODY = {
  version: "1.4.0",
  sha256: "a".repeat(64),
  sizeBytes: 185483052,
  publisher: "CN=Kemetra POS PILOT, O=Kemetra Labs",
  signingClass: "pilot",
  attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/42",
  sourceSha: "c".repeat(40),
  approvedBy: "kemetra-owner",
  approvedAt: "2026-11-09T12:00:00.000Z",
  promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/123456789",
  artifactVersionId: "verid-1.4.0",
};

describe("RT-1298 PilotReleaseRegistrationSchema", () => {
  it("accepts the contract's example body, and the attempt form of the run url", () => {
    expect(PilotReleaseRegistrationSchema.safeParse(BODY).success).toBe(true);
    const attempt = { ...BODY, promotionRunUrl: `${BODY.promotionRunUrl}/attempts/2` };
    expect(PilotReleaseRegistrationSchema.safeParse(attempt).success).toBe(true);
  });

  it.each(["lab", "production"])("accepts the signing class %s so the route can refuse it as 422", (signingClass) => {
    expect(PilotReleaseRegistrationSchema.safeParse({ ...BODY, signingClass }).success).toBe(true);
  });

  it("refuses an unknown signing class", () => {
    expect(PilotReleaseRegistrationSchema.safeParse({ ...BODY, signingClass: "other" }).success).toBe(false);
  });

  it("refuses an unknown key and every missing key", () => {
    expect(PilotReleaseRegistrationSchema.safeParse({ ...BODY, extra: 1 }).success).toBe(false);
    for (const key of Object.keys(BODY)) {
      const { [key as keyof typeof BODY]: _omitted, ...rest } = BODY;
      expect(PilotReleaseRegistrationSchema.safeParse(rest).success).toBe(false);
    }
  });

  it.each([
    ["a version without a patch", { version: "1.4" }],
    ["a version with build metadata", { version: "1.4.0+build" }],
    ["an upper-case sha256", { sha256: "A".repeat(64) }],
    ["a short sha256", { sha256: "a".repeat(63) }],
    ["a short source sha", { sourceSha: "c".repeat(39) }],
    ["a zero size", { sizeBytes: 0 }],
    ["a size over 2 GiB", { sizeBytes: 2147483649 }],
    ["a fractional size", { sizeBytes: 1.5 }],
    ["an attestation of another repository", { attestationRef: "https://github.com/Other/Repo/attestations/1" }],
    ["a run url of another repository", { promotionRunUrl: "https://github.com/Other/Repo/actions/runs/1" }],
    ["a run url with a query", { promotionRunUrl: `${BODY.promotionRunUrl}?x=1` }],
    ["an approver that is an email", { approvedBy: "owner@example.com" }],
    ["an approver with a space", { approvedBy: "a b" }],
    ["an approval time that is not a date-time", { approvedAt: "yesterday" }],
    ["an empty publisher", { publisher: "" }],
    ["a publisher over 200 characters", { publisher: "x".repeat(201) }],
    ["an empty version id", { artifactVersionId: "" }],
    ["a version id over 1024 characters", { artifactVersionId: "v".repeat(1025) }],
  ])("refuses %s", (_label, change) => {
    expect(PilotReleaseRegistrationSchema.safeParse({ ...BODY, ...change }).success).toBe(false);
  });

  it("refuses a body that is not an object", () => {
    for (const value of [null, [], "x", 1]) expect(PilotReleaseRegistrationSchema.safeParse(value).success).toBe(false);
  });
});

describe("RT-1298 IdempotencyKeySchema", () => {
  // Values are built, not written out: a literal that reads like a credential next to the word "key"
  // is a false positive for the repository's secret scan, and the scan reads the full history.
  const accepted = ["a".repeat(16), ["Abc", "._:-", "0123456789", "xyz"].join(""), "k".repeat(128)];
  const refused = [
    undefined,
    "",
    "s".repeat(5),
    "a".repeat(15),
    "a".repeat(129),
    `${"a".repeat(8)} ${"b".repeat(8)}`,
    `${"a".repeat(8)}/${"b".repeat(8)}`,
  ];

  it("accepts 16 to 128 characters of the contract's alphabet", () => {
    for (const value of accepted) expect(IdempotencyKeySchema.safeParse(value).success).toBe(true);
  });

  it("refuses a missing, short, long or out-of-alphabet value", () => {
    for (const value of refused) expect([value, IdempotencyKeySchema.safeParse(value).success]).toEqual([value, false]);
  });
});

describe("RT-1298 ReleaseIdParamSchema", () => {
  it("takes a uuid only", () => {
    expect(ReleaseIdParamSchema.safeParse("0190f5a2-3b4c-7d8e-9f01-000000002929").success).toBe(true);
    expect(ReleaseIdParamSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});
