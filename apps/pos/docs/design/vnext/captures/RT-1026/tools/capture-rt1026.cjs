// RT-1026 — before/after captures of the held-payment recovery panel (#/dev/recovery-proof) and the
// Checkout payment ledger (#/dev/checkout-proof, recorded lines and change) at 1024×768 and 1280×800,
// light and forced-colors. The log records the computed styles of every `.v5-ledger-row` and its
// amount, so the promotion of the ledger row to the foundation can be shown not to move Checkout,
// and the stuck panel's facts and cancel button, so the ledger rows and OD-5 neutral cancel show.
// Each page load adds `?r=<n>` before the hash: the Vite DEV harness keeps module state, so a fresh
// query string forces a remount.
// Usage (apps/pos, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-1026/tools/capture-rt1026.cjs <outDir> <label> [baseUrl]
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
  { name: 'recovery', hash: '#/dev/recovery-proof?view=typical', ready: '#recovery-stuck' },
  { name: 'recovery-long', hash: '#/dev/recovery-proof?view=long', ready: '#recovery-stuck' },
  { name: 'checkout-mixed', hash: '#/dev/checkout-proof?preset=mixed', ready: '.v5-ledger' },
  { name: 'checkout-change', hash: '#/dev/checkout-proof?preset=change', ready: '.v5-ledger' },
];
const STYLE_PROPS = [
  'display', 'justifyContent', 'alignItems', 'columnGap', 'minHeight', 'marginTop', 'marginBottom',
  'paddingTop', 'paddingBottom', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
  'fontSize', 'fontWeight', 'fontFamily', 'fontVariantNumeric', 'color', 'backgroundColor',
];

function measure(page) {
  return page.evaluate((props) => {
    const pick = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        text: el.textContent.trim().slice(0, 60),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        ...Object.fromEntries(props.map((p) => [p, s[p]])),
      };
    };
    const all = (sel) => Array.from(document.querySelectorAll(sel)).map(pick);
    return {
      ledgerRows: all('.v5-ledger-row'),
      ledgerAmounts: all('.v5-ledger-row__amount'),
      stuckFacts: all('[aria-labelledby="recovery-stuck"] dl > *'),
      stuckValues: all('[aria-labelledby="recovery-stuck"] dd'),
      stuckButtons: all('[aria-labelledby="recovery-stuck"] button'),
      heldButtons: all('[aria-labelledby="recovery-held"] button'),
    };
  }, STYLE_PROPS);
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
  await page.waitForSelector(target.ready);
  await page.waitForTimeout(600);
  const size = `${String(viewport.width)}x${String(viewport.height)}`;
  const file = `rt1026-${target.name}-${size}-${mode.name}-${label}.png`;
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
  fs.writeFileSync(path.join(outDir, `rt1026-${label}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.errors.length > 0);
  console.log(`${String(results.length)} captures, ${String(failed.length)} with page errors`);
  if (failed.length > 0) process.exitCode = 1;
})();
