/**
 * RT-1276 — the Datadog site default is EU1 everywhere, and a recreated agent
 * or a monitoring-as-code apply cannot silently fall back to another site.
 *
 * Lab telemetry lives in the Datadog EU1 org (`datadoghq.eu`). A default that
 * named any other site would send an agent recreated without an explicit
 * `DD_SITE`, or an `apply.mjs` run, to an org that receives nothing. This spec
 * pins the three places that carry the default:
 *   - `deploy/datadog/apply.mjs`: the `process.env.DD_SITE ||` fallback;
 *   - `docker-compose.prod.yml`: the `${DD_SITE:-...}` default of the agent;
 *   - `deploy/prod.env.example`: the documented value;
 * and that an explicit `DD_SITE` still wins (the override stays a deliberate,
 * per-environment choice).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serviceRoot = resolve(__dirname, "..", "..", "..", "..");
const EU_SITE = "datadoghq.eu";

function read(...segments: string[]): string {
  return readFileSync(resolve(serviceRoot, ...segments), "utf8");
}

/** Every line that assigns a `DD_SITE` default or value, so a stray site value cannot hide on a line the other tests skip. */
function ddSiteLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /DD_SITE/.test(line) && !/^\s*(#|\/\/)/.test(line));
}

describe("RT-1276 Datadog site default is EU1", () => {
  describe("deploy/datadog/apply.mjs", () => {
    const source = read("deploy", "datadog", "apply.mjs");

    it("falls back to datadoghq.eu only when DD_SITE is unset", () => {
      const fallback = /const site = process\.env\.DD_SITE \|\| "([^"]+)";/.exec(source);
      expect(fallback).not.toBeNull();
      expect(fallback![1]).toBe(EU_SITE);
    });

    it("documents the EU1 default in its env header", () => {
      const header = /^\/\/\s+DD_SITE\s+default (\S+)/m.exec(source);
      expect(header).not.toBeNull();
      expect(header![1]).toBe(EU_SITE);
    });

    it("keeps the explicit override: the env value is read before the fallback", () => {
      // `||` (not a hard-coded assignment) is what lets an explicit DD_SITE keep winning.
      expect(source).toMatch(/process\.env\.DD_SITE \|\|/);
    });
  });

  describe("docker-compose.prod.yml datadog agent", () => {
    const compose = read("docker-compose.prod.yml");

    it("defaults DD_SITE to datadoghq.eu and still reads the DD_SITE override", () => {
      const lines = ddSiteLines(compose).filter((line) => /^\s*DD_SITE:/.test(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/\$\{DD_SITE:-datadoghq\.eu\}/);
    });
  });

  describe("deploy/prod.env.example", () => {
    const example = read("deploy", "prod.env.example");

    it("documents DD_SITE as datadoghq.eu", () => {
      const lines = ddSiteLines(example).filter((line) => /^DD_SITE=/.test(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(`DD_SITE="${EU_SITE}"`);
    });

    it("carries no secret value for the Datadog keys", () => {
      expect(example).toMatch(/^DD_API_KEY=""$/m);
    });
  });

  describe("no other site is the default", () => {
    const files: Array<[string, string[]]> = [
      ["deploy/datadog/apply.mjs", ["deploy", "datadog", "apply.mjs"]],
      ["docker-compose.prod.yml", ["docker-compose.prod.yml"]],
      ["deploy/prod.env.example", ["deploy", "prod.env.example"]],
    ];

    it.each(files)("%s names no site other than datadoghq.eu", (_name, segments) => {
      for (const line of ddSiteLines(read(...segments))) {
        for (const site of line.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.datadoghq\.[a-z]+|datadoghq\.[a-z]+/gi) ?? []) {
          expect(site).toBe(EU_SITE);
        }
      }
    });
  });
});
