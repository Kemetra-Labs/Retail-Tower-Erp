#!/usr/bin/env node
/**
 * lab-fixtures — RT-1309 (S1 of the RT-1308 design).
 *
 * Lab-only CLI that provisions synthetic POS cashiers for load tests: a
 * Descope Test User plus the Backend-Core user, active identity link and
 * `store_staff` membership the cashier admission requires. It adds no HTTP
 * route and changes no admission, sale, posting, invitation or sign-in code.
 *
 *   node dist/cli/lab-fixtures.js status    --tenant <uuid> --store <uuid> --count <n>
 *   node dist/cli/lab-fixtures.js provision --tenant <uuid> --store <uuid> --count <n> [--dry-run]
 *
 * Environment: RT_LAB_FIXTURES=enabled, DATABASE_URL (domain role),
 * AUTH_LOOKUP_DATABASE_URL (required when NODE_ENV=production),
 * DESCOPE_PROJECT_ID, DESCOPE_MANAGEMENT_KEY. Guards: see lab-fixtures/guards.ts.
 * Exit codes: 0 ok · 2 usage · 3 guard refused · 4 a fixture refused · 5 stopped (Descope unavailable).
 */
import { Pool } from "pg";

import { configuredDescopeIssuer, DESCOPE_PROVIDER_KEY } from "../pos-operators/descope-verifier";
import { runCli, type CliIo } from "./lab-fixtures/cli";
import { DescopeTestUsers } from "./lab-fixtures/descope-test-users";
import { PgFixtureStore } from "./lab-fixtures/fixture-store";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? "").trim();
  if (value === "") throw new Error(`${name} is required`);
  return value;
}

function lookupUrl(env: NodeJS.ProcessEnv): string {
  const url = (env["AUTH_LOOKUP_DATABASE_URL"] ?? "").trim();
  if (url !== "") return url;
  if (env["NODE_ENV"] === "production") throw new Error("AUTH_LOOKUP_DATABASE_URL is required in production");
  return required(env, "DATABASE_URL");
}

export const connectFromEnv =
  (env: NodeJS.ProcessEnv): CliIo["connect"] =>
  async (args) => {
    const projectId = required(env, "DESCOPE_PROJECT_ID");
    const issuer = configuredDescopeIssuer(projectId);
    const domain = new Pool({ connectionString: required(env, "DATABASE_URL"), max: 2 });
    const lookup = new Pool({ connectionString: lookupUrl(env), max: 1 });
    const provider = new DescopeTestUsers({
      projectId,
      managementKey: required(env, "DESCOPE_MANAGEMENT_KEY"),
      fetch: (input, init) => fetch(input, init),
    });
    const store = new PgFixtureStore({
      domain,
      lookup,
      tenantId: args.tenantId,
      storeId: args.storeId,
      providerKey: DESCOPE_PROVIDER_KEY,
      issuer,
    });
    return {
      deps: { provider, store, providerKey: DESCOPE_PROVIDER_KEY, issuer },
      close: async () => {
        await Promise.allSettled([domain.end(), lookup.end()]);
      },
    };
  };

/* istanbul ignore next -- process wiring only; runCli and connectFromEnv carry the logic */
if (require.main === module) {
  runCli(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    connect: connectFromEnv(process.env),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Messages here are ours (no key or token is ever placed in one).
      process.stderr.write(`lab-fixtures failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
