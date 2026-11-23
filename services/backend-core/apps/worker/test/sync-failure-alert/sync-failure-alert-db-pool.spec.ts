/**
 * RT-1556 — the sync-failure alert sweep connects with its own credential
 * (SYNC_FAILURE_ALERT_DATABASE_URL, a role created from
 * docs/operations/sql/sync-failure-alert-role.sql), not the domain role.
 * Production refuses to boot without it when the sweep is enabled; a disabled
 * sweep, dev and test fall back to the domain pool, which the wrapper then must
 * not close.
 */
import type { Pool } from "pg";

import {
  SyncFailureAlertDbPool,
  syncFailureAlertPoolProviderFactory,
} from "../../src/sync-failure-alert/sync-failure-alert-db-pool";

const FAKE_ALERT_URL = "postgres://alert:alert@127.0.0.1:1/fake";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function fakePool(): Pool {
  return { end: jest.fn(async () => undefined) } as unknown as Pool;
}

describe("syncFailureAlertPoolProviderFactory", () => {
  it("throws in production when the sweep is enabled and SYNC_FAILURE_ALERT_DATABASE_URL is missing", () => {
    process.env["NODE_ENV"] = "production";
    process.env["SYNC_FAILURE_ALERT_ENABLED"] = "true";
    delete process.env["SYNC_FAILURE_ALERT_DATABASE_URL"];

    expect(() => syncFailureAlertPoolProviderFactory(fakePool())).toThrow(
      /SYNC_FAILURE_ALERT_DATABASE_URL is required in production when SYNC_FAILURE_ALERT_ENABLED=true/,
    );
  });

  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["blank", " "],
  ])("borrows the domain pool in production while the sweep is disabled (%s)", (_name, enabled) => {
    process.env["NODE_ENV"] = "production";
    if (enabled === undefined) delete process.env["SYNC_FAILURE_ALERT_ENABLED"];
    else process.env["SYNC_FAILURE_ALERT_ENABLED"] = enabled;
    delete process.env["SYNC_FAILURE_ALERT_DATABASE_URL"];
    const domain = fakePool();

    const wrapper = syncFailureAlertPoolProviderFactory(domain);
    expect(wrapper.pool).toBe(domain);
    expect(wrapper.dedicated).toBe(false);
  });

  it("borrows the domain pool outside production when the URL is missing, even if enabled", () => {
    process.env["NODE_ENV"] = "test";
    process.env["SYNC_FAILURE_ALERT_ENABLED"] = "true";
    delete process.env["SYNC_FAILURE_ALERT_DATABASE_URL"];
    const domain = fakePool();

    const wrapper = syncFailureAlertPoolProviderFactory(domain);
    expect(wrapper.pool).toBe(domain);
    expect(wrapper.dedicated).toBe(false);
  });

  it("stays on the no-DB path when neither pool exists", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["SYNC_FAILURE_ALERT_DATABASE_URL"];

    expect(syncFailureAlertPoolProviderFactory(null).pool).toBeNull();
  });

  it("opens its own pool from SYNC_FAILURE_ALERT_DATABASE_URL", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["SYNC_FAILURE_ALERT_ENABLED"] = "true";
    process.env["SYNC_FAILURE_ALERT_DATABASE_URL"] = FAKE_ALERT_URL;
    const domain = fakePool();

    const wrapper = syncFailureAlertPoolProviderFactory(domain);
    expect(wrapper.pool).not.toBeNull();
    expect(wrapper.pool).not.toBe(domain);
    expect(wrapper.dedicated).toBe(true);
    await wrapper.onModuleDestroy(); // never connected, so end() resolves at once
  });

  it("opens its own pool when the URL is set even while the sweep is disabled", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["SYNC_FAILURE_ALERT_ENABLED"];
    process.env["SYNC_FAILURE_ALERT_DATABASE_URL"] = FAKE_ALERT_URL;
    const domain = fakePool();

    const wrapper = syncFailureAlertPoolProviderFactory(domain);
    expect(wrapper.dedicated).toBe(true);
    expect(wrapper.pool).not.toBe(domain);
    await wrapper.onModuleDestroy();
  });
});

describe("SyncFailureAlertDbPool — lifecycle", () => {
  it("ends an owned pool exactly once", async () => {
    const pool = fakePool();
    const wrapper = new SyncFailureAlertDbPool(pool, true);

    await wrapper.onModuleDestroy();
    await wrapper.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(wrapper.pool).toBeNull();
  });

  it("never ends a borrowed domain pool (AuditDbPool owns it)", async () => {
    const pool = fakePool();
    const wrapper = new SyncFailureAlertDbPool(pool, false);

    await wrapper.onModuleDestroy();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("is a no-op on the no-DB path", async () => {
    await expect(new SyncFailureAlertDbPool(null, false).onModuleDestroy()).resolves.toBeUndefined();
  });
});
