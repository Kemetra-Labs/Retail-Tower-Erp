// RT-1118: writes index.md (route → ticket → files) for the capture artifact and
// checks every screen has its full set: per locale, each variant at 1280 and 390,
// forced colours at 1280 and the axe JSON. Exits 1 when a file is missing.
// Usage: node tests/captures/build-index.mjs <capture dir>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: build-index.mjs <capture dir>");
  process.exit(2);
}

const files = new Set(readdirSync(dir));
const metas = [...files]
  .filter((f) => f.endsWith("__meta.json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

const expectedFor = (m) => {
  const stem = `${m.ticket}__${m.slug}__${m.locale}`;
  const out = [];
  for (const v of m.variants) {
    if (v === "forced-colors") out.push(`${stem}__1280__forced-colors.png`);
    else for (const w of [1280, 390]) out.push(`${stem}__${w}__${v}.png`);
  }
  out.push(`${stem}__axe.json`);
  return out;
};

const byTicket = new Map();
const missing = [];
for (const m of metas.sort((a, b) =>
  `${a.ticket}${a.slug}`.localeCompare(`${b.ticket}${b.slug}`),
)) {
  const expected = expectedFor(m);
  for (const f of expected) if (!files.has(f)) missing.push(f);
  const axe = files.has(`${m.ticket}__${m.slug}__${m.locale}__axe.json`)
    ? JSON.parse(readFileSync(join(dir, `${m.ticket}__${m.slug}__${m.locale}__axe.json`), "utf8"))
    : null;
  const bannerFile = `${m.ticket}__${m.slug}__${m.locale}__banner.json`;
  const banner = files.has(bannerFile)
    ? JSON.parse(readFileSync(join(dir, bannerFile), "utf8"))
    : null;
  const screens = byTicket.get(m.ticket) ?? new Map();
  const entry = screens.get(m.slug) ?? { route: m.route, denseRoute: m.denseRoute, locales: [] };
  entry.locales.push({
    locale: m.locale,
    files: expected.filter((f) => files.has(f)),
    axe,
    banner,
  });
  screens.set(m.slug, entry);
  byTicket.set(m.ticket, screens);
}

const lines = [
  "# Admin Console v4.0 evidence captures (RT-1118)",
  "",
  "Light theme, reduced motion, mocked Backend-Core. Each screen in both locales at",
  "1280x800 and 390 wide: `normal`, `banner` (primary read fails: banner under the band),",
  "`long-tenant` (long Arabic tenant name), `dense` (a full table), plus",
  "`forced-colors` at 1280 (C2) and the WCAG 2.1 A/AA axe results (`axe.json`).",
  "File name: `<ticket>__<screen>__<locale>__<width>__<variant>.png`.",
  "",
  "`Error state shown` counts, in the banner variant at 1280/390, the shared Banner (`.rtc-alert`)",
  "and, on a screen that reports a failed read inside its own panels (the Overview), those panel",
  "errors too (`.glance-error`, one per failed panel). It is recorded, not asserted (a capture",
  "fails only when a route crashes).",
  "",
  "| Ticket | Screen | Route | Files | axe violations (ar / en) | Error state shown (ar / en) |",
  "| --- | --- | --- | --- | --- | --- |",
];
const counts = [];
for (const [ticket, screens] of [...byTicket].sort()) {
  let n = 0;
  for (const [slug, e] of screens) {
    const count = e.locales.reduce((a, l) => a + l.files.length, 0);
    n += count;
    const axe = ["ar", "en"]
      .map((loc) => e.locales.find((l) => l.locale === loc)?.axe?.violationCount ?? "n/a")
      .join(" / ");
    const shown = ["ar", "en"]
      .map((loc) => {
        const b = e.locales.find((l) => l.locale === loc)?.banner;
        return b ? `${b[1280] ?? "?"}/${b[390] ?? "?"}` : "n/a";
      })
      .join(" / ");
    const route = e.denseRoute ? `\`${e.route}\` (dense: \`${e.denseRoute}\`)` : `\`${e.route}\``;
    lines.push(`| ${ticket} | ${slug} | ${route} | ${count} | ${axe} | ${shown} |`);
  }
  counts.push(`- ${ticket}: ${n} files`);
}
lines.push("", "## Files per ticket", "", ...counts, "");
for (const [ticket, screens] of [...byTicket].sort()) {
  lines.push(`## ${ticket}`, "");
  for (const [slug, e] of screens) {
    lines.push(`### ${slug} — \`${e.route}\``, "");
    for (const l of e.locales) for (const f of l.files) lines.push(`- [${f}](${f})`);
    lines.push("");
  }
}
if (missing.length) lines.push("## Missing", "", ...missing.map((f) => `- ${f}`), "");

writeFileSync(join(dir, "index.md"), lines.join("\n"));
console.log(counts.join("\n"));
if (metas.length === 0 || missing.length) {
  console.error(`missing ${missing.length} file(s); screens found: ${metas.length}`);
  for (const f of missing) console.error(`  ${f}`);
  process.exit(1);
}
