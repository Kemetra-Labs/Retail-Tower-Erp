// RT-1120 — before/after captures of the Checkout order summary (#/dev/checkout-proof) at 1024×768
// and 1280×800, light and forced-colors. At 1024 the summary is a strip and its list opens on
// «عرض الأصناف», so the script opens it first. The log records, for every name, its computed
// white-space / line-height / line clamp, its rendered line count, whether it is truncated, and
// the amount's rect (to show it stays anchored), plus whether the page overflows the viewport.
// Each page load adds `?r=<n>` before the hash: the Vite DEV harness keeps module state, so a fresh
// query string forces a remount.
// Usage (apps/pos, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-1120/tools/capture-rt1120.cjs <outDir> <label> [baseUrl]
// Set CHROME_PATH to use a specific browser; by default the installed Chrome channel is used.
const path = require('path');
const fs = require('fs');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd()] }));
const [outDir, label, base = 'http://localhost:5173'] = process.argv.slice(2);
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
const MODES = [
  { name: 'light', forcedColors: 'none' },
  { name: 'forced', forcedColors: 'active' },
];
const PAGES = [
  { name: 'default10', hash: '#/dev/checkout-proof' },
  { name: 'lines4', hash: '#/dev/checkout-proof?lines=4' },
  { name: 'mixed', hash: '#/dev/checkout-proof?preset=mixed' },
];

function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    const names = Array.from(document.querySelectorAll('.v5-order-summary__name')).map((el) => {
      const s = getComputedStyle(el);
      const lh = Number.parseFloat(s.lineHeight);
      const amount = el.parentElement.querySelector('.v5-order-summary__amount');
      return {
        text: el.textContent,
        whiteSpace: s.whiteSpace,
        lineClamp: s.webkitLineClamp,
        display: s.display,
        lineHeightPx: lh,
        lineHeightRatio: Number((lh / Number.parseFloat(s.fontSize)).toFixed(3)),
        lines: Math.round(el.getBoundingClientRect().height / lh),
        truncated: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
        rect: rect(el),
        amountRect: rect(amount),
      };
    });
    const list = document.querySelector('.v5-order-summary__lines');
    const root = document.documentElement;
    return {
      names,
      listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : null,
      pageOverflowY: root.scrollHeight - window.innerHeight,
      pageOverflowX: root.scrollWidth - window.innerWidth,
    };
  });
}

async function capture(browser, viewport, mode, target, n) {
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
  await page.goto(`${base}/?r=${String(n)}${target.hash}`);
  await page.waitForSelector('.v5-order-summary');
  const toggle = page.locator('.v5-order-summary__toggle');
  if (await toggle.isVisible()) await toggle.click();
  await page.waitForSelector('.v5-order-summary__name', { state: 'visible' });
  await page.waitForTimeout(600);
  const size = `${String(viewport.width)}x${String(viewport.height)}`;
  const file = `rt1120-${target.name}-${size}-${mode.name}-${label}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  const result = { file, page: target.name, viewport: size, mode: mode.name, errors, ...(await measure(page)) };
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
    for (const mode of MODES)
      for (const target of PAGES) results.push(await capture(browser, viewport, mode, target, (n += 1)));
  await browser.close();
  fs.writeFileSync(path.join(outDir, `rt1120-${label}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.errors.length > 0);
  console.log(`${String(results.length)} captures, ${String(failed.length)} with page errors`);
  if (failed.length > 0) process.exitCode = 1;
})();
