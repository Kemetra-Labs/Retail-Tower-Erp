// RT-1193 — captures of the manager home (#/dev/manager-home-proof) at 1024x768 and 1280x800, light
// and forced-colors. `without` = every read answers zero (the tile as it was before RT-1193);
// `with` = a stuck payment and two stuck shifts; `held` = held sales only; `pending` = reads that
// never answer. The log records each tile's text, its count line, rect and the computed styles.
// Each page load adds `?r=<n>` before the hash: the Vite DEV harness keeps module state.
// Usage (apps/pos, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-1193/tools/capture-rt1193.cjs <outDir> <label> [baseUrl]
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
  { name: 'without', hash: '#/dev/manager-home-proof?held=none&shifts=none' },
  { name: 'with', hash: '#/dev/manager-home-proof?held=stuck&shifts=some' },
  { name: 'held', hash: '#/dev/manager-home-proof?held=held&shifts=pending' },
];

function measure(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.v5-manager-tile')).map((tile) => {
      const r = tile.getBoundingClientRect();
      const count = tile.querySelector('.v5-manager-tile__count');
      const dot = tile.querySelector('.v5-manager-tile__dot');
      return {
        title: tile.querySelector('.v5-manager-tile__title').textContent,
        count: count ? count.textContent : null,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        scrollFits: document.documentElement.scrollHeight <= window.innerHeight,
        dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
      };
    }),
  );
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
  await page.waitForSelector('.v5-manager-tile');
  await page.waitForTimeout(600);
  const size = `${String(viewport.width)}x${String(viewport.height)}`;
  const file = `rt1193-home-${target.name}-${size}-${mode.name}-${label}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  const result = { file, page: target.name, viewport: size, mode: mode.name, errors, tiles: await measure(page) };
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
  fs.writeFileSync(path.join(outDir, `rt1193-${label}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.errors.length > 0);
  console.log(`${String(results.length)} captures, ${String(failed.length)} with page errors`);
  if (failed.length > 0) process.exitCode = 1;
})();
