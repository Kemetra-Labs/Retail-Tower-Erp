// RT-1022 — before/after captures of the void screen (journal list and the cancel dialog), the manager
// home and the voucher format error at 1024×768, light and forced-colors, with the computed values the
// slice changes (focus ring, tile border, void gaps, voucher-error margin) written to a log.
// The global text-input focus is measured on a bare `<input type="text">` mounted the same way.
// The voucher error is not reachable in a DEV harness (the voucher tender is policy-hidden), so the
// capture mounts the production `<output class="voucher-error">` into the manager home, which loads
// the same stylesheet.
// Usage (apps/pos, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-1022/tools/capture-rt1022.cjs <outDir> <label> [baseUrl]
// Set CHROME_PATH to use a specific browser; by default the installed Chrome channel is used.
const path = require('path');
const fs = require('fs');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd()] }));
const [outDir, label, base = 'http://localhost:5173'] = process.argv.slice(2);
const VIEWPORT = { width: 1024, height: 768 };
const SALE = 'TERM-01-2026-10-17-000051';
// The baseline copy (em dash, Arabic-Indic digit) before the slice, the new copy after.
const VOUCHER_MESSAGE =
  label === 'before'
    ? 'رمز القسيمة غير صالح — يجب ألا يقل عن ٣ أحرف.'
    : 'رمز القسيمة غير صالح: يجب ألا يقل عن 3 أحرف.';
const MODES = [
  { name: 'light', forcedColors: 'none' },
  { name: 'forced', forcedColors: 'active' },
];

const px = (el, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));

async function measureVoid(page) {
  return page.evaluate((pick) => {
    const q = (s) => document.querySelector(s);
    const f = (el, props) => (el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])) : null);
    return {
      field: f(q('.v5-void-field'), ['rowGap']),
      facts: f(q('.v5-void-facts'), ['rowGap', 'columnGap']),
      row: f(q('.v5-void-row'), ['rowGap', 'columnGap']),
      state: f(q('.v5-void-state'), ['columnGap', 'paddingLeft', 'paddingRight']),
    };
  });
}

async function shot(page, name) {
  const file = `rt1022-${name}-${label}-1024x768.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  return file;
}

async function captureMode(browser, mode) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, bypassCSP: true, timezoneId: 'Africa/Cairo', colorScheme: 'light', forcedColors: mode.forcedColors });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const out = { label, mode: mode.name, errors };

  await page.goto(`${base}/#/dev/void-proof?state=Journal`);
  await page.waitForSelector('.v5-void');
  await page.waitForTimeout(500);
  out.voidJournal = { file: await shot(page, `void-journal-${mode.name}`), ...(await measureVoid(page)) };

  const field = page.getByLabel('رقم البيع', { exact: true });
  await field.fill(SALE);
  await page.getByRole('button', { name: 'بحث', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'إلغاء هذا البيع' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.waitForTimeout(300);
  const pin = dialog.getByLabel('الرقم السري للمدير');
  await pin.focus();
  await page.waitForTimeout(400);
  out.voidDialog = {
    file: await shot(page, `void-dialog-pin-focus-${mode.name}`),
    pin: await pin.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset, boxShadow: s.boxShadow, transition: s.transitionProperty };
    }),
    ...(await measureVoid(page)),
  };

  await page.goto(`${base}/#/dev/void-proof?state=RefServer&from=dashboard`);
  await page.waitForSelector('.v5-manager-tile');
  await page.waitForTimeout(500);
  out.managerHome = {
    file: await shot(page, `manager-home-${mode.name}`),
    tile: await page.$eval('.v5-manager-tile', (el) => {
      const s = getComputedStyle(el);
      return { borderTopColor: s.borderTopColor, borderTopWidth: s.borderTopWidth };
    }),
    tileBorderStrongToken: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-border-strong').trim()),
  };

  await page.evaluate((message) => {
    const host = document.querySelector('.v5-manager-tile').parentElement;
    const box = document.createElement('div');
    box.style.cssText = 'padding:16px;background:var(--color-surface)';
    box.innerHTML =
      '<input id="rt1022-input" type="text" style="inline-size:320px" value="AB"><br><output class="voucher-error">' + message + '</output>';
    host.replaceChildren(box);
  }, VOUCHER_MESSAGE);
  await page.waitForTimeout(200);
  // A bare text input outside `.v5-frame` takes the global input rule (not a v5 frame rule).
  await page.focus('#rt1022-input');
  await page.waitForTimeout(400);
  out.globalTextInput = await page.$eval('#rt1022-input', (el) => {
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset, boxShadow: s.boxShadow, transitionProperty: s.transitionProperty, borderTopColor: s.borderTopColor };
  });
  out.voucherError = {
    file: await shot(page, `voucher-error-${mode.name}`),
    text: await page.$eval('.voucher-error', (el) => el.textContent),
    margin: await page.$eval('.voucher-error', (el) => {
      const s = getComputedStyle(el);
      return { top: s.marginTop, right: s.marginRight, bottom: s.marginBottom, left: s.marginLeft };
    }),
  };
  await ctx.close();
  return out;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const entries = [];
  for (const mode of MODES) entries.push(await captureMode(browser, mode));
  await browser.close();
  console.log(JSON.stringify(entries, null, 2));
  const logPath = path.join(outDir, 'rt1022-capture-log.json');
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];
  fs.writeFileSync(logPath, JSON.stringify([...log.filter((e) => e.label !== label), ...entries], null, 2) + '\n');
})();
