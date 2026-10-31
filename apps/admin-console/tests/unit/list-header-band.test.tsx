import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Drawer } from "@/components/Drawer";
import { ListHeaderBand } from "@/components/ListHeaderBand";

/**
 * RT-995 (D-V9, DESIGN.md v4.0 §12.6): the Ink header band of a list page and the
 * Ink header strip of an end drawer. Semantics are asserted on the rendered markup;
 * the visual contract (which role paints what, the 640px collapse, the forced-colours
 * fallbacks) on the stylesheet text, because jsdom does not compute `color-mix` or
 * media queries. The renders (1280x800, 390 wide, with and without a banner, with a
 * long Arabic tenant name) are in the PR.
 */

afterEach(cleanup);

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const bandCss = read("src/components/list-header-band.css");
const drawerCss = read("src/components/drawer.css");

/** The body of the LAST `@media <query> {` block, balanced on braces. */
function mediaBlock(sheet: string, query: string): string {
  const start = sheet.lastIndexOf(`@media ${query}`);
  if (start < 0) throw new Error(`@media ${query} not found`);
  let depth = 0;
  for (let i = sheet.indexOf("{", start); i < sheet.length; i++) {
    if (sheet[i] === "{") depth++;
    if (sheet[i] === "}" && --depth === 0) return sheet.slice(sheet.indexOf("{", start) + 1, i);
  }
  throw new Error(`@media ${query} is not closed`);
}

describe("ListHeaderBand semantics", () => {
  test("is the page's one h1 with the group label and scope subtitle around it", () => {
    const { container } = render(
      <ListHeaderBand group="Management" title="Stores" subtitle="Stores in Northstar Retail" />,
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Stores" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // It is PageHeader's h1: a focus target after navigation, never a Tab stop.
    expect(h1.getAttribute("tabindex")).toBe("-1");
    expect(h1.hasAttribute("data-page-title")).toBe(true);
    expect(container.querySelector(".list-band__group")?.textContent).toBe("Management");
    expect(screen.getByText("Stores in Northstar Retail").className).toContain("list-band__sub");
    expect(container.querySelector("header")?.className).toContain("list-band");
  });

  test("the decorative rule before the group label is hidden from assistive technology", () => {
    const { container } = render(<ListHeaderBand group="Operations" title="Sales" />);
    expect(container.querySelector(".list-band__rule")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".list-band__group")?.textContent).toBe("Operations");
  });

  test("the actions sit at the inline end, the primary among them", () => {
    const { container } = render(
      <ListHeaderBand
        group="Management"
        title="Users"
        actions={
          <button type="button" className="btn-primary">
            Invite
          </button>
        }
      />,
    );
    const end = container.querySelector(".list-band__end") as HTMLElement;
    expect(within(end).getByRole("button", { name: "Invite" }).className).toContain("btn-primary");
    expect(end.className).toContain("page-header__end");
  });

  test("no actions and no facts leave neither slot in the DOM", () => {
    const { container } = render(<ListHeaderBand group="Integration" title="Audit log" />);
    expect(container.querySelector(".list-band__end")).toBeNull();
    expect(container.querySelector(".list-band__facts")).toBeNull();
    expect(container.querySelector(".list-band__sub")).toBeNull();
  });

  test("facts are a labelled description list of server-served whole-set values", () => {
    render(
      <ListHeaderBand
        group="Management"
        title="Users"
        facts={{
          label: "Memberships in this tenant",
          items: [
            { label: "Users", value: 12 },
            { label: "Active", value: 9 },
            { label: "Revoked", value: 3 },
          ],
        }}
      />,
    );
    const facts = screen.getByLabelText("Memberships in this tenant");
    expect(facts.tagName).toBe("DL");
    expect(Array.from(facts.querySelectorAll("dt")).map((e) => e.textContent)).toEqual([
      "Users",
      "Active",
      "Revoked",
    ]);
    expect(Array.from(facts.querySelectorAll("dd")).map((e) => e.textContent)).toEqual([
      "12",
      "9",
      "3",
    ]);
    // Valid dl content: in each group the term comes first, then its description,
    // so assistive technology pairs every figure with its own label.
    for (const group of Array.from(facts.children)) {
      expect(Array.from(group.children).map((e) => e.tagName)).toEqual(["DT", "DD"]);
    }
    // The figure still reads first, by a column-reverse flex, not by markup order.
    expect(bandCss).toMatch(/\.list-band__facts > div \{[^}]*flex-direction: column-reverse/s);
  });

  test("at most three facts, by type", () => {
    // A fourth fact must not compile: @ts-expect-error fails the typecheck if it does.
    render(
      <ListHeaderBand
        group="Management"
        title="Stores"
        facts={{
          label: "Stores",
          // @ts-expect-error D-V9: at most three facts in the band
          items: [
            { label: "a", value: 1 },
            { label: "b", value: 2 },
            { label: "c", value: 3 },
            { label: "d", value: 4 },
          ],
        }}
      />,
    );
    expect(document.querySelectorAll(".list-band__facts > div").length).toBeGreaterThan(0);
  });
});

