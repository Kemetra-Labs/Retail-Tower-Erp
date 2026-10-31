import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-1039 (DESIGN.md §12.6; D-V3, D-V10): the pressed segment of `.segmented` is
 * the action-fill pair, Ink with white text on light and Mint with Ink text on
 * dark. The colour pairs, including the track, are tested in
 * tokens-identity.test.ts; this pins how the control reads them, so the pressed
 * state cannot drift back to a white chip or a Teal wash.
 */

const root = process.cwd();
// CRLF-safe: a core.autocrlf checkout has CRLF files.
const read = (file: string): string =>
  readFileSync(join(root, file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const css = read("src/overview/overview.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string, indent = ""): string {
  const start = source.indexOf(`\n${indent}${selector} {`);
  if (start < 0) throw new Error(`rule ${selector} not found`);
  return source.slice(start, source.indexOf("}", start));
}

describe("RT-1039 segmented control fill", () => {
  const pressed = rule(css, '.segmented__btn[aria-pressed="true"]');

  test("the pressed segment is the action-fill pair, not the surface chip or Teal", () => {
    expect(pressed).toContain("background: var(--color-action-fill);");
    expect(pressed).toContain("border-color: var(--color-action-fill);");
    expect(pressed).toContain("color: var(--color-on-action-fill);");
    expect(pressed).not.toContain("--color-primary");
    expect(pressed).not.toContain("--color-surface");
  });

  test("the pressed state differs by more than colour: a filled shape and a stronger weight", () => {
    const base = rule(css, ".segmented__btn");
    expect(base).toContain("background: transparent;");
    expect(base).toContain("font: var(--weight-regular)");
    expect(pressed).toContain("font-weight: var(--weight-strong);");
  });

  test("the track stays recessed and the 30px hit target is kept", () => {
    expect(rule(css, ".segmented")).toContain("background: var(--color-surface-sunken);");
    expect(rule(css, ".segmented__btn")).toContain("min-block-size: 30px;");
  });

  test("only the pressed state reads the selection fill: no hover or press rule does", () => {
    const rules = css.match(/\.segmented[^{]*\{[^}]*\}/g) ?? [];
    for (const r of rules) {
      if (r.includes('[aria-pressed="true"]')) continue;
      expect(r).not.toContain("action-fill");
    }
    expect(css).not.toMatch(/\.segmented__btn:(hover|active)[^{]*\{[^}]*action-fill/);
  });

  test("no component spells the Ink or Mint hex", () => {
    expect(css.toLowerCase()).not.toMatch(/#0a2125|#5fe0cf/);
  });
});

describe("RT-1039 forced colours", () => {
  // Only the body of the media block, by brace matching: a rule moved after it must fail.
  const start = css.indexOf("@media (forced-colors: active)");
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const forced = css.slice(start, end);

  test("every segment keeps a boundary and the pressed one is Highlight / HighlightText", () => {
    expect(forced).toMatch(/\.segmented__btn \{\s*border-color: ButtonText;/);
    const pressed = rule(forced, '.segmented__btn[aria-pressed="true"]', "  ");
    expect(pressed).toContain("forced-color-adjust: none;");
    expect(pressed).toContain("background: Highlight;");
    expect(pressed).toContain("color: HighlightText;");
    expect(pressed).toContain("border-color: Highlight;");
  });
});
