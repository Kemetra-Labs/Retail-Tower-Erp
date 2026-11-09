import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

afterEach(cleanup);

/**
 * RT-1299 3b (RT-757, owner decision 2026-11-09): the whole header cell of a
 * sortable column is the sort button's hit area, not only its 16px text line.
 * The button stays the one native control (keyboard sort unchanged); its
 * invisible ::after is stretched over the cell, which is its containing block.
 * jsdom has no layout, so the geometry is pinned by the stylesheet rules.
 */

interface Row {
  id: string;
  name: string;
}

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, sortable: true },
  { key: "note", header: "Note", cell: () => "-" },
];

const css = readFileSync(join(process.cwd(), "src/components/data-table.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("sortable header cell is the hit area", () => {
  test("a sortable header cell is marked; a plain one is not", () => {
    render(
      <DataTable
        caption="Stores"
        columns={columns}
        rows={[{ id: "1", name: "Zeta" }]}
        rowKey={(r) => r.id}
        onRowActivate={() => {}}
        sort={null}
        onSortChange={() => {}}
      />,
    );
    const sortable = screen.getByRole("columnheader", { name: "Name" });
    expect(sortable.classList.contains("data-table__th--sortable")).toBe(true);
    expect(within(sortable).getByRole("button", { name: "Name" })).toBeTruthy();
    const plain = screen.getByRole("columnheader", { name: "Note" });
    expect(plain.classList.contains("data-table__th--sortable")).toBe(false);
  });

  test("the cell is the containing block and is at least the 36px target tall", () => {
    const cell = rule(".data-table thead th.data-table__th--sortable");
    expect(cell).toMatch(/position:\s*relative/);
    expect(cell).toMatch(/block-size:\s*var\(--control-h\)/);
  });

  test("the button's hit area covers the whole cell", () => {
    expect(rule(".data-table__th--sortable .data-table__sort")).toMatch(/position:\s*static/);
    const after = rule(".data-table__th--sortable .data-table__sort::after");
    expect(after).toMatch(/inset:\s*0/);
    expect(after).toMatch(/transform:\s*none/);
    expect(after).toMatch(/inline-size:\s*auto/);
    expect(after).toMatch(/block-size:\s*auto/);
  });
});
