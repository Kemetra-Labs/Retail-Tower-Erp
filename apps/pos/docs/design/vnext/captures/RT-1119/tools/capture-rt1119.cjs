// RT-1119 — before/after captures of the live sale screen (LiveSaleWorkspace), reached from the DEV
// harness: #/dev/one-frame-proof, then click «نقطة البيع». Each capture is the empty cart (the
// handoff commit unavailable, so its reason shows after the change) at 1024×768 and 1280×800,
// light and forced-colors. The log records the command-bar label size, the handoff commit and its
// reason, whether the cart overflows, and an axe run. Each page load adds `?r=<n>` before the hash:
// the Vite DEV harness keeps module state, so a fresh query string forces a remount.
// Usage (apps/pos, with `npx vite --port <p>` running):
//   node docs/design/vnext/captures/RT-1119/tools/capture-rt1119.cjs <outDir> <label> [baseUrl]
// Set CHROME_PATH to use a specific browser; by default the installed Chrome channel is used.
const path = require('path');
const fs = require('fs');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd()] }));
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, label, base = 'http://localhost:5173'] = process.argv.slice(2);
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
const MODES = [
  { name: 'light', forcedColors: 'none' },
  { name: 'forced', forcedColors: 'active' },
];

function measure() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  const labels = [...document.querySelectorAll('.v5-sale-command-input label')].map((el) => ({
    text: el.textContent.trim(),
    fontSize: getComputedStyle(el).fontSize,
    fontWeight: getComputedStyle(el).fontWeight,
    color: getComputedStyle(el).color,
  }));
  const commit = [...document.querySelectorAll('.v5-sale-checkout')].find((el) =>
    el.textContent.includes('تسليم السلة للدفع'),
  );
  const describedBy = commit?.getAttribute('aria-describedby') ?? null;
  const reason = describedBy ? document.getElementById(describedBy) : null;
  const root = document.querySelector('.v5-live-sale');
  const cart = document.querySelector('.v5-sale-cart-table, .v5-sale-cart');
  return {
    labels,
    commit: commit
      ? { disabled: commit.disabled, rect: rect(commit), describedBy }
      : null,
    reason: reason
      ? {
          text: reason.textContent.trim(),
          fontSize: getComputedStyle(reason).fontSize,
          color: getComputedStyle(reason).color,
          rect: rect(reason),
        }
      : null,
    overflow: {
      page: [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight],
      liveSale: root ? [root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight] : null,
      cart: cart ? [cart.scrollWidth - cart.clientWidth, cart.scrollHeight - cart.clientHeight] : null,
    },
  };
}

async function capture(browser, viewport, mode, n) {
  const ctx = await browser.newContext({
    viewport,
    bypassCSP: true,
    timezoneId: 'Africa/Cairo',
    colorScheme: 'light',
    forcedColors: mode.forcedColors,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?r=${String(n)}#/dev/one-frame-proof`);
  await page.getByRole('link', { name: 'نقطة البيع' }).first().click();
  await page.waitForSelector('.v5-sale-command-input label');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const size = `${String(viewport.width)}x${String(viewport.height)}`;
  const file = `rt1119-sale-${size}-${mode.name}-${label}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  await page.addScriptTag({ path: AXE });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  });
  const result = { file, viewport: size, mode: mode.name, errors, axe, ...(await page.evaluate(measure)) };
  await ctx.close();
  return result;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
  );
  const results = [];
  let n = 0;
  for (const viewport of VIEWPORTS)
    for (const mode of MODES) results.push(await capture(browser, viewport, mode, (n += 1)));
  await browser.close();
  fs.writeFileSync(path.join(outDir, `rt1119-${label}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.errors.length > 0);
  console.log(`${String(results.length)} captures, ${String(failed.length)} with page errors`);
  if (failed.length > 0) process.exitCode = 1;
})();
