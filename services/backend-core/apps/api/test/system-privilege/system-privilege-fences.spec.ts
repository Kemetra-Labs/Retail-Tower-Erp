/**
 * RT-1389 — source fences for the rules the database cannot enforce on its own:
 *   - `app.system_privilege` is SET by exactly one source file
 *     (`packages/db/src/middleware/system-privilege.ts`), which never makes the session a
 *     platform admin and never sets `app.is_provisioner`;
 *   - each privilege value is used by exactly its one path (signup, provisioner lookup, sweep);
 *   - those three paths never set the platform-admin flag again;
 *   - RATCHET: every other production site that sets the platform-admin flag is on an explicit
 *     allowlist. A new site fails here unless this list changes in the same PR; a removed one
 *     fails until it is taken off the list (so the list only shrinks on purpose). The list is
 *     not empty: platform admin is NOT yet used only for human sessions (RT-1389 risk note).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".spec.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = [...sources(join(ROOT, "apps", "api", "src")), ...sources(join(ROOT, "apps", "worker", "src")), ...sources(join(ROOT, "packages", "db", "src"))];
const rel = (p: string): string => relative(ROOT, p).split("\\").join("/");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const naming = (needle: RegExp): string[] => files.filter((f) => needle.test(readFileSync(f, "utf8"))).map(rel).sort();

const SETTER = "packages/db/src/middleware/system-privilege.ts";
const PATHS = {
  signup: "apps/api/src/signups/signups.service.ts",
  provisioner_lookup: "apps/api/src/erp-provisioning/provisioner-auth.guard.ts",
  provisioning_sweep: "packages/db/src/helpers/erp-provisioning-sweep.ts",
} as const;

const PLATFORM_ADMIN = /isPlatformAdmin:\s*true|set_config\(\s*'app\.is_platform_admin',\s*'true'/;

/** The production sites that still set the platform-admin flag (RT-1389 ratchet; shrink only). */
const PLATFORM_ADMIN_ALLOWLIST = [
  "apps/api/src/ai-entitlements/entitlement-grants.ts",
  "apps/api/src/audit/audit.repository.ts",
  "apps/api/src/audit/outbox-audit-enqueuer.ts",
  "apps/api/src/auth/roles.guard.ts",
  "apps/api/src/auth/signin-memberships.ts",
  "apps/api/src/context/context.service.ts",
  "apps/api/src/context/tenant-context.guard.ts",
  "apps/api/src/device-health/version-policy.service.ts",
  "apps/api/src/erp-provisioning/provisioner-credential.service.ts",
  "apps/api/src/erp-provisioning/provisioning-feed.service.ts",
  "apps/api/src/memberships/invitations.service.ts",
  "apps/api/src/outbox/admin.controller.ts",
  "apps/api/src/outbox/admin.module.ts",
  "apps/api/src/platform-support-sessions/support-session.lifecycle.ts",
  "apps/api/src/pos-pilot-releases/pilot-release-registry.service.ts",
  "apps/api/src/pos-pilot-releases/pilot-tenants.service.ts",
  "apps/api/src/pos-shifts/pos-shifts.service.ts",
  "apps/api/src/tenant-access-entitlement/access-entitlement.service.ts",
  "apps/api/src/tenants/tenants.service.ts",
  "apps/worker/src/ai-usage/reservation-sweep.repository.ts",
  "apps/worker/src/audit/drizzle-audit-retention.repository.ts",
  "apps/worker/src/cashier-admissions/replay-purge.repository.ts",
  "apps/worker/src/erpnext-reconciliation/stock-run-sweep.repository.ts",
  "apps/worker/src/observability/metrics/worker.metrics.ts",
  "apps/worker/src/outbox/drainer.processor.ts",
  "apps/worker/src/outbox/drizzle-outbox-retention.repository.ts",
  "apps/worker/src/outbox/retention.processor.ts",
  "apps/worker/src/sales/sale-redrive.repository.ts",
  "apps/worker/src/worker.module.ts",
  "packages/db/src/middleware/tenant-context.ts",
  "packages/db/src/outbox/producer.ts",
  "packages/db/src/outbox/repository.ts",
];

describe("system privilege fences (RT-1389)", () => {
  it("only system-privilege.ts SETS app.system_privilege, and it never makes the session a platform admin or a provisioner", () => {
    expect(naming(/set_config\(\s*'app\.system_privilege'/)).toEqual([SETTER]);
    const src = read(SETTER);
    expect(src).not.toMatch(PLATFORM_ADMIN);
    expect(src).toMatch(/isPlatformAdmin:\s*false/);
    expect(src).not.toMatch(/set_config\(\s*'app\.is_provisioner'/);
  });

  it.each(Object.entries(PATHS))("the %s privilege is used by %s only", (privilege, file) => {
    expect(naming(new RegExp(`privilege:\\s*"${privilege}"`))).toEqual([file]);
  });

  it.each(Object.values(PATHS))("%s never sets the platform-admin flag", (file) => {
    const src = read(file);
    expect(src).not.toMatch(PLATFORM_ADMIN);
    expect(src).not.toMatch(/PLATFORM_CTX/);
    expect(src).toMatch(/runWithSystemPrivilege/);
  });

  it("every other production platform-admin site is on the allowlist, and the allowlist names no site that is gone", () => {
    expect(naming(PLATFORM_ADMIN)).toEqual([...PLATFORM_ADMIN_ALLOWLIST].sort());
  });

  it("no privilege path uses the provisioner context", () => {
    for (const file of [SETTER, ...Object.values(PATHS)]) expect(read(file)).not.toMatch(/runAsProvisioner|set_config\([^)]*is_provisioner/);
  });
});
