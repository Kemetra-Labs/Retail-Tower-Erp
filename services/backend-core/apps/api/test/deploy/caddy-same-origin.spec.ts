/**
 * RT-336 — the public Caddy edge serves the Admin Console SPA and the API on
 * one HTTPS origin (owner decision 2026-10-09, RT-315): `/api` and `/api/*`
 * reach the API untouched; everything else is the pinned Console bundle.
 * Runtime behavior is proven by `deploy/console-smoke.sh` against a running
 * Caddy; these checks keep the template from drifting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const caddyfile = readFileSync(resolve(repoRoot, "Caddyfile"), "utf8");
const compose = readFileSync(resolve(repoRoot, "docker-compose.prod.yml"), "utf8");
const smoke = readFileSync(resolve(repoRoot, "deploy", "console-smoke.sh"), "utf8");

/** The Console CSP before RT-1305; the pilot variant may only append a frame-src to it. */
const BASE_CSP =
  "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/** The `{ ... }` body that follows the first occurrence of `opener`. */
function blockAfter(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`"${opener}" not found`);
  const open = source.indexOf("{", start + opener.length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced block after "${opener}"`);
}

describe("Caddyfile same-origin gateway", () => {
  const site = blockAfter(caddyfile, "{$CADDY_SITE_ADDRESS:api.example.test} {");

  it("takes the public hostname from the host environment, keeping the placeholder default", () => {
    expect(caddyfile).toContain("{$CADDY_SITE_ADDRESS:api.example.test} {");
  });

  it("routes /api and /api/* to the API before any Console handling", () => {
    expect(site).toContain("@api path /api /api/*");
    const api = blockAfter(site, "handle @api {");
    expect(api.trim()).toBe("reverse_proxy api:3000");
    expect(site.indexOf("handle @api {")).toBeLessThan(site.indexOf("handle {"));
  });

  it("drops only successful liveness probes from the access log (RT-616)", () => {
    expect(site).toContain("@health_live path /api/v1/health/live");
    const live = blockAfter(site, "handle @health_live {");
    const proxy = blockAfter(live, "reverse_proxy api:3000 {");
    expect(proxy).toContain("@probe_ok status 2xx 3xx");
    const ok = blockAfter(proxy, "handle_response @probe_ok {");
    expect(ok.trim().split(/\s+/)).toEqual(["log_skip", "copy_response"]);
    // Matched before the general /api handler; nothing else in the site skips logs.
    expect(site.indexOf("handle @health_live {")).toBeLessThan(site.indexOf("handle @api {"));
    expect(site.match(/log_skip|skip_log/g)).toEqual(["log_skip"]);
    expect(blockAfter(site, "\tlog {")).toContain("output stdout");
  });

  it("serves the current Console release with an SPA fallback to index.html", () => {
    const consoleBlock = blockAfter(site, "handle {");
    expect(consoleBlock).toContain("root * /srv/console/current");
    const pages = blockAfter(consoleBlock, "handle {");
    expect(pages).toContain("try_files {path} /index.html");
    expect(pages).toContain("file_server");
  });

  it("caches only hashed assets as immutable and never falls back to index.html for them", () => {
    const consoleBlock = blockAfter(site, "handle {");
    const assets = blockAfter(consoleBlock, "handle /assets/* {");
    expect(assets).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(assets).toContain("file_server");
    expect(assets).not.toContain("try_files");

    const pages = blockAfter(consoleBlock, "handle {");
    expect(pages).toContain('Cache-Control "no-cache"');
  });

  it("serves the POS lab feed only when POS_FEED_DIR is set, as plain static files (RT-1115)", () => {
    const matcher = blockAfter(site, "@pos_feed {");
    expect(matcher).toContain("path /pos-feed/*");
    expect(matcher).toContain('expression `{env.POS_FEED_DIR} != ""`');

    const feed = blockAfter(site, "handle @pos_feed {");
    expect(feed).toContain("uri strip_prefix /pos-feed");
    expect(feed).toContain("root * /srv/pos-feed");
    expect(feed).toContain('Cache-Control "no-cache"');
    expect(feed).toMatch(/^\s*file_server\s*$/m);
    // No SPA fallback and no listing: a missing feed file is a 404, never the Console's index.html.
    expect(feed).not.toContain("try_files");
    expect(feed).not.toContain("browse");
    // Matched after the API and before the Console.
    expect(site.indexOf("handle @api {")).toBeLessThan(site.indexOf("handle @pos_feed {"));
    expect(site.indexOf("handle @pos_feed {")).toBeLessThan(site.indexOf("handle {"));
  });

  it("sends the exact Console CSP, with frame-src only for a valid pilot bucket and region (RT-1305)", () => {
    const consoleBlock = blockAfter(site, "handle {");
    const pilotFrameSrc =
      "https://{env.POS_PILOT_RELEASE_BUCKET}.s3.{env.POS_PILOT_RELEASE_S3_REGION}.amazonaws.com";
    const valid =
      '{env.POS_PILOT_RELEASE_BUCKET}.matches("^[a-z0-9][a-z0-9-]*[a-z0-9]$") && ' +
      '{env.POS_PILOT_RELEASE_S3_REGION}.matches("^[a-z][a-z](-[a-z]+)+-[0-9]+$")';

    // Two mutually exclusive matchers on the same check, so exactly one CSP is ever sent.
    expect(consoleBlock).toContain(`@pilot_frame expression \`${valid}\``);
    expect(consoleBlock).toContain(`@no_pilot_frame not expression \`${valid}\``);

    const csps = [...consoleBlock.matchAll(/^\s*header (@\w+ )?Content-Security-Policy "([^"]*)"\s*$/gm)].map(
      (m) => [m[1]?.trim(), m[2]],
    );
    expect(csps).toEqual([
      ["@pilot_frame", `${BASE_CSP}; frame-src ${pilotFrameSrc}`],
      ["@no_pilot_frame", BASE_CSP],
    ]);
    // No other line sets a CSP, and no real bucket hostname is committed.
    expect(consoleBlock.match(/Content-Security-Policy/g)).toHaveLength(2);
    const directives = caddyfile
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(directives.match(/frame-src/g)).toHaveLength(1);
    expect(caddyfile).not.toMatch(/https:\/\/[a-z0-9-]+\.s3\./);
  });

  it("smoke-checks the live CSP as the exact base string or the base plus one pilot S3 frame-src (RT-1305)", () => {
    expect(smoke).toContain(`csp_base="${BASE_CSP}"`);
    expect(smoke).toContain(
      "csp_pilot_re='^; frame-src https://[a-z0-9][a-z0-9-]*[a-z0-9]\\.s3\\.[a-z][a-z](-[a-z]+)+-[0-9]+\\.amazonaws\\.com$'",
    );
    expect(smoke).toContain(`check "/ sends the exact Console CSP" csp_ok "$(header root content-security-policy)"`);
    // Browsers enforce every CSP they get; a second one would silently block the frame.
    expect(smoke).toContain(
      `check "/ sends exactly one CSP" is "$(grep -ci '^content-security-policy:' "$work/root.hdr")" 1`,
    );
  });

  it("sends the other security headers on Console responses only", () => {
    const consoleBlock = blockAfter(site, "handle {");
    expect(consoleBlock).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(consoleBlock).toContain('X-Content-Type-Options "nosniff"');
    expect(consoleBlock).toContain('Referrer-Policy "strict-origin-when-cross-origin"');

    const api = blockAfter(site, "handle @api {");
    expect(api).not.toContain("header");
  });
});

