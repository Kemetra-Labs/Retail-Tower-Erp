import {
  MAX_PEOPLE_IDS,
  chunkPeopleIds,
  normalizePeopleIds,
  usableName,
} from "@/people/peopleDirectory";
import { describe, expect, test, vi } from "vitest";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("people directory: ids (RT-1070)", () => {
  test("deduplicates case-insensitively, lower-cases and drops null, blank and non-UUID ids", () => {
    const a = uuid(1);
    expect(
      normalizePeopleIds([
        a,
        a.toUpperCase(),
        ` ${a} `,
        null,
        undefined,
        "",
        "not-a-uuid",
        uuid(2),
      ]),
    ).toEqual([a, uuid(2)]);
  });

  test("batches at the 200-id bound", () => {
    expect(MAX_PEOPLE_IDS).toBe(200);
    const ids = normalizePeopleIds(Array.from({ length: 450 }, (_, i) => uuid(i + 1)));
    expect(ids).toHaveLength(450);
    const chunks = chunkPeopleIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(ids);
    expect(chunkPeopleIds(ids.slice(0, 200))).toHaveLength(1);
    expect(chunkPeopleIds([])).toEqual([]);
  });

  test("a blank or null name is unusable (the id is shown)", () => {
    expect(usableName("  Omar Khaled ")).toBe("Omar Khaled");
    expect(usableName("   ")).toBeNull();
    expect(usableName(null)).toBeNull();
  });
});

describe("consoleListPeopleNames wire format", () => {
  test("sends ids comma-separated under one key", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost/");
    vi.resetModules();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (req: Request) => {
      seen.push(req.url);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { consoleListPeopleNames } = await import("@/lib/people-queries");
    await consoleListPeopleNames([uuid(1), uuid(2)]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    const url = new URL(seen[0] ?? "http://x/");
    expect(url.pathname).toBe("/api/v1/console/people");
    expect(url.searchParams.getAll("ids")).toEqual([`${uuid(1)},${uuid(2)}`]);
  });
});
