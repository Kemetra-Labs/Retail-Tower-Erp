/**
 * signup-config.unit.spec.ts — RT-1350 slice 3 (design D6): the current terms version
 * is server configuration. Unset means the public signup stays closed (503), never
 * open without a recorded terms version.
 */
import { readCurrentTermsVersion, SIGNUP_LINK_TTL_MS, SIGNUP_RECENT_COMPLETION_MS } from "../../src/signups/signup.config";

describe("readCurrentTermsVersion", () => {
  it("returns the trimmed value of SIGNUP_CURRENT_TERMS_VERSION", () => {
    expect(readCurrentTermsVersion({ SIGNUP_CURRENT_TERMS_VERSION: " 2026-11 " })).toBe("2026-11");
  });

  it("is null when unset, blank or over the 64 character column bound", () => {
    expect(readCurrentTermsVersion({})).toBeNull();
    expect(readCurrentTermsVersion({ SIGNUP_CURRENT_TERMS_VERSION: "   " })).toBeNull();
    expect(readCurrentTermsVersion({ SIGNUP_CURRENT_TERMS_VERSION: "v".repeat(65) })).toBeNull();
  });
});

describe("constants", () => {
  it("a link lives 24 h (design D5) and a completed signup suppresses a new link for 24 h (owner card B)", () => {
    expect(SIGNUP_LINK_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(SIGNUP_RECENT_COMPLETION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
