import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-960 (AC 1): the bespoke list filter bars are gone. Every list lays its
 * filters out with the shared FilterBar (src/components/filter-bar.css); no
 * stylesheet or component keeps one of the old filter-bar class names.
 */
const RETIRED = [
  "sale-filters",
  "device-filters",
  "audit-filters",
  "catalog-filters",
  "shift-filters",
  "erp-filter",
  "recon-filter",
  "unknown-item-controls",
];

const root = process.cwd();

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

function uses(ext: RegExp): string[] {
  return files(join(root, "src"), ext).flatMap((path) => {
    const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const file = relative(root, path).replace(/\\/g, "/");
    return RETIRED.filter((name) => new RegExp(`\\b${name}(?:__|\\b)`).test(text)).map(
      (name) => `${file}: ${name}`,
    );
  });
}

describe("one FilterBar (RT-960)", () => {
  test("no stylesheet keeps a bespoke filter-bar class", () => {
    expect(uses(/\.css$/)).toEqual([]);
  });

  test("no component renders a bespoke filter-bar class", () => {
    expect(uses(/\.tsx$/)).toEqual([]);
  });
});