describe("production compose for the same-origin gateway", () => {
  const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
  const caddy = compose.slice(compose.indexOf("  caddy:"), compose.indexOf("\nnetworks:"));

  it("adds no new service, container or VM (beyond the opt-in datadog profile)", () => {
    const names = [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
    expect(names).toEqual(["redis", "migrate", "api", "worker", "datadog-agent", "caddy"]);
    // Spec 037: the only addition is the Datadog Agent, and it must stay opt-in
    // so a plain `docker compose up` still starts exactly the RT-336 stack.
    const agent = services.slice(services.indexOf("  datadog-agent:"), services.indexOf("  caddy:"));
    expect(agent).toContain('profiles: ["datadog"]');
  });

  it("mounts the pinned Console releases directory read-only and requires it to be set", () => {
    expect(caddy).toContain(
      "${CONSOLE_RELEASES_DIR:?CONSOLE_RELEASES_DIR required (pinned Admin Console releases + current symlink)}:/srv/console:ro",
    );
  });

  it("mounts the POS lab feed read-only, and an empty named volume when it is unset (RT-1115)", () => {
    expect(caddy).toContain("POS_FEED_DIR: ${POS_FEED_DIR:-}");
    expect(caddy).toContain("${POS_FEED_DIR:-dp2_pos_feed_off}:/srv/pos-feed/lab:ro");
    const volumes = compose.slice(compose.indexOf("\nvolumes:"));
    expect(volumes).toMatch(/^ {2}dp2_pos_feed_off:\s*$/m);
  });

  it("passes the pilot bucket and region to Caddy for the CSP frame-src, optional and never the S3 key (RT-1305)", () => {
    expect(caddy).toContain("POS_PILOT_RELEASE_BUCKET: ${POS_PILOT_RELEASE_BUCKET:-}");
    expect(caddy).toContain("POS_PILOT_RELEASE_S3_REGION: ${POS_PILOT_RELEASE_S3_REGION:-}");
    expect(caddy).not.toContain("POS_PILOT_RELEASE_S3_ACCESS_KEY_ID");
    expect(caddy).not.toContain("POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY");
  });

  it("passes the public hostname to Caddy without hard-coding a real domain", () => {
    expect(caddy).toContain("CADDY_SITE_ADDRESS: ${CADDY_SITE_ADDRESS:-api.example.test}");
  });

  it("keeps the API behind exactly one trusted proxy hop with CORS off", () => {
    const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  worker:"));
    expect(api).toContain('TRUST_PROXY: "1"');
    expect(api).not.toContain("ALLOWED_ORIGINS");
  });
});
