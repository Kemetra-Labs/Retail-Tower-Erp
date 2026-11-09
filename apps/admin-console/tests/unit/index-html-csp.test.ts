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
const scriptTags = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

describe("index.html under a self-only CSP", () => {
  test("has no inline executable script: every script loads from a file", () => {
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scriptTags) {
      expect(attributes).toMatch(/\bsrc="\//);
      expect(body.trim()).toBe("");
    }
  });

  test("has no inline event handler attribute", () => {
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test("loads the pre-paint file as a blocking classic script before the app bundle", () => {
    const sources = scriptTags.map(([, attributes]) => attributes);
    const prePaint = sources.findIndex((a) => a.includes('src="/pre-paint.js"'));
    const bundle = sources.findIndex((a) => a.includes('type="module"'));
    expect(prePaint).toBeGreaterThanOrEqual(0);
    expect(prePaint).toBeLessThan(bundle);
    expect(sources[prePaint]).not.toMatch(/\b(async|defer|type=)/);
    expect(page.indexOf('src="/pre-paint.js"')).toBeLessThan(page.indexOf("</head>"));
  });
});
