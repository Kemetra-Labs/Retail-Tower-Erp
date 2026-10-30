/**
 * identity-link-lookup.provider.unit.spec.ts — RT-937 (independent review, finding 2).
 *
 * Sign-in asks "does this user have an ACTIVE link to THE provider that verifies
 * passwords?". A user whose only active link belongs to another provider (a
 * pre-cutover link) must read as "no link to this provider", so they keep native
 * sign-in until the owner-run cutover flips the link. Without the provider filter
 * such a user would be sent to the wrong provider, refused, and locked out.
 *
 * Docker-free: a fake `query` records the SQL and parameters.
 */
import { activeLinkSubjectForProvider } from "../../src/auth/identity-link-lookup";

const USER_ID = "0193a000-0000-7000-8000-000000000001";

function fakeDb(rows: Array<{ subject: string }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { db: { query } as never, query };
}

describe("activeLinkSubjectForProvider", () => {
  it("returns the subject of the user's ACTIVE link to that provider", async () => {
    const { db, query } = fakeDb([{ subject: "U2subject" }]);

    expect(await activeLinkSubjectForProvider(db, USER_ID, "p")).toBe("U2subject");

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/provider_key\s*=\s*\$2/);
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/user_id\s*=\s*\$1/);
    expect(params).toEqual([USER_ID, "p"]);
  });

  it("returns null when the user has no active link to that provider", async () => {
    const { db } = fakeDb([]);
    expect(await activeLinkSubjectForProvider(db, USER_ID, "p")).toBeNull();
  });

  it("fails closed (null) when more than one row matches, rather than picking one", async () => {
    const { db } = fakeDb([{ subject: "a" }, { subject: "b" }]);
    expect(await activeLinkSubjectForProvider(db, USER_ID, "p")).toBeNull();
  });
});
