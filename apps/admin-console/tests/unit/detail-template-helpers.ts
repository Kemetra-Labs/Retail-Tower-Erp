import { screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * RT-961: the v3 detail template's structure (DESIGN.md §5, §9). The back link
 * comes before the page header; each named data section is a section panel
 * (a region named by its panel title) and panels never nest.
 */
export function expectBackLinkFirst(): void {
  const h1 = screen.getByRole("heading", { level: 1 });
  const back = document.querySelector("a.surface__back");
  expect(back).not.toBeNull();
  expect((back as Element).compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

export function expectPanels(titles: readonly string[]): void {
  for (const title of titles) {
    const region = screen.getByRole("region", { name: title });
    expect(region.classList.contains("section-panel"), title).toBe(true);
    const heading = screen.getByRole("heading", { level: 2, name: title });
    expect(heading.classList.contains("section-panel__title"), title).toBe(true);
    expect(region.parentElement?.closest(".section-panel") ?? null, title).toBeNull();
  }
}

/** The value cell of a ledger row, by its label. */
export function ledgerValue(label: string, root: ParentNode = document): HTMLElement {
  const term = [...root.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  if (!term) throw new Error(`no ledger row ${label}`);
  return term.nextElementSibling as HTMLElement;
}

/** A money value: end-aligned in the ledger (RT-961 AC 3). */
export function expectMoney(value: HTMLElement): void {
  expect(value.classList.contains("field-row__value--money")).toBe(true);
}

/** The cells of one column (header first), by the header's text. */
export function columnCells(table: HTMLElement, header: string): HTMLElement[] {
  const heads = [...table.querySelectorAll("thead th")];
  const index = heads.findIndex((th) => th.textContent === header);
  if (index < 0) throw new Error(`no column ${header}`);
  const body = [...table.querySelectorAll("tbody tr")].map(
    (tr) => tr.children[index] as HTMLElement,
  );
  return [heads[index] as HTMLElement, ...body];
}

export function expectNumericColumn(table: HTMLElement, header: string): void {
  for (const cell of columnCells(table, header)) {
    expect(cell.classList.contains("data-table__cell--num"), header).toBe(true);
  }
}

/**
 * RT-974: a status in the page header (`HeaderStatus`), by its field label: the
 * badge, named for assistive tech as "<label>: <value>".
 */
export function headerStatus(label: string): HTMLElement {
  const statuses = [...document.querySelectorAll<HTMLElement>(".page-header .detail-status")];
  const status = statuses.find((el) => el.textContent?.startsWith(`${label}:`));
  if (!status) throw new Error(`no header status ${label}`);
  return status;
}
