/**
 * sale-returns-deadline.unit.spec.ts — RT-1548 slice 2, BR-7: how
 * `SaleReturnsService.recordReturn` uses the commit deadline. Docker-free, a
 * fake pool and a fake clock. The real-database behaviour (a lock wait that
 * outlives the budget, a later read answering not_recorded) is
 * `terminal/return-commit-bound.spec.ts`.
 */
import type { Pool, PoolClient } from "pg";

import {
  CommitDeadline,
  ReturnDeadlineExceededError,
  type DeadlineClock,
} from "../../../src/catalog/sales/return-commit-deadline";
import { sha256CanonicalHex } from "../../../src/common/hashing/payload-hash";
import { SaleReturnsService } from "../../../src/catalog/sales/sale-returns.service";

const TENANT = "0a000000-0000-7000-8000-0000000548a1";
const STORE = "0a000000-0000-7000-8000-0000000548a2";
const SALE = "0a000000-0000-7000-8000-0000000548a3";
const USER = "0a000000-0000-7000-8000-0000000548a4";
const RETURN = "0a000000-0000-7000-8000-0000000548a6";

class FakeClock implements DeadlineClock {
  t = 5_000;
  now(): number {
    return this.t;
  }
}

/** The request body is never read before the sale lock (the first statement). */
const BODY = {
  sourceSystem: "pos-1",
  externalId: "bound-1",
  lines: [{ lineRef: "0a000000-0000-7000-8000-0000000548a5", quantity: "1" }],
  refundTenders: [{ method: "cash", amount: "1.0000" }],
} as never;

function harness(onSql: (sql: string) => unknown) {
  const sqls: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      sqls.push(sql);
      return onSql(sql);
    }),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { service: new SaleReturnsService(pool), sqls };
}

const input = (deadline?: CommitDeadline) => ({
  tenantId: TENANT,
  storeId: STORE,
  actorUserId: USER,
  saleRef: SALE,
  body: BODY,
  ...(deadline === undefined ? {} : { deadline }),
});

const isArm = (sql: string): boolean => sql.includes("set_config('statement_timeout'");

describe("recordReturn — the BR-7 commit deadline", () => {
  it("arms the timeouts before the sale-lock statement (the lock wait is inside the budget)", async () => {
    const { service, sqls } = harness(() => ({ rows: [], rowCount: 0 })); // no sale: a plain 404 path
    await expect(service.recordReturn(input())).rejects.toThrow();
    const lockAt = sqls.findIndex((s) => s.includes("FOR UPDATE OF s"));
    expect(lockAt).toBeGreaterThan(0);
    expect(isArm(sqls[lockAt - 1]!)).toBe(true);
  });

  it("a lock_timeout cancel (55P03) while waiting for the sale lock is the deadline refusal, rolled back, no COMMIT", async () => {
    const { service, sqls } = harness((sql) => {
      if (sql.includes("FOR UPDATE OF s")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return { rows: [], rowCount: 0 };
    });
    await expect(service.recordReturn(input())).rejects.toBeInstanceOf(ReturnDeadlineExceededError);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("a statement_timeout cancel (57014) is the same refusal", async () => {
    const { service, sqls } = harness((sql) => {
      if (sql.includes("FOR UPDATE OF s")) throw Object.assign(new Error("canceled"), { code: "57014" });
      return { rows: [], rowCount: 0 };
    });
    await expect(service.recordReturn(input())).rejects.toBeInstanceOf(ReturnDeadlineExceededError);
    expect(sqls).not.toContain("COMMIT");
  });

  it("an unrelated database error is NOT rewritten into the deadline refusal", async () => {
    const boom = Object.assign(new Error("unique"), { code: "23505" });
    const { service } = harness((sql) => {
      if (sql.includes("FOR UPDATE OF s")) throw boom;
      return { rows: [], rowCount: 0 };
    });
    await expect(service.recordReturn(input())).rejects.toBe(boom);
  });

  it("a request whose budget is spent before its first statement sends nothing and never commits", async () => {
    const clock = new FakeClock();
    const spent = new CommitDeadline(clock.now() - 61_000, clock);
    const { service, sqls } = harness(() => ({ rows: [], rowCount: 0 }));
    await expect(service.recordReturn(input(spent))).rejects.toBeInstanceOf(ReturnDeadlineExceededError);
    expect(sqls.some((s) => s.includes("FOR UPDATE OF s"))).toBe(false);
    expect(sqls).not.toContain("COMMIT");
    expect(sqls).toContain("ROLLBACK");
  });

  it("the deadline is checked right before COMMIT: a replay whose last statement ends after the budget is rolled back", async () => {
    const clock = new FakeClock();
    const deadline = new CommitDeadline(clock.now(), clock);
    const { service, sqls } = harness((sql) => {
      if (sql.includes("FOR UPDATE OF s")) {
        return { rows: [{ currency_code: "USD", timezone: "UTC", responsibility_count: 0 }], rowCount: 1 };
      }
      if (sql.includes("credit_linked")) {
        // The provenance replays: the same sale and the same payload.
        return { rows: [{ id: RETURN, sale_id: SALE, payload_hash: sha256CanonicalHex(BODY), credit_linked: false }] };
      }
      if (sql.includes("FROM sale_returns WHERE id = $1")) {
        return {
          rows: [
            {
              tenant_id: TENANT,
              sale_id: SALE,
              returned_at: new Date("2026-11-22T10:00:00Z"),
              business_date: "2026-11-22",
              source_system: "pos-1",
              external_id: "bound-1",
              currency_code: "USD",
              return_total: "1.0000",
              reason: null,
            },
          ],
        };
      }
      if (sql.includes("FROM sale_return_tenders")) {
        // The last statement of the replay: it starts inside the budget (the
        // guard let it through) and ends after it.
        clock.t += 61_000;
        return { rows: [] };
      }
      return { rows: [] };
    });
    await expect(service.recordReturn(input(deadline))).rejects.toBeInstanceOf(ReturnDeadlineExceededError);
    expect(sqls).not.toContain("COMMIT");
    expect(sqls).toContain("ROLLBACK");
  });

  it("the same replay that finishes inside the budget commits (the check is not a blanket refusal)", async () => {
    const clock = new FakeClock();
    const deadline = new CommitDeadline(clock.now(), clock);
    const { service, sqls } = harness((sql) => {
      if (sql.includes("FOR UPDATE OF s")) {
        return { rows: [{ currency_code: "USD", timezone: "UTC", responsibility_count: 0 }], rowCount: 1 };
      }
      if (sql.includes("credit_linked")) {
        return { rows: [{ id: RETURN, sale_id: SALE, payload_hash: sha256CanonicalHex(BODY), credit_linked: false }] };
      }
      if (sql.includes("FROM sale_returns WHERE id = $1")) {
        return {
          rows: [
            {
              tenant_id: TENANT,
              sale_id: SALE,
              returned_at: new Date("2026-11-22T10:00:00Z"),
              business_date: "2026-11-22",
              source_system: "pos-1",
              external_id: "bound-1",
              currency_code: "USD",
              return_total: "1.0000",
              reason: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await service.recordReturn(input(deadline));
    expect(res.created).toBe(false);
    expect(sqls).toContain("COMMIT");
  });
});