describe("ListHeaderBand stylesheet", () => {
  const wide = mediaBlock(bandCss, "(min-width: 640px)");
  const forced = mediaBlock(bandCss, "(forced-colors: active)");

  test("Ink and the ornament exist only from 640px: below it the band is a plain light header", () => {
    const outside = bandCss.replace(wide, "").replace(forced, "");
    expect(outside).not.toMatch(/var\(--color-ink\)/);
    expect(outside).not.toMatch(/var\(--color-mint\)/);
    expect(outside).not.toMatch(/gradient/);
    expect(wide).toMatch(/\.list-band \{[^}]*background-color: var\(--color-ink\)/s);
    expect(wide).toMatch(/\.list-band \{[^}]*color: var\(--color-on-ink\)/s);
  });

  test("the band is a role-token surface: fixed Ink roles, not the themed surface", () => {
    const band = /\.list-band \{([^}]*)\}/s.exec(wide)?.[1] ?? "";
    expect(band).not.toMatch(/--color-(surface|background|text)\b/);
    expect(band).toContain("var(--radius-panel)");
    expect(band).toContain("min-block-size: 112px");
    // The height is set by its content, so a cap here would clip a wrapped title.
    expect(band).not.toMatch(/max-block-size|max-height/);
  });

  test("the primary is a Mint fill with Ink text, only inside the Ink band", () => {
    const rule = /\.list-band \.btn-primary \{([^}]*)\}/s.exec(wide)?.[1] ?? "";
    expect(rule).toContain("--btn-bg: var(--color-mint)");
    expect(rule).toContain("--btn-fg: var(--color-ink)");
    expect(bandCss.replace(wide, "")).not.toMatch(/--btn-bg: var\(--color-mint\)/);
  });

  test("other actions are outlines in the on-Ink colour", () => {
    const rule =
      /\.list-band :is\(\.btn-secondary, \.btn-ghost\) \{([^}]*)\}/s.exec(wide)?.[1] ?? "";
    expect(rule).toContain("--btn-fg: var(--color-on-ink)");
    expect(rule).toContain("--btn-bg: transparent");
  });

  test("the global focus ring is Mint on the band (Tower Teal is 2.7:1 on Ink)", () => {
    expect(wide).toMatch(/--color-focus-ring: var\(--color-mint\)/);
  });

  test("secondary text is ink-muted, the group label is Mint (accent only)", () => {
    expect(wide).toMatch(/\.list-band__sub \{[^}]*color: var\(--color-ink-muted\)/s);
    expect(wide).toMatch(/\.list-band__group \{[^}]*color: var\(--color-mint\)/s);
  });

  test("forced colours: Canvas/CanvasText with a 1px border, no ornament, no glow", () => {
    expect(forced).toMatch(/\.list-band \{[^}]*background-image: none/s);
    expect(forced).toMatch(/\.list-band \{[^}]*border: 1px solid CanvasText/s);
    expect(forced).toMatch(/\.list-band \{[^}]*box-shadow: none/s);
  });

  test("forced colours: text and buttons are named as system colours, never left to the override", () => {
    expect(forced).toMatch(/\.list-band__sub,[^{]*\{\s*color: CanvasText/);
    expect(forced).toMatch(/--btn-fg: ButtonText/);
    expect(forced).toMatch(/--btn-bg: ButtonFace/);
  });

  test("no animation", () => {
    const code = bandCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/animation|transition|@keyframes/);
  });
});

