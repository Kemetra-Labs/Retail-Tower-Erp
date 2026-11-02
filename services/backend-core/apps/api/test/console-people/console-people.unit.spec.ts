/**
 * RT-1063 — the pure parts of the console people-name read: the bounded
 * `ids` schema (RT-1051 order: count and length before any element), the
 * display-name projection and the counts-only audit metadata. No DB, no HTTP
 * (the HTTP suite is `console-people.http.integration.spec.ts`).
 */
import { ZodError } from "zod";

import { peopleNamesAuditOf } from "../../src/console-people/console-people.controller";
import {
  ListPeopleNamesQuerySchema,
  PEOPLE_IDS_MAX,
  PEOPLE_IDS_MAX_LENGTH,
} from "../../src/console-people/console-people.query";
import { displayNameOf, projectPeopleNames } from "../../src/console-people/console-people.service";

const uuid = (n: number): string => `0a000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const A = uuid(1);
const B = uuid(2);

function issuesOf(query: unknown): ZodError["issues"] {
  const r = ListPeopleNamesQuerySchema.safeParse(query);
  if (r.success) throw new Error(`expected a refusal for ${JSON.stringify(query).slice(0, 80)}`);
  return r.error.issues;
}

describe("RT-1063 ids — accepted values", () => {
  it("parses one id", () => {
    expect(ListPeopleNamesQuerySchema.parse({ ids: A })).toEqual({ ids: [A] });
  });

  it("parses 200 ids, the contract maximum", () => {
    const ids = Array.from({ length: PEOPLE_IDS_MAX }, (_, i) => uuid(i + 1));
    const raw = ids.join(",");
    expect(raw.length).toBe(PEOPLE_IDS_MAX_LENGTH);
    expect(ListPeopleNamesQuerySchema.parse({ ids: raw }).ids).toEqual(ids);
  });

  it("lower-cases and answers a repeated id once", () => {
    expect(ListPeopleNamesQuerySchema.parse({ ids: `${A.toUpperCase()},${B},${A}` })).toEqual({ ids: [A, B] });
  });

  it("states the 7,399-character bound of the contract", () => {
    expect(PEOPLE_IDS_MAX_LENGTH).toBe(7399);
  });
});

describe("RT-1063 ids — 400 refusals", () => {
  it.each([
    ["missing", {}],
    ["empty", { ids: "" }],
    ["given twice (an array)", { ids: [A, B] }],
    ["not a UUID", { ids: "not-a-uuid" }],
    ["an empty element", { ids: `${A},,${B}` }],
    ["a trailing comma", { ids: `${A},` }],
    ["a braced UUID", { ids: `{${A}}` }],
    ["a UUID without dashes", { ids: A.replace(/-/g, "") }],
    ["a padded element", { ids: ` ${A}` }],
    ["another query key", { ids: A, tenant_id: B }],
  ])("refuses %s", (_label, query) => {
    expect(issuesOf(query).length).toBeGreaterThan(0);
  });

  it("refuses 201 ids with one issue, before any element is parsed", () => {
    const raw = Array.from({ length: PEOPLE_IDS_MAX + 1 }, () => "x").join(",");
    const issues = issuesOf({ ids: raw });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/at most 200 ids/);
  });

  it("refuses a value of 7,400 characters with one issue, before it is split", () => {
    const issues = issuesOf({ ids: "x".repeat(PEOPLE_IDS_MAX_LENGTH + 1) });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/at most 7399 characters/);
  });

  it("refuses many bad elements with ONE issue that echoes no value", () => {
    const raw = Array.from({ length: PEOPLE_IDS_MAX }, (_, i) => `bad${i}`).join(",");
    const issues = issuesOf({ ids: raw });
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain("bad1");
  });

  it("never echoes a requested id in an issue", () => {
    expect(JSON.stringify(issuesOf({ ids: `${A},nope` }))).not.toContain(A);
  });
});

describe("RT-1063 display names (D-3)", () => {
  it.each([
    [null, null],
    ["", null],
    ["   \t ", null],
    ["  Yara  ", "Yara"],
    ["Cashier One", "Cashier One"],
  ])("%j → %j", (raw, expected) => {
    expect(displayNameOf(raw)).toBe(expected);
  });

  it("projects user_id and display_name only, by user_id ascending, lower-cased", () => {
    const body = projectPeopleNames([
      { user_id: B, display_name: " Bea " },
      { user_id: A.toUpperCase(), display_name: null },
    ]);
    expect(body).toEqual({
      items: [
        { user_id: A, display_name: null },
        { user_id: B, display_name: "Bea" },
      ],
    });
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["display_name", "user_id"]);
  });
});

describe("RT-1063 audit metadata (D-4)", () => {
  it("holds the two counts and nothing else", () => {
    expect(peopleNamesAuditOf(3, 1)).toEqual({ requested_count: 3, resolved_count: 1 });
  });
});
