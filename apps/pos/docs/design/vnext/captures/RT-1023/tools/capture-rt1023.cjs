// RT-1023 — capture the slim-rail status footer from the DEV harness (#/dev/status-proof) on the
// live sale (/app/cart) and the dashboard (/app/dashboard), at 1024×768 and 1280×800, light and
// forced colours, as the manager (the most nav links, so the tightest footer). Each capture runs
// axe (light) and the fit checks: the footer is in view, inside the rail, the rail does not
// scroll, nothing is under 12px, and each visible short label fits the rail without clipping.
// Derived from RT-604's capture-rt604.cjs; the browser is Playwright's own unless CHROMIUM names one.
// Usage (apps/pos, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-1023/tools/capture-rt1023.cjs <outDir> <prefix> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, prefix = 'rt1023', base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };
const STATES = (process.env.STATES || 'Connected,Checking,Offline,Attention,PrinterFailed,AllRows').split(',');
const ROUTES = { sale: '/app/cart', dashboard: '/app/dashboard' };
// The baseline (before RT-1023) has no labels: run it with EXPECT_LABELS=0.
const EXPECT_LABELS = process.env.EXPECT_LABELS !== '0';

/** Why a capture fails its checks; empty when it passes. */
function failures(c, axe, errors) {
  const out = [];
  if (axe.length > 0) out.push(`axe: ${axe.join(', ')}`);
  if (!c.inView) out.push('footer out of view');
  if (!c.inNav) out.push('footer outside the rail');
  if (c.navScrolls) out.push('rail scrolls');
  if (c.small > 0) out.push(`${c.small} text node(s) under 12px`);
  if (c.overflowX) out.push('horizontal overflow');
  if (errors.length > 0) out.push(`page errors: ${errors.join(' | ')}`);
  if (c.rows.length === 0) out.push('no status rows');
  for (const r of c.rows) {
    if (r.row === 'printer' && r.height < 44) out.push(`printer row ${r.height}px < 44px`);
    if (!EXPECT_LABELS) continue;
    if (r.label === null) out.push(`${r.row}: no visible label`);
    else if (r.labelPx !== 12 || r.labelClipped || !r.labelInRow) out.push(`${r.row}: label does not fit`);
  }
  return out;
}

function checks() {
  const ind = document.querySelector('[data-testid=v5-status-indicator]');
  const nav = document.querySelector('.v5-frame__nav');
  const r = ind ? ind.getBoundingClientRect() : null;
  const n = nav ? nav.getBoundingClientRect() : null;
  const rows = ind ? [...ind.querySelectorAll('[data-row]')].map((el) => {
    const label = el.querySelector('.v5-status__label');
    const lb = label ? label.getBoundingClientRect() : null;
    const shown = !!lb && lb.width > 1;
    return {
      row: el.dataset.row,
      tone: el.dataset.tone,
      text: el.textContent.trim(),
      label: shown ? label.textContent : null,
      labelPx: shown ? parseFloat(getComputedStyle(label).fontSize) : null,
      labelClipped: shown ? label.scrollWidth > label.clientWidth + 0.5 : null,
      labelInRow: shown ? lb.left >= el.getBoundingClientRect().left - 0.5
        && lb.right <= el.getBoundingClientRect().right + 0.5 : null,
      height: Math.round(el.getBoundingClientRect().height),
    };
  }) : [];
  const inView = !!r && r.width > 0 && r.bottom <= window.innerHeight + 0.5 && r.top >= 0;
  const inNav = !!r && !!n && r.left >= n.left - 0.5 && r.right <= n.right + 0.5;
  const navScrolls = !!nav && nav.scrollHeight > nav.clientHeight + 1;
  const small = ind ? [...ind.querySelectorAll('*')].filter((el) => {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && parseFloat(getComputedStyle(el).fontSize) < 12;
  }).length : 0;
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  return { rows, inView, inNav, navScrolls, small, overflowX };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const log = [];
  for (const state of STATES) {
    for (const [where, route] of Object.entries(ROUTES)) {
      for (const [w, h] of Object.entries(SIZES)) {
        for (const mode of ['light', 'forced']) {
          const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
          if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(`${base}/#/dev/status-proof?state=${state}&path=${route}&role=manager`);
          await page.waitForSelector('[data-testid=v5-status-indicator]');
          await page.waitForTimeout(1300);
          const file = `${prefix}-${state}-${where}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
          await page.screenshot({ path: path.join(outDir, file) });
          let axe = [];
          if (mode === 'light') {
            await page.addScriptTag({ path: AXE });
            axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
              .violations.map((v) => `${v.id}(${v.nodes.length})`));
          }
          const c = await page.evaluate(checks);
          const failed = failures(c, axe, errors);
          log.push({ state, where, width: +w, mode, file, axe, ...c, errors, failed });
          console.log(state, where, w, mode, JSON.stringify({ axe, labels: c.rows.map((x) => x.label), v: c.inView, n: c.inNav, sc: c.navScrolls, s: c.small, x: c.overflowX, clip: c.rows.some((x) => x.labelClipped), e: errors }));
          await page.close();
        }
      }
    }
  }
  fs.writeFileSync(path.join(outDir, `${prefix}-capture-log.json`), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  const bad = log.filter((x) => x.failed.length > 0);
  for (const x of bad) console.error('FAIL', x.file, x.failed.join('; '));
  console.log(`${log.length - bad.length}/${log.length} captures pass`);
  if (bad.length > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