describe("Ink drawer header", () => {
  test("an end drawer's header shows the title, an optional scope line and the close button", () => {
    const { container } = render(
      <Drawer title="Invite a user" scope="Northstar Retail" onClose={() => {}}>
        <input aria-label="Email" />
      </Drawer>,
    );
    const head = container.querySelector(".drawer__head") as HTMLElement;
    expect(within(head).getByRole("heading", { level: 2, name: "Invite a user" })).toBeDefined();
    expect(head.querySelector(".drawer__scope")?.textContent).toBe("Northstar Retail");
    expect(within(head).getByRole("button", { name: /close/i })).toBeDefined();
    // The form body is not part of the header.
    expect(container.querySelector(".drawer__body")?.contains(head)).toBe(false);
  });

  test("with no scope the title stays a direct child of the header, as before", () => {
    const { container } = render(
      <Drawer title="Details" onClose={() => {}}>
        <p>body</p>
      </Drawer>,
    );
    expect(container.querySelector(".drawer__scope")).toBeNull();
    expect(container.querySelector(".drawer__heading")).toBeNull();
    expect(container.querySelector(".drawer__head > .drawer__title")).not.toBeNull();
  });

  test("Ink applies to end drawers only: the navigation drawer keeps its light header", () => {
    expect(drawerCss).toMatch(
      /\.drawer:not\(\.drawer--start\) \.drawer__head \{[^}]*background-color: var\(--color-ink\)/s,
    );
    expect(drawerCss).toMatch(
      /\.drawer:not\(\.drawer--start\) \.drawer__head \{[^}]*color: var\(--color-on-ink\)/s,
    );
    const rendered = render(
      <Drawer title="Menu" side="start" onClose={() => {}}>
        <p>nav</p>
      </Drawer>,
    );
    expect(rendered.container.querySelector(".drawer--start")).not.toBeNull();
  });

  test("the form body stays light; the focus ring is Mint on the strip; forced colours name system colours", () => {
    expect(drawerCss).not.toMatch(/\.drawer__body \{[^}]*--color-ink/s);
    expect(drawerCss).toMatch(/\.drawer__head \{[^}]*--color-focus-ring: var\(--color-mint\)/s);
    const forced = mediaBlock(drawerCss, "(forced-colors: active)");
    expect(forced).toMatch(/\.drawer__head \{[^}]*background-image: none[^}]*CanvasText/s);
    expect(forced).toMatch(/--btn-fg: ButtonText/);
    // ButtonText is paired with ButtonFace, so the close icon never sits on Canvas.
    expect(forced).toMatch(/\.drawer__head \.btn-ghost \{[^}]*--btn-bg: ButtonFace/s);
  });
});

describe("applied to the existing list pages", () => {
  // Navigation-group heading of each list route (nav-model.ts).
  const PAGES: Record<string, string> = {
    "src/sales/SaleList.tsx": "shell.nav.section.operations",
    "src/catalog/CatalogProductList.tsx": "shell.nav.section.operations",
    "src/devices/DeviceList.tsx": "shell.nav.section.operations",
    "src/shift-closes/ShiftCloseList.tsx": "shell.nav.section.operations",
    "src/inventory/InventoryStores.tsx": "shell.nav.section.operations",
    "src/erp-status/ErpStatus.tsx": "erp.nav.section",
    "src/audit/AuditSearch.tsx": "erp.nav.section",
    "src/stores/StoreList.tsx": "shell.nav.section.management",
    "src/operators/MemberList.tsx": "shell.nav.section.management",
  };

  test.each(Object.entries(PAGES))("%s renders the band with its navigation group", (file, key) => {
    const src = read(file);
    expect(src).toMatch(/import \{[^}]*ListHeaderBand[^}]*\} from "@\/components\/ListHeaderBand"/);
    expect(src).toContain(`group={t("${key}")}`);
    // One header per page, and no plain PageHeader left beside the band.
    expect(src).not.toMatch(/<PageHeader\b/);
    expect(src.match(/<ListHeaderBand\b/g)).toHaveLength(1);
  });

  test("the band takes no children: notes and banners sit below it", () => {
    // Always self-closing: a closing tag would mean children inside the band.
    for (const file of Object.keys(PAGES)) expect(read(file)).not.toContain("</ListHeaderBand>");
  });
});
