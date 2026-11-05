// RT-1192 — before/after captures of Returns (#/dev/returns-proof) and Void (#/dev/void-proof) at
// 1024x768 and 1280x800, light and forced-colors: the lookup screen, a lookup by the full number
// (works before and after), and (after only) a lookup by the short number and an ambiguous short number.
// The log records each screen's headings, rows, field hint, target sizes and horizontal overflow.
// Each page load adds `?r=<n>` before the hash: the Vite DEV harness keeps module state, so a fresh
// query string forces a remount.
// Usage (apps/pos, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-1192/tools/capture-rt1192.cjs <outDir> <label> [baseUrl] [--before]
// `--before` skips the short-number scenarios, which the code before RT-1192 does not have.
// Set CHROME_PATH to use a specific browser; by default the installed Chrome channel is used.
const path = require('path');
const fs = require('fs');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd()] }));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const before = process.argv.includes('--before');
const [outDir, label, base = 'http://localhost:5173'] = args;
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
const MODES = [
  { name: 'light', forcedColors: 'none' },
  { name: 'forced', forcedColors: 'active' },
];
const FULL_RETURNS = 'TERM-01-2026-10-15-000042';
const FULL_VOID = 'TERM-01-2026-10-17-000051';
const SCREENS = [
  {
    name: 'returns',
    hash: '#/dev/returns-proof?state=LookupEmpty',
    ready: 'form.v5-returns-lookup',
    input: 'input.v5-manager-input--code',
    full: FULL_RETURNS,
    short: '48',
    found: 'text=اختر الأصناف المرتجعة',
  },
  {
    name: 'void',
    hash: '#/dev/void-proof?state=Lookup',
    ready: '#void-sale-number',
    input: '#void-sale-number',
    full: FULL_VOID,
    short: '51',
    found: '[data-testid="void-sale"]',
  },
];
const SCENARIOS = [
  { name: 'lookup', type: null },
  { name: 'full-number', type: 'full' },
  ...(before
    ? []
    : [
        { name: 'short-number', type: 'short' },
        { name: 'ambiguous', type: '12', ready: 'text=يوجد أكثر من بيع بهذا الرقم اليوم' },
      ]),
];

function measure(page) {
  return page.evaluate(() => {
    const text = (el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    const small = Array.from(document.querySelectorAll('button, input, a[href]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.height < 44 || r.width < 44) && !(el.type === 'checkbox');
      })
      .map((el) => ({ tag: el.tagName.toLowerCase(), text: text(el), rect: rect(el) }));
    return {
      headings: Array.from(document.querySelectorAll('h1, h2')).map(text),
      recentRows: Array.from(document.querySelectorAll('.v5-recent-row')).map((el) => ({
        text: text(el),
        rect: rect(el),
      })),
      hint: Array.from(document.querySelectorAll('.v5-returns-field-hint, .v5-void-lookup .v5-void-hint')).map(text),
      alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(text),
      targetsUnder44: small,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

async function capture(browser, viewport, mode, screen, scenario, n) {
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
  await page.goto(`${base}/?r=${String(n)}${screen.hash}`);
  await page.waitForSelector(screen.ready);
  await page.waitForTimeout(500);
  if (scenario.type !== null) {
    const typed = scenario.type === 'full' ? screen.full : scenario.type === 'short' ? screen.short : scenario.type;
    await page.fill(screen.input, typed);
    await page.press(screen.input, 'Enter');
    await page.waitForSelector(scenario.ready ?? screen.found);
    await page.waitForTimeout(400);
  }
  const size = `${String(viewport.width)}x${String(viewport.height)}`;
  const file = `rt1192-${screen.name}-${scenario.name}-${size}-${mode.name}-${label}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  const result = { file, screen: screen.name, scenario: scenario.name, viewport: size, mode: mode.name, errors, ...(await measure(page)) };
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
      for (const screen of SCREENS)
        for (const scenario of SCENARIOS)
          results.push(await capture(browser, viewport, mode, screen, scenario, (n += 1)));
  await browser.close();
  fs.writeFileSync(path.join(outDir, `rt1192-${label}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.errors.length > 0);
  console.log(`${String(results.length)} captures, ${String(failed.length)} with page errors`);
  if (failed.length > 0) process.exitCode = 1;
})();
