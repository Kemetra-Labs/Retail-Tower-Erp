import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-959 (AC 5): control heights come from the tokens. `--control-h` (36px, the
 * desktop control) and `--target-touch` (44px, the compact touch target) are
 * declared once in tokens.css; a sizing declaration anywhere else that spells
 * 36px or 44px fails here.
 */

const root = process.cwd();
const SRC = join(root, "src");

/**
 * RT-969 (Shell v3, PR #131) owns these files and was in flight when this
 * landed; their touch targets move onto the tokens in its follow-up, not here.
 */
const RT969_SHELL = new Set([
  "src/shell/app-shell.css",
  "src/shell/scope-header.css",
  "src/shell/navigator.css",
]);

// CRLF-safe: a core.autocrlf checkout has CRLF files.
const stripComments = (css: string): string =>
  css.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

const SIZING =
  /\b((?:min-|max-)?(?:height|width|block-size|inline-size)|top|inset-block-start)\s*:\s*[^;]*\b(36|44)px\b[^;]*;/g;

function rawControlHeights(): string[] {
  return cssFiles(SRC).flatMap((path) => {
    const file = relative(root, path).replace(/\\/g, "/");
    if (file === "src/styles/tokens.css" || RT969_SHELL.has(file)) return [];
    const css = stripComments(readFileSync(path, "utf8"));
    return [...css.matchAll(SIZING)].map((m) => `${file}: ${m[0].trim()}`);
  });
}

describe("control height tokens (RT-959)", () => {
  const tokens = stripComments(readFileSync(join(SRC, "styles/tokens.css"), "utf8"));

  test("tokens.css declares --control-h (36px) and --target-touch (44px)", () => {
    expect(tokens).toMatch(/--control-h:\s*36px;/);
    expect(tokens).toMatch(/--target-touch:\s*44px;/);
  });

  test("no stylesheet spells a 36px or 44px size outside the tokens", () => {
    expect(rawControlHeights()).toEqual([]);
  });

  test("the guard catches a raw size (self-check)", () => {
    const sample = ".x { min-height: 36px; inline-size: max(100%, 44px); }";
    expect([...sample.matchAll(SIZING)]).toHaveLength(2);
  });
});
