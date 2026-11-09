import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * RT-1299 1c: the hosted Console is served under `default-src 'self'` (the Caddy
 * CSP), which refuses inline scripts. Every script in index.html must therefore
 * load from a same-origin file, and the pre-paint script must run before the app
 * bundle so a stored dark theme or English locale applies before first paint.
 */
const page = readFileSync(join(process.cwd(), "index.html"), "utf8");
// Parse with the HTML parser instead of a regex, so every script tag form counts.
const doc = new DOMParser().parseFromString(page, "text/html");
const scripts = [...doc.querySelectorAll("script")];

describe("index.html under a self-only CSP", () => {
  test("has no inline executable script: every script loads from a file", () => {
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.getAttribute("src") ?? "").toMatch(/^\//);
      expect(script.textContent?.trim()).toBe("");
    }
  });

  test("has no inline event handler attribute", () => {
    for (const element of doc.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute.startsWith("on")).toBe(false);
      }
    }
  });

  test("loads the pre-paint file as a blocking classic script before the app bundle", () => {
    const prePaint = scripts.findIndex((s) => s.getAttribute("src") === "/pre-paint.js");
    const bundle = scripts.findIndex((s) => s.getAttribute("type") === "module");
    expect(prePaint).toBeGreaterThanOrEqual(0);
    expect(prePaint).toBeLessThan(bundle);
    const prePaintScript = scripts[prePaint];
    for (const attribute of ["async", "defer", "type"]) {
      expect(prePaintScript?.hasAttribute(attribute)).toBe(false);
    }
    expect(prePaintScript?.parentElement?.tagName).toBe("HEAD");
  });
});
