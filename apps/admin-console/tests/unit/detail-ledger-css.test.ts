import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-961 Precision Ledger. jsdom computes no stylesheet, so the rules the detail
 * template depends on are pinned here as text; the computed result (end edges
 * lining up in both directions, the row-header divider) is checked in
 * tests/e2e/detail-template.spec.ts.
 */
const root = process.cwd();
// CRLF-safe: a core.autocrlf checkout has CRLF files.
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const surface = read("src/shell/surface.css");
const dataTable = read("src/components/data-table.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule ${selector} not found`);
  return css.slice(start, css.indexOf("}", start));
}

describe("data table rows (RT-961 AC 4)", () => {
  test("a row's header cell gets the same padding and divider as its data cells", () => {
    const cells = rule(dataTable, ".data-table__row :is(td, th)");
    expect(cells).toMatch(/padding:\s*var\(--space-4\)/);
    expect(cells).toMatch(/border-bottom:\s*1px solid var\(--color-border\)/);
    expect(dataTable).not.toMatch(/\n\.data-table__row td \{/);
  });

  test("a row header reads as a label at the start, not a bold centred th", () => {
    const head = rule(dataTable, '.data-table__row th[scope="row"]');
    expect(head).toMatch(/text-align:\s*start/);
    expect(head).toMatch(/font-weight:\s*var\(--weight-medium\)/);
  });

  test("a numeric cell is end-aligned with tabular numerals, header included", () => {
    const num = rule(dataTable, ".data-table :is(th, td).data-table__cell--num");
    expect(num).toMatch(/text-align:\s*end/);
    expect(num).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe("detail ledger rows (RT-961 AC 2, 3)", () => {
  test("the label is muted and never heavier than the value: both regular, the value at body size", () => {
    const label = rule(surface, ".field-row__label");
    expect(label).toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(label).toMatch(/var\(--weight-regular\) var\(--text-control\)/);
    const value = rule(surface, ".field-row__value");
    expect(value).toMatch(/var\(--weight-regular\) var\(--text-body\)/);
  });

  test("machine values stay mono", () => {
    expect(rule(surface, ".field-row__value--mono")).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  test("money values are end-aligned and tabular", () => {
    const money = rule(surface, ".field-row__value--money");
    expect(money).toMatch(/text-align:\s*end/);
    expect(money).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  test("a total row is anchored under a strong rule", () => {
    expect(rule(surface, ".field-row--total")).toMatch(
      /border-top:\s*2px solid var\(--color-text\)/,
    );
  });

  test("no letter-spacing (it breaks Arabic joining)", () => {
    expect(surface).not.toMatch(/letter-spacing/);
    expect(dataTable).not.toMatch(/letter-spacing/);
  });
});
