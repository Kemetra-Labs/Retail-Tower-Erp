import { describe, expect, test } from "vitest";

import { directoryRows, filterTenants } from "@/platform/tenants/directoryLogic";

/**
 * RT-782 (RT-777 S3): the tenant directory's client-side search and row action.
 * `listTenants` returns `TenantSummary` (id, slug, name, and since the RT-889
 * repin a required `status`) and no store counts; neither status nor counts are
 * derived here.
 */
const tenants = [
  { id: "t1", slug: "delta-markets", name: "أسواق الدلتا", status: "active" as const },
  { id: "t2", slug: "nile-pharma", name: "Nile Pharma", status: "active" as const },
  { id: "t3", slug: "rayan", name: "الريان للتجارة", status: "active" as const },
];

describe("filterTenants", () => {
  test("an empty or blank query keeps every tenant in server order", () => {
    expect(filterTenants(tenants, "").map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(filterTenants(tenants, "   ").map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("matches the name, case-insensitively, trimmed", () => {
    expect(filterTenants(tenants, "  nile ").map((t) => t.id)).toEqual(["t2"]);
    expect(filterTenants(tenants, "الريان").map((t) => t.id)).toEqual(["t3"]);
  });

  test("matches the slug", () => {
    expect(filterTenants(tenants, "DELTA").map((t) => t.id)).toEqual(["t1"]);
  });

  test("no match is an empty list, not the full list", () => {
    expect(filterTenants(tenants, "zzz")).toEqual([]);
  });

  test("a tenant without a name or slug still lists and never throws", () => {
    const bare = { id: "t9", status: "active" as const };
    expect(filterTenants([bare], "x")).toEqual([]);
    expect(filterTenants([bare], "")).toEqual([bare]);
  });
});

describe("directoryRows", () => {
  test("a tenant the caller is a member of offers the normal switch, not a support session", () => {
    const rows = directoryRows(tenants, [{ tenant_id: "t2" }]);
    expect(rows.map((r) => [r.id, r.action])).toEqual([
      ["t1", "start"],
      ["t2", "switch"],
      ["t3", "start"],
    ]);
  });

  test("rows without an id are dropped: no action could name them", () => {
    const ghost = { name: "ghost", status: "active" as const };
    expect(directoryRows([ghost, ...tenants], []).map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("the name falls back to the slug, then the id", () => {
    const rows = directoryRows(
      [
        { id: "a", slug: "only-slug", status: "active" },
        { id: "b", status: "active" },
      ],
      [],
    );
    expect(rows.map((r) => r.name)).toEqual(["only-slug", "b"]);
  });
});
