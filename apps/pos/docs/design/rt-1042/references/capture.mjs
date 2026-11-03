// RT-1090 (S1): renders the B-lite sign-in reference images from the Direction B renderer in
// ../prototype.html, with ./b-lite.css on top. Docs tooling only; it is not part of the POS build.
//
// Run from apps/pos (it uses the POS devDependency Playwright and its Chromium):
//   node docs/design/rt-1042/references/capture.mjs
// Run it on Windows: the frames use the Dubai font that ships with Windows 10/11, so another OS
// renders a fallback face and the PNGs will not match. The overflow check is horizontal only.
//
// Each image is the `.scr` element at zoom 1, so the PNG has the frame's real pixel size.
// Forced colours use the prototype's `.fc` simulation. A real Windows contrast-theme capture is
// packaged-app evidence for S8 (RT-1097).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const prototypeUrl = pathToFileURL(join(here, '..', 'prototype.html')).href;
const css = await readFile(join(here, 'b-lite.css'), 'utf8');

const SIZES = [
  [1920, 1080],
  [1280, 800],
  [1024, 768],
  [1024, 600],
];
const base = { roster: 'ready', names: 'six', mode: 'cashier', logo: 'none' };
const picked = { ...base, picked: 1, pin: 4, feedback: null };
const SHOTS = [
  ...SIZES.map(([w, h]) => ({ name: `signin-picked-${w}x${h}`, state: { ...picked, vp: { w, h } } })),
  { name: 'signin-logo-card-1920x1080', state: { ...picked, logo: 'card', vp: { w: 1920, h: 1080 } } },
  {
    name: 'signin-refusal-unresolved-payment-1024x600',
    state: { ...base, picked: 1, pin: 0, feedback: 'terminal_has_unresolved_payment', vp: { w: 1024, h: 600 } },
  },
];
const ALLOWED_RADII = new Set(['0px', '8px', '12px', '16px', '9999px']);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1200 } });
// OD-3: no display face. Block the prototype's Google Fonts request, so only Dubai can render.
await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
await page.goto(prototypeUrl);
await page.addStyleTag({ content: css });

const failures = [];
for (const fc of [false, true]) {
  for (const shot of SHOTS) {
    const file = `${shot.name}${fc ? '-forced-colors' : ''}.png`;
    const report = await page.evaluate(
      ({ state, fc }) => {
        const host = document.getElementById('host');
        host.innerHTML = window.RT1042.render('B', { ...state, fc });
        const scr = host.querySelector('.scr');
        scr.classList.add('bl');
        // OD-8: the band names the product «Retail Tower».
        scr.querySelectorAll('.pn').forEach((el) => (el.textContent = 'Retail Tower'));
        const cs = (sel) => [...scr.querySelectorAll(sel)].map((el) => getComputedStyle(el));
        const orn = scr.querySelector('.orn');
        const overflow = [...scr.querySelectorAll('*')].filter(
          (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'hidden',
        ).length;
        return {
          // An unavailable commit is recessed (DESIGN.md Buttons), so only an available one is checked.
          commit: cs('.commit:not([aria-disabled="true"])').map((s) => s.backgroundColor),
          fonts: [...scr.querySelectorAll('*')].map((el) => getComputedStyle(el).fontFamily).filter((f) => /readex/i.test(f)),
          shadows: cs('.panel, .dock, .who, .key, .commit').map((s) => s.boxShadow).filter((v) => v !== 'none'),
          radii: cs('.panel, .who, .key, .dots, .sec, .commit, .in, .pm').flatMap((s) => [s.borderTopLeftRadius, s.borderTopRightRadius]),
          ornament: orn ? getComputedStyle(orn).display : null,
          ornamentOpacity: orn ? [...orn.querySelectorAll('[opacity],[fill-opacity],[stroke-opacity]')].map((n) => Math.max(...['opacity', 'fill-opacity', 'stroke-opacity'].map((a) => +(n.getAttribute(a) ?? 0)))) : [],
          wordmark: [...scr.querySelectorAll('.pn')].map((el) => el.textContent),
          overflow,
        };
      },
      { state: shot.state, fc },
    );
    const problems = [];
    if (!fc && report.commit.some((c) => c !== 'rgb(15, 118, 110)')) problems.push(`commit ${report.commit}`);
    if (report.fonts.length) problems.push('Readex Pro in a font stack');
    if (report.shadows.length) problems.push(`shadows ${report.shadows}`);
    const bad = report.radii.filter((r) => !ALLOWED_RADII.has(r));
    if (bad.length) problems.push(`radii ${[...new Set(bad)]}`);
    if (report.ornamentOpacity.some((o) => o > 0.4)) problems.push(`ornament opacity ${report.ornamentOpacity}`);
    if (fc && report.ornament && report.ornament !== 'none') problems.push('ornament shown under forced colours');
    if (report.wordmark.some((t) => t !== 'Retail Tower')) problems.push(`wordmark ${report.wordmark}`);
    if (report.overflow) problems.push(`${report.overflow} clipped elements`);
    await page.locator('#host .scr').screenshot({ path: join(here, file) });
    console.log(`${problems.length ? '[FAIL]' : '[OK]'} ${file}${problems.length ? ' - ' + problems.join('; ') : ''}`);
    if (problems.length) failures.push(file);
  }
}
await browser.close();
if (failures.length) process.exit(1);
