/**
 * RT-797 — the identity-link cutover CLI's argument parsing (no database).
 */
import { parseIdentityLinkCutoverArgs } from "../../src/cli/identity-link-cutover";

const U = "0A000000-0000-7000-8000-000000000797";
const PAIR = ["--from", "clerk", "--to", "descope"];
const ISSUER = "https://api.descope.com/v1/apps/P2cutoverArgs01";
const APPLY = ["apply", "--user", U, ...PAIR, "--subject", "U2abc", "--issuer", ISSUER];

describe("parseIdentityLinkCutoverArgs", () => {
  it("parses apply, lower-casing the user id", () => {
    expect(parseIdentityLinkCutoverArgs(APPLY)).toEqual({
      kind: "apply",
      userId: U.toLowerCase(),
      from: "clerk",
      to: "descope",
      subject: "U2abc",
      issuer: ISSUER,
      dryRun: false,
    });
  });

  it("parses rollback (no subject or issuer) and --dry-run", () => {
    expect(parseIdentityLinkCutoverArgs(["rollback", "--dry-run", "--user", U, ...PAIR])).toEqual({
      kind: "rollback",
      userId: U.toLowerCase(),
      from: "clerk",
      to: "descope",
      dryRun: true,
    });
  });

  it("reads no environment: provider issuer variables play no part", () => {
    const saved = { ...process.env };
    try {
      process.env["DESCOPE_PROJECT_ID"] = "P2ignored";
      process.env["CLERK_JWT_ISSUER"] = "https://ignored.example";
      expect(parseIdentityLinkCutoverArgs(APPLY)).toMatchObject({ issuer: ISSUER });
    } finally {
      process.env = saved;
    }
  });

  it.each<[string, string[], RegExp]>([
    ["an unknown command", ["flip", "--user", U, ...PAIR], /usage/],
    ["no command", [], /usage/],
    ["a missing user", ["rollback", ...PAIR], /--user/],
    ["a malformed user", ["rollback", "--user", "me", ...PAIR], /--user/],
    ["a missing --from", ["rollback", "--user", U, "--to", "descope"], /--from/],
    ["a missing --to", ["rollback", "--user", U, "--from", "clerk"], /--to/],
    ["the same provider twice", ["rollback", "--user", U, "--from", "clerk", "--to", "clerk"], /different providers/],
    ["an upper-case provider key", ["rollback", "--user", U, "--from", "Clerk", "--to", "descope"], /--from/],
    ["a provider key with a space", ["rollback", "--user", U, "--from", "clerk", "--to", "de scope"], /--to/],
    ["a missing subject", ["apply", "--user", U, ...PAIR, "--issuer", ISSUER], /--subject/],
    ["a flag as subject", ["apply", "--user", U, ...PAIR, "--subject", "--dry-run", "--issuer", ISSUER], /--subject/],
    ["a missing issuer", ["apply", "--user", U, ...PAIR, "--subject", "U2abc"], /--issuer/],
    ["an http issuer", ["apply", "--user", U, ...PAIR, "--subject", "U2abc", "--issuer", "http://x.example"], /--issuer/],
    ["a bare project id as issuer", ["apply", "--user", U, ...PAIR, "--subject", "U2abc", "--issuer", "P2abc"], /--issuer/],
    ["a mistyped --dryrun (never a live run)", [...APPLY, "--dryrun"], /unknown flag/],
    ["an apply flag on rollback", ["rollback", "--user", U, ...PAIR, "--subject", "U2abc"], /unknown flag/],
    ["--issuer on rollback", ["rollback", "--user", U, ...PAIR, "--issuer", ISSUER], /unknown flag/],
    ["a retired provider-named flag", ["apply", "--user", U, "--descope-subject", "U2abc"], /unknown flag/],
    ["a duplicate flag", ["rollback", "--user", U, "--user", U, ...PAIR], /more than once/],
    ["a duplicate --dry-run", ["rollback", "--user", U, ...PAIR, "--dry-run", "--dry-run"], /more than once/],
    ["a stray positional argument", ["rollback", "--user", U, ...PAIR, "extra"], /positional/],
    ["a single-dash flag", ["rollback", "--user", U, ...PAIR, "-dry-run"], /positional/],
  ])("refuses %s", (_label, argv, message) => {
    expect(() => parseIdentityLinkCutoverArgs(argv)).toThrow(message);
  });

  it.each<[string, string[]]>([
    ["a user", ["rollback", "--user", "Secret-ish", ...PAIR]],
    ["a provider key", ["rollback", "--user", U, "--from", "Secret-ish", "--to", "descope"]],
    ["an issuer", ["apply", "--user", U, ...PAIR, "--subject", "U2abc", "--issuer", "Secret-ish"]],
  ])("never echoes %s in its errors", (_label, argv) => {
    expect(() => parseIdentityLinkCutoverArgs(argv)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("Secret-ish") }),
    );
  });
});
