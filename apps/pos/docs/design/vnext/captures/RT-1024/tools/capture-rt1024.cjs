// RT-1024 — capture the nav rail (brand mark + links + status footer) from the DEV harness
// (#/dev/status-proof) on the live sale (/app/cart) and the dashboard (/app/dashboard), at 1024×768
// and 1280×800, light and forced colours, as the manager (the longest rail). Each capture records the
// brand mark's computed colours and contrast, and every element inside the rail that paints a filled
// Tower Teal background (AC4: only the selected nav state may). Derived from capture-rt1023.cjs.
// Usage (apps/pos, with `npm run dev:vite` running):
//   CHROMIUM=<chrome.exe> node docs/design/vnext/captures/RT-1024/tools/capture-rt1024.cjs <outDir> <prefix> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [outDir, prefix = 'rt1024', base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };
const ROUTES = { sale: '/app/cart', dashboard: '/app/dashboard' };
const TEAL = 'rgb(15, 118, 110)';

function measure(teal) {
  const nav = document.querySelector('.v5-frame__nav');
  const mark = document.querySelector('.v5-frame__brand-mark');
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => {
      const c = +v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const ms = mark ? getComputedStyle(mark) : null;
  const filled = nav ? [...nav.querySelectorAll('*')].filter((el) => {
    const s = getComputedStyle(el);
    return s.backgroundColor === teal && el.getBoundingClientRect().width > 1;
  }).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`) : [];
  return {
    mark: ms && {
      background: ms.backgroundColor, color: ms.color, border: ms.borderTopWidth + ' ' + ms.borderTopStyle,
      width: mark.getBoundingClientRect().width, height: mark.getBoundingClientRect().height,
      radius: ms.borderTopLeftRadius,
      contrast: ms.backgroundColor.startsWith('rgba(0, 0, 0, 0)') ? null : Math.round(ratio(ms.color, ms.backgroundColor) * 100) / 100,
    },
    filledTeal: filled,
  };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const log = [];
  for (const [where, route] of Object.entries(ROUTES)) {
    for (const [w, h] of Object.entries(SIZES)) {
      for (const mode of ['light', 'forced']) {
        const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
        if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/#/dev/status-proof?state=Connected&path=${route}&role=manager`);
        await page.waitForSelector('.v5-frame__brand-mark');
        await page.waitForTimeout(1300);
        const file = `${prefix}-${where}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        const m = await page.evaluate(measure, TEAL);
        log.push({ where, width: +w, mode, file, ...m, errors });
        console.log(where, w, mode, JSON.stringify({ ...m, errors }));
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, `${prefix}-capture-log.json`), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
