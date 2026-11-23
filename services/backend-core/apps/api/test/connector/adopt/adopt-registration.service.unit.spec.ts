/**
 * RT-1557 — the decision table and the SQL shape of `ConnectorAdoptionService.adopt`, with the
 * database replaced by a scripted client (no Docker). The real row lock, RLS and audit insert are
 * proven against Postgres in `adopt-registration.http.integration.spec.ts` (CircleCI `remote_suite=api`).
 *
 * Proves, per outcome: what is written (the UPDATE and the one audit row, or neither), the audit row's
 * action, actor, target and metadata, and that the lookup of an earlier adoption never runs for an
 * unmanaged registration.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import {
  ADOPTED_AUDIT_ACTION,
  ConnectorAdoptionService,
  decideAdoption,
} from "../../../src/connector/connector-adoption.service";

jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: async (_pool: unknown, _ctx: unknown, work: (client: unknown) => Promise<unknown>) =>
    await work(currentClient),
}));

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const INSTANCE = "0c000000-0000-7000-8000-00000c018a01";
const ADMIN = "0b000000-0000-7000-8000-0000000000b2";
const OTHER_ADMIN = "0b000000-0000-7000-8000-0000000000b3";
const REQUEST_ID = "0d000000-0000-7000-8000-0000000000d1";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Scenario {
  readonly row: { environment: string; erpnext_site_ref: string; managed_by: string | null; disabled_at: Date | null } | null;
  readonly priorAdopter: string | null;
}

let currentClient: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
let calls: Call[];

function useScenario(s: Scenario): void {
  calls = [];
  currentClient = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FOR UPDATE")) return { rows: s.row === null ? [] : [s.row] };
      if (sql.includes("FROM audit_events")) {
        return { rows: s.priorAdopter === null ? [] : [{ metadata: { adopted_by_user_id: s.priorAdopter } }] };
      }
      return { rows: [] };
    },
  };
}

const service = new ConnectorAdoptionService({} as Pool);
const input = { tenantId: TENANT, instanceId: INSTANCE, actorUserId: ADMIN, requestId: REQUEST_ID };
const unmanaged = { environment: "pilot", erpnext_site_ref: "lab.localhost", managed_by: null, disabled_at: null };
const writes = (): Call[] => calls.filter((c) => /^\s*(UPDATE|INSERT)/i.test(c.sql));

describe("decideAdoption", () => {
  const base = { disabled: false, actorUserId: ADMIN, adoptedByUserId: null };
  it.each([
    ["an unmanaged registration is adopted", { ...base, managedBy: null }, "adopt"],
    ["a disabled unmanaged registration is refused", { ...base, managedBy: null, disabled: true }, "disabled"],
    ["a disabled managed registration is refused as disabled first", { ...base, managedBy: "provisioner", disabled: true }, "disabled"],
    ["a managed registration with no adoption record is refused", { ...base, managedBy: "provisioner" }, "already_managed"],
    ["a managed registration adopted by another admin is refused", { ...base, managedBy: "provisioner", adoptedByUserId: OTHER_ADMIN }, "already_managed"],
    ["a repeat by the admin that adopted it is a no-op", { ...base, managedBy: "provisioner", adoptedByUserId: ADMIN }, "already_adopted"],
  ] as const)("%s", (_name, args, expected) => {
    expect(decideAdoption(args)).toBe(expected);
  });
});

describe("ConnectorAdoptionService.adopt", () => {
  it("adopts an unmanaged registration: one UPDATE and exactly one audit row, in this transaction", async () => {
    useScenario({ row: unmanaged, priorAdopter: null });
    const result = await service.adopt(input);

    expect(result).toEqual({
      kind: "ok",
      body: { outcome: "adopted", tenantId: TENANT, instanceId: INSTANCE, managedBy: "provisioner", environment: "pilot", erpnextSiteRef: "lab.localhost" },
    });
    const [update, audit, ...rest] = writes();
    expect(rest).toEqual([]);
    expect(update?.sql).toMatch(/UPDATE connector_registration SET managed_by = 'provisioner'/);
    expect(update?.sql).toMatch(/managed_by IS NULL AND disabled_at IS NULL/);
    expect(update?.params).toEqual([INSTANCE, TENANT]);
    expect(audit?.sql).toMatch(/INSERT INTO audit_events/);
    expect(audit?.params.slice(1)).toEqual([
      TENANT,
      ADMIN,
      null,
      ADOPTED_AUDIT_ACTION,
      "connector_registration",
      INSTANCE,
      REQUEST_ID,
      JSON.stringify({ actor_kind: "platform_admin", adopted_by_user_id: ADMIN, managed_by: "provisioner" }),
    ]);
    expect(calls.some((c) => c.sql.includes("FROM audit_events"))).toBe(false);
  });

  it("locks the row by id AND the path tenant", async () => {
    useScenario({ row: unmanaged, priorAdopter: null });
    await service.adopt(input);
    const lock = calls.find((c) => c.sql.includes("FOR UPDATE"));
    expect(lock?.sql).toMatch(/WHERE id = \$1::uuid AND tenant_id = \$2::uuid/);
    expect(lock?.params).toEqual([INSTANCE, TENANT]);
  });

  it("is not_found for an absent registration (or one of another tenant): nothing is written", async () => {
    useScenario({ row: null, priorAdopter: null });
    expect(await service.adopt(input)).toEqual({ kind: "not_found" });
    expect(writes()).toEqual([]);
  });

  it("refuses a disabled registration: nothing is written", async () => {
    useScenario({ row: { ...unmanaged, disabled_at: new Date() }, priorAdopter: null });
    expect(await service.adopt(input)).toEqual({ kind: "disabled" });
    expect(writes()).toEqual([]);
  });

  it("refuses an already-managed registration with no adoption record (provisioned): nothing is written", async () => {
    useScenario({ row: { ...unmanaged, managed_by: "provisioner" }, priorAdopter: null });
    expect(await service.adopt(input)).toEqual({ kind: "already_managed" });
    expect(writes()).toEqual([]);
  });

  it("refuses a registration another admin adopted: nothing is written", async () => {
    useScenario({ row: { ...unmanaged, managed_by: "provisioner" }, priorAdopter: OTHER_ADMIN });
    expect(await service.adopt(input)).toEqual({ kind: "already_managed" });
    expect(writes()).toEqual([]);
  });

  it("a repeat by the same admin answers already_adopted and writes nothing (no second audit row)", async () => {
    useScenario({ row: { ...unmanaged, managed_by: "provisioner" }, priorAdopter: ADMIN });
    const result = await service.adopt(input);
    expect(result).toMatchObject({ kind: "ok", body: { outcome: "already_adopted", managedBy: "provisioner" } });
    expect(writes()).toEqual([]);
  });
});
