/**
 * RT-1358 — source fences for the two rules the database cannot enforce
 * (notes 1 and 2 of the #569 review):
 *   - `app.is_provisioner` is named by exactly one source file, which never sets
 *     `app.is_platform_admin` to true;
 *   - `erp_provisioning_request` is written by the repository (and the worker
 *     sweep helper) only, so the state machine cannot be bypassed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = [...sources(join(ROOT, "apps", "api", "src")), ...sources(join(ROOT, "apps", "worker", "src")), ...sources(join(ROOT, "packages", "db", "src"))];
const rel = (p: string): string => relative(ROOT, p).split("\\").join("/");
const naming = (needle: RegExp): string[] => files.filter((f) => needle.test(readFileSync(f, "utf8"))).map(rel);

describe("fences", () => {
  it("only provisioner-context.ts SETS app.is_provisioner, and it never makes the session a platform admin", () => {
    expect(naming(/set_config\(\s*'app\.is_provisioner'/)).toEqual(["apps/api/src/erp-provisioning/provisioner-context.ts"]);
    const src = readFileSync(join(ROOT, "apps/api/src/erp-provisioning/provisioner-context.ts"), "utf8");
    expect(src).not.toMatch(/isPlatformAdmin:\s*true/);
    expect(src).toMatch(/isPlatformAdmin:\s*false/);
  });

  it("the bearer verifier and the credential routes never use the provisioner context", () => {
    for (const f of ["provisioner-auth.guard.ts", "provisioner-credential.service.ts"]) {
      const src = readFileSync(join(ROOT, "apps/api/src/erp-provisioning", f), "utf8");
      expect(src).not.toMatch(/runAsProvisioner|set_config\([^)]*is_provisioner/);
    }
  });

  it("only the repository and the worker sweep helper write erp_provisioning_request", () => {
    expect(naming(/(UPDATE|INSERT INTO|DELETE FROM)\s+erp_provisioning_request\b/i).sort()).toEqual([
      "apps/api/src/erp-provisioning/provisioning-request.repository.ts",
      "packages/db/src/helpers/erp-provisioning-sweep.ts",
    ]);
  });

  it("the repository checks every write against the transition table", () => {
    const src = readFileSync(join(ROOT, "apps/api/src/erp-provisioning/provisioning-request.repository.ts"), "utf8");
    expect(src).toMatch(/transitionAllowed\(row\.status, status\)/);
    expect(src).toMatch(/WHERE id = \$1::uuid AND version = \$2/);
  });
});
