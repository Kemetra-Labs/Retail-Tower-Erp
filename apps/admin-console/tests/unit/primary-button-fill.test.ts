import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-1038 (DESIGN.md §12.6; D-V3, D-V10): the primary action is the action-fill
 * pair, Ink with white text on light and Mint with Ink text on dark. The colour
 * pairs are tested in tokens-identity.test.ts; this pins how the button reads
 * them, so it cannot drift back to Teal or land Ink on an Ink surface.
 */

const root = process.cwd();
// CRLF-safe: a core.autocrlf checkout has CRLF files.
const read = (file: string): string =>
  readFileSync(join(root, file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const controls = read("src/styles/controls.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule ${selector} not found`);
  return css.slice(start, css.indexOf("}", start));
}

describe("RT-1038 primary button fill", () => {
  const primary = rule(controls, ".btn-primary");

  test("the fill, edge and text come from the action-fill pair, not Teal", () => {
    expect(primary).toContain("--btn-bg: var(--color-action-fill);");
    expect(primary).toContain("--btn-edge: var(--color-action-fill);");
    expect(primary).toContain("--btn-fg: var(--color-on-action-fill);");
    expect(primary).not.toContain("--color-primary");
    expect(primary).not.toContain("--color-on-primary");
  });

  test("hover steps the fill and press is a distinct deeper step, in both themes", () => {
    expect(primary).toMatch(/--btn-bg-hover:\s*color-mix\(/);
    expect(primary).toContain("--btn-bg-press: var(--color-action-fill);");
    const dark = rule(controls, '[data-theme="dark"] .btn-primary');
    // Mint cannot lighten: dark presses toward Ink, deeper than the resting fill.
    expect(dark).toMatch(/--btn-bg-press:\s*color-mix\(in oklab, var\(--color-action-fill\)/);
  });

  test("hover adds a short Ink shadow and lifts 1px, never on an unavailable or busy button", () => {
    const hover = rule(controls, '.btn-primary:hover:not(:disabled, [aria-disabled="true"])');
    expect(hover).toContain("box-shadow:");
    expect(hover).toContain("var(--color-ink)");
    // The lift only where a pointer hovers, so it cannot stick after a tap; the
    // shadow eases in with it.
    expect(controls).toMatch(
      /@media \(hover: hover\) \{\s*\.btn-primary:hover:not\(:disabled, \[aria-disabled="true"\]\) \{\s*transform: translateY\(-1px\);/,
    );
    expect(primary).toContain("box-shadow var(--duration-2)");
    // The press drops the shadow, and reduced motion drops the lift.
    expect(controls).toMatch(
      /\.btn-primary:active:not\(:disabled, \[aria-disabled="true"\]\) \{\s*box-shadow: none;/,
    );
    expect(controls).toMatch(
      /prefers-reduced-motion: reduce\) \{[\s\S]*\.btn-primary:hover:not\(:disabled, \[aria-disabled="true"\]\) \{\s*transform: none;/,
    );
  });

  test("the 44px touch target and the shared button grammar are unchanged", () => {
    expect(controls).toMatch(
      /@media \(max-width: 768px\) \{\s*\.btn-primary \{\s*min-width: var\(--target-touch\);/,
    );
    expect(controls).toContain("min-height: var(--control-h);");
  });
});

describe("RT-1038 a primary on an Ink surface is never Ink on Ink", () => {
  // Each Ink surface redraws the primary as a Mint fill with Ink text, in its own rule.
  const surfaces: [string, string][] = [
    ["src/components/list-header-band.css", ".list-band .btn-primary"],
    ["src/stores/stores.css", ".store-hero .btn-primary"],
    ["src/platform/session/support-session.css", ".support-session-bar__main .btn-primary"],
  ];

  test.each(surfaces)("%s: %s is a Mint fill with Ink text", (file, selector) => {
    const css = read(file);
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("--btn-bg: var(--color-mint);");
    expect(block).toContain("--btn-fg: var(--color-ink);");
    expect(block).toContain("--btn-edge: var(--color-mint);");
  });
});

describe("RT-1038 forced colours", () => {
  test("the primary keeps a ButtonText border, as its fill is forced to Canvas", () => {
    const a11y = read("src/styles/a11y.css");
    const forced = a11y.slice(a11y.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.btn-primary,[\s\S]*?\{\s*border: 1px solid ButtonText;/);
  });
});
