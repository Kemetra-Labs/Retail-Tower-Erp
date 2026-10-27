/**
 * RT-533 — the digest-pinned compose override and the bundle allowlist of the
 * image release. Static checks only (no bash, no Docker): they keep the safety
 * properties of the release path from drifting. The product workflow
 * (release-images.yml) and its checks were retired in RT-878; the monorepo's
 * image release is the root release-backend-core.yml (RT-871, RT-717).
 */
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import * as yaml from "js-yaml";
import { routineGrantScripts } from "../_helpers/domain-grant-scripts";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
// Normalise CRLF so checkouts with core.autocrlf behave like CI.
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

const RESET = Symbol("compose !reset");
const composeSchema = yaml.DEFAULT_SCHEMA.extend(
  new yaml.Type("!reset", { kind: "scalar", construct: () => RESET }),
);

describe("docker-compose.release.yml", () => {
  const release = yaml.load(read("docker-compose.release.yml"), { schema: composeSchema }) as {
    services: Record<string, { build?: unknown; image?: string }>;
  };
  const vars = { migrate: "DP2_MIGRATE_IMAGE", api: "DP2_API_IMAGE", worker: "DP2_WORKER_IMAGE" } as const;

  it("overrides only migrate, api and worker, resetting build and requiring a digest-ref variable", () => {
    expect(Object.keys(release.services).sort()).toEqual(["api", "migrate", "worker"]);
    for (const [service, variable] of Object.entries(vars)) {
      const svc = release.services[service] ?? {};
      expect(svc.build).toBe(RESET);
      expect(svc.image).toMatch(new RegExp(`^\\$\\{${variable}:\\?[^}]+\\}$`));
    }
    expect(read("docker-compose.release.yml")).not.toMatch(/latest/i);
  });

  it("matches the variable names the bundle script writes to release.env", () => {
    const script = read("deploy/release-bundle.sh");
    for (const variable of Object.values(vars)) expect(script).toContain(`${variable}=`);
  });
});

describe("docker-compose.prod.yml default behaviour", () => {
  const prod = yaml.load(read("docker-compose.prod.yml")) as {
    services: Record<string, { build?: { context?: string; dockerfile?: string; target?: string } }>;
  };

  it("still builds migrate, api and worker from their Dockerfile targets", () => {
    for (const target of ["migrate", "api", "worker"]) {
      expect(prod.services[target]?.build).toEqual({ context: ".", dockerfile: "Dockerfile", target });
    }
  });
});

