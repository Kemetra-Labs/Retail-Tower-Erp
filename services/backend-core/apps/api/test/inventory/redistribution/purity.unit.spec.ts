/**
 * RT-1598 AC6 — the redistribution engine and validator are a pure module: no I/O, no database, no HTTP, no
 * framework. Every import stays inside `inventory/redistribution/`, and nothing loads the RT-1392 lane-cost
 * fixtures. A static read of the source files, so a new import fails here before review.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src/inventory/redistribution");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

describe("redistribution module purity", () => {
  const files = sourceFiles(ROOT);

  it("has an engine and a validator", () => {
    const rel = files.map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(rel).toEqual(expect.arrayContaining(["engine/reorder-gap-greedy.ts", "validator/validate-plan.ts"]));
  });

  it.each(files.map((f) => [relative(ROOT, f).replace(/\\/g, "/"), f]))("%s imports only files of this module", (_rel, file) => {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      expect(spec.startsWith(".")).toBe(true);
      const target = resolve(dirname(file), spec);
      expect(relative(ROOT, target).startsWith("..")).toBe(false);
    }
    expect(text).not.toMatch(/\bprocess\.env\b|\bfetch\(|\bsetTimeout\(|\bsetInterval\(|1392/);
  });

  it("keeps the validator independent of the engine's arithmetic", () => {
    for (const file of files.filter((f) => f.includes(`${join("redistribution", "validator")}`))) {
      expect(readFileSync(file, "utf8")).not.toMatch(/from\s*['"]\.\.\/engine/);
    }
  });
});
