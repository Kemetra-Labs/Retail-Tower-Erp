/**
 * RT-1309 — CLI parsing, guard ordering (no connection before the static
 * guards pass, none at all for --dry-run), exit codes, sanitized output, and
 * that the CLI adds no HTTP surface.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT, parseArgs, runCli, type CliIo } from "../../src/cli/lab-fixtures/cli";
import { ENABLE_ENV, LAB_DESCOPE_PROJECT_IDS, LAB_FIXTURE_TENANT_IDS } from "../../src/cli/lab-fixtures/constants";
import { GuardRefusedError } from "../../src/cli/lab-fixtures/guards";
import { connectFromEnv } from "../../src/cli/lab-fixtures";
import type { ProvisionerDeps } from "../../src/cli/lab-fixtures/provisioner";

const TENANT = LAB_FIXTURE_TENANT_IDS[0] ?? "";
const STORE = "fa76847c-8a5a-4c2c-92a5-a91551f394d5";
const KEY = "K-should-never-be-printed";
const LAB_ENV = {
  [ENABLE_ENV]: "enabled",
  DESCOPE_PROJECT_ID: LAB_DESCOPE_PROJECT_IDS[0],
  DESCOPE_MANAGEMENT_KEY: KEY,
};

function io(env: Record<string, string | undefined>, deps?: Partial<ProvisionerDeps>) {
  const lines: string[] = [];
  const connect = jest.fn(async () => ({
    deps: {
      provider: {
        findFixtureUser: jest.fn(async () => ({ kind: "test_user" as const, userId: "U1" })),
        createTestUser: jest.fn(),
      },
      store: {
        assertGuards: jest.fn(async () => undefined),
        readState: jest.fn(async () => ({
          user: { id: "u1", displayName: "RT Fixture Cashier 001" },
          links: [{ userId: "u1", providerKey: "descope", issuer: "I", subject: "U1", status: "active" }],
          membership: { id: "m1", roleCode: "store_staff", storeAccessKind: "specific", hasStore: true },
        })),
        apply: jest.fn(),
      },
      providerKey: "descope",
      issuer: "I",
      ...deps,
    } as ProvisionerDeps,
    close: jest.fn(async () => undefined),
  }));
  const cli: CliIo = { env, out: (l) => lines.push(l), connect };
  return { cli, lines, connect };
}

const ARGS = ["--tenant", TENANT, "--store", STORE, "--count", "1"];

describe("parseArgs", () => {
  it("parses both commands", () => {
    expect(parseArgs(["status", ...ARGS])).toEqual({ mode: "status", tenantId: TENANT, storeId: STORE, count: 1, dryRun: false });
    expect(parseArgs(["provision", ...ARGS, "--dry-run"])?.dryRun).toBe(true);
  });

  it.each([
    [[]],
    [["cleanup", ...ARGS]],
    [["status", "--tenant", TENANT]],
    [["status", ...ARGS, "--extra", "x"]],
    [["status", ...ARGS, "--tenant", TENANT]],
    [["status", "--tenant"]],
    [["status", "tenant", TENANT, "--store", STORE, "--count", "1"]],
    [["status", ...ARGS, "--dry-run"]],
  ])("rejects %j", (argv) => {
    expect(parseArgs(argv)).toBeNull();
  });
});

describe("runCli", () => {
  it("prints usage for bad arguments", async () => {
    const { cli, lines, connect } = io(LAB_ENV);
    await expect(runCli(["nope"], cli)).resolves.toBe(EXIT.usage);
    expect(lines[0]).toContain("usage");
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses without the flag and never connects (simulated production)", async () => {
    const { cli, lines, connect } = io({ ...LAB_ENV, [ENABLE_ENV]: undefined, NODE_ENV: "production" });
    await expect(runCli(["provision", ...ARGS], cli)).resolves.toBe(EXIT.guard);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "guard_refused", family: "environment" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses another Descope project before connecting", async () => {
    const { cli, lines, connect } = io({ ...LAB_ENV, DESCOPE_PROJECT_ID: "Pprod" });
    await expect(runCli(["provision", ...ARGS], cli)).resolves.toBe(EXIT.guard);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ family: "identity" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("--dry-run reports the plan without connecting", async () => {
    const { cli, lines, connect } = io(LAB_ENV);
    await expect(runCli(["provision", ...ARGS, "--dry-run"], cli)).resolves.toBe(EXIT.ok);
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "fixture", outcome: "would_provision" });
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ event: "summary", dryRun: true, exit: 0 });
  });

  it("runs status, closes the connection and prints no secret", async () => {
    const { cli, lines, connect } = io(LAB_ENV);
    await expect(runCli(["status", ...ARGS], cli)).resolves.toBe(EXIT.ok);
    expect(connect).toHaveBeenCalledTimes(1);
    const closed = (await connect.mock.results[0]?.value) as { close: jest.Mock };
    expect(closed.close).toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("@");
  });

  it("exits 4 when a fixture is refused and 5 when the run stopped", async () => {
    const refused = io(LAB_ENV, {
      provider: { findFixtureUser: jest.fn(async () => ({ kind: "not_test_user" as const })), createTestUser: jest.fn() },
    });
    await expect(runCli(["provision", ...ARGS], refused.cli)).resolves.toBe(EXIT.refused);

    const stopped = io(LAB_ENV, {
      provider: { findFixtureUser: jest.fn(async () => ({ kind: "unavailable" as const })), createTestUser: jest.fn() },
    });
    await expect(runCli(["provision", ...ARGS], stopped.cli)).resolves.toBe(EXIT.stopped);
  });

  it("maps a database guard refusal to exit 3 and still closes", async () => {
    const store = {
      assertGuards: jest.fn(async () => {
        throw new GuardRefusedError("environment", "not the lab database");
      }),
      readState: jest.fn(),
      apply: jest.fn(),
    };
    const { cli, lines, connect } = io(LAB_ENV, { store });
    await expect(runCli(["provision", ...ARGS], cli)).resolves.toBe(EXIT.guard);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ family: "environment" });
    const closed = (await connect.mock.results[0]?.value) as { close: jest.Mock };
    expect(closed.close).toHaveBeenCalled();
  });

  it("re-throws an unexpected error", async () => {
    const store = { assertGuards: jest.fn(async () => { throw new Error("boom"); }), readState: jest.fn(), apply: jest.fn() };
    const { cli } = io(LAB_ENV, { store });
    await expect(runCli(["provision", ...ARGS], cli)).rejects.toThrow("boom");
  });
});

describe("connectFromEnv", () => {
  const args = { mode: "status" as const, tenantId: TENANT, storeId: STORE, count: 1, dryRun: false };

  it.each([
    [{}, "DESCOPE_PROJECT_ID is required"],
    [{ DESCOPE_PROJECT_ID: "PLAB" }, "DATABASE_URL is required"],
    [{ DESCOPE_PROJECT_ID: "PLAB", DATABASE_URL: "postgres://x/y", NODE_ENV: "production" }, "AUTH_LOOKUP_DATABASE_URL is required in production"],
    [{ DESCOPE_PROJECT_ID: "PLAB", DATABASE_URL: "postgres://x/y" }, "DESCOPE_MANAGEMENT_KEY is required"],
  ])("fails before any query when configuration is missing (%#)", async (env, message) => {
    await expect(connectFromEnv(env as NodeJS.ProcessEnv)(args)).rejects.toThrow(message);
  });

  it("builds the dependencies without connecting until used", async () => {
    const env = { DESCOPE_PROJECT_ID: "PLAB", DATABASE_URL: "postgres://x/y", AUTH_LOOKUP_DATABASE_URL: "postgres://x/z", DESCOPE_MANAGEMENT_KEY: KEY };
    const { deps, close } = await connectFromEnv(env as NodeJS.ProcessEnv)(args);
    expect(deps.providerKey).toBe("descope");
    expect(deps.issuer).toBe("https://api.descope.com/v1/apps/PLAB");
    await close();
  });
});

describe("no HTTP surface", () => {
  it("no module outside src/cli imports the CLI", () => {
    const src = resolve(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== resolve(src, "cli")) walk(path);
        } else if (entry.name.endsWith(".ts") && /from\s+["'][^"']*\/cli\//.test(readFileSync(path, "utf8"))) {
          offenders.push(path);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it("the CLI declares no Nest controller or route decorator", () => {
    const dir = resolve(__dirname, "../../src/cli/lab-fixtures");
    const sources = [...readdirSync(dir).map((f) => resolve(dir, f)), resolve(dir, "../lab-fixtures.ts")];
    for (const file of sources) {
      expect(readFileSync(file, "utf8")).not.toMatch(/@(Controller|Get|Post|Put|Patch|Delete)\(/);
    }
  });
});