describe("release bundle", () => {
  const script = read("deploy/release-bundle.sh");

  function staticAllowlist(): string[] {
    const body = /^ALLOWLIST=\(\n([\s\S]*?)^\)/m.exec(script)?.[1] ?? "";
    return body.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** RT-812: the routine grant scripts the bundle appends from `apply-domain-grants.sh --list`. */
  const routineGrants = (): string[] => routineGrantScripts().map((f) => `docs/operations/sql/${f}`);

  /** Everything the bundle ships: the static ALLOWLIST plus the routine grant scripts. */
  function allowlist(): string[] {
    return [...staticAllowlist(), ...routineGrants()];
  }

  function readmeDeploySql(): string[] {
    const readme = read("deploy/README.md");
    const deploy = readme.slice(readme.indexOf("\n## Deploy\n"), readme.indexOf("\n## Admin Console release\n"));
    expect(deploy.length).toBeGreaterThan(0);
    return [...deploy.matchAll(/-f (docs\/operations\/sql\/[\w-]+\.sql)/g)].flatMap((m) => m[1] ?? []);
  }

  it("is exactly the compose files, Caddyfile, smoke and grant tools, the README's SQL scripts and their includes", () => {
    const list = staticAllowlist();
    const sql = list.filter((f) => f.startsWith("docs/operations/sql/"));
    const included = list.filter((f) => f.startsWith("packages/db/drizzle/"));
    expect(included.sort()).toEqual([
      "packages/db/drizzle/0038_erpnext_posting_resolution_backfill.sql",
      "packages/db/drizzle/0043_inventory_effect_integration_backfill.sql",
    ]);
    expect(list.filter((f) => !sql.includes(f) && !included.includes(f)).sort()).toEqual(
      [
        "Caddyfile",
        "deploy/apply-domain-grants.sh",
        "deploy/console-smoke.sh",
        "docker-compose.prod.yml",
        "docker-compose.release.yml",
      ].sort(),
    );
    expect(sql.sort()).toEqual([...readmeDeploySql()].sort());
    // RT-812: no routine grant script is hand-listed; they all come from the selector.
    expect(sql.filter((f) => f.endsWith("-domain-grants.sql"))).toEqual([]);
    const all = allowlist();
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(f).not.toMatch(/\.env(\.|$)|secret|password/i);
  });

  it("appends the routine grant scripts from the selector README step 2 runs (RT-812)", () => {
    expect(script).toContain('ROUTINE_GRANTS="$(bash deploy/apply-domain-grants.sh --list)" || fail');
    expect(script).toContain('ALLOWLIST+=("${ROUTINE_GRANT_FILES[@]}")');
    // Listed after `cd "$REPO_ROOT"`, so the selector's relative paths resolve.
    expect(script.indexOf('cd "$REPO_ROOT"')).toBeLessThan(script.indexOf("ROUTINE_GRANTS=\"$(bash"));
    expect(routineGrants().length).toBeGreaterThanOrEqual(16);
  });

  it("README step 2 runs the selector, not a hand-written list of grant scripts (RT-812)", () => {
    const readme = read("deploy/README.md");
    expect(readme).toContain("op run --env-file=deploy/grants.env -- deploy/apply-domain-grants.sh\n");
    expect(readme).toContain("Changed in RT-812");
    expect(readmeDeploySql().filter((f) => f.endsWith("-domain-grants.sql"))).toEqual([]);
    // Nor does any other block (the Operations redeploy recipe included).
    expect(readme.match(/docs\/operations\/sql\/[a-z0-9-]+-domain-grants\.sql/g) ?? []).toEqual([]);
  });

  it("only ships files that exist in the repo", () => {
    for (const f of allowlist()) expect(() => read(f)).not.toThrow();
  });

  it("ships every file a bundled SQL script includes with \\i or \\ir", () => {
    // Deploy runs `psql -f docs/operations/sql/<x>.sql` from the bundle root, so
    // \i resolves against the bundle root and \ir against the including file.
    const list = allowlist();
    const includes = list.filter((f) => f.endsWith(".sql")).flatMap((f) =>
      [...read(f).matchAll(/^\s*\\(ir?|include(?:_relative)?)\s+(\S+)/gm)].map((m) => {
        const relative = m[1] === "ir" || m[1] === "include_relative";
        const target = posix.normalize(relative ? posix.join(posix.dirname(f), m[2] ?? "") : (m[2] ?? ""));
        return { from: f, target };
      }),
    );
    expect(includes.length).toBeGreaterThan(0);
    for (const { from, target } of includes) {
      expect({ from, target, inBundle: list.includes(target) }).toEqual({ from, target, inBundle: true });
    }
  });

  it("validates digest refs and the SHA, and fails on any error", () => {
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("^ghcr\\.io/kemetra-labs/backend-core-(api|worker|migrate)@sha256:[0-9a-f]{64}$");
    expect(script).toContain("^[0-9a-f]{40}$");
    expect(script).not.toMatch(/latest/i);
  });

  // RT-908 Phase B: the contract deploy-lab.yml and verify-release.cjs consume.
  it("names the monorepo release: a required backend-core/vX.Y.Z tag, its repository and registry namespace", () => {
    expect(script).toContain('    --release-tag) RELEASE_TAG="$2" ;;');
    expect(script).toContain('[[ "$RELEASE_TAG" =~ ^backend-core/v[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || fail');
    // the tag is an input, never derived from the SHA; the bundle name still is
    expect(script).not.toMatch(/^RELEASE_TAG=/m);
    expect(script).toContain('NAME="backend-core-release-$SHA12"');
    expect(script).toContain('repository: "Kemetra-Labs/Retail-Tower-Erp",');
    expect(script).toContain('{repository: ("ghcr.io/kemetra-labs/backend-core-" + $t)');
    expect(script).not.toMatch(/ghcr\.io\/kemetra\/|Kemetra\/Backend-Core/);
  });
});
