/**
 * return-status-read.unit.spec.ts — RT-1548 slice 2: `readReturnStatusByProvenance`
 * (`GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status`), Docker-free.
 * The controller's gates, order and audit with a fake service; the service's
 * decisions with a fake pool. The real-database behaviour (RLS, the credit
 * reversal, the lock) is `return-status-read.spec.ts`.
 */
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { RefundExecutionsController } from "../../../../src/catalog/sales/refund-executions.controller";
import { RefundExecutionsService } from "../../../../src/catalog/sales/refund-executions.service";
import { isReturnStatusReadEnabled } from "../../../../src/catalog/sales/refund-gates";
import { SaleNotFoundError } from "../../../../src/catalog/sales/sale-errors";
import type { ReturnProvenanceStatusProjection } from "../../../../src/catalog/sales/return-reads";

const TENANT = "0a000000-0000-7000-8000-0000000548b1";
const STORE = "0a000000-0000-7000-8000-0000000548b2";
const USER = "0a000000-0000-7000-8000-0000000548b3";
const SALE = "0a000000-0000-7000-8000-0000000548b4";
const RETURN = "0a000000-0000-7000-8000-0000000548b5";
const QUERY = { sourceSystem: "pos-1", externalId: "key-1" };

const RETURNS_FLAG = "POS_RETURNS_ENABLED";
const READ_FLAG = "POS_RETURN_STATUS_READ_ENABLED";

function setGates(returns: string | undefined, read: string | undefined): void {
  if (returns === undefined) delete process.env[RETURNS_FLAG];
  else process.env[RETURNS_FLAG] = returns;
  if (read === undefined) delete process.env[READ_FLAG];
  else process.env[READ_FLAG] = read;
}
afterEach(() => setGates(undefined, undefined));

// ---------------------------------------------------------------------------
// The rollout gate
// ---------------------------------------------------------------------------
describe("POS_RETURN_STATUS_READ_ENABLED (the rollout gate of the verdict)", () => {
  it("is OFF by default and for anything but 1, true or yes", () => {
    expect(isReturnStatusReadEnabled()).toBe(false);
    for (const v of ["", "0", "false", "no", "enabled", "on"]) {
      process.env[READ_FLAG] = v;
      expect(isReturnStatusReadEnabled()).toBe(false);
    }
  });

  it("is on for 1, true, yes (case-insensitive, trimmed), read per call", () => {
    for (const v of ["1", "true", "TRUE", " yes "]) {
      process.env[READ_FLAG] = v;
      expect(isReturnStatusReadEnabled()).toBe(true);
    }
    delete process.env[READ_FLAG];
    expect(isReturnStatusReadEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
type Request = { context: { tenantId: string | null; storeId: string | null; userId: string | null }; auditMetadata?: unknown };
const request = (over: Partial<Request["context"]> = {}): Request => ({
  context: { tenantId: TENANT, storeId: STORE, userId: USER, ...over },
});

function controllerWith(result: ReturnProvenanceStatusProjection | Error) {
  const readReturnStatusByProvenance = jest.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const controller = new RefundExecutionsController({ readReturnStatusByProvenance } as unknown as RefundExecutionsService);
  return { controller, readReturnStatusByProvenance };
}

const recorded: ReturnProvenanceStatusProjection = {
  status: "recorded",
  creditLinked: false,
  saleReturn: { returnRef: RETURN, saleRef: SALE } as never,
};

describe("readReturnStatusByProvenance — controller", () => {
  it.each([
    ["the returns gate is off", undefined, "true"],
    ["the status-read rollout gate is off", "true", undefined],
    ["both gates are off", undefined, undefined],
  ])("%s: the one non-disclosing 404, and the service is never asked", async (_name, returns, read) => {
    setGates(returns, read);
    const { controller, readReturnStatusByProvenance } = controllerWith(recorded);
    const req = request();
    await expect(controller.readReturnStatusByProvenance(req as never, SALE, QUERY)).rejects.toBeInstanceOf(NotFoundException);
    expect(readReturnStatusByProvenance).not.toHaveBeenCalled();
    expect(req.auditMetadata).toBeUndefined();
  });

  it("a malformed saleRef is the same 404, with no service call", async () => {
    setGates("true", "true");
    const { controller, readReturnStatusByProvenance } = controllerWith(recorded);
    await expect(controller.readReturnStatusByProvenance(request() as never, "not-a-uuid", QUERY)).rejects.toBeInstanceOf(NotFoundException);
    expect(readReturnStatusByProvenance).not.toHaveBeenCalled();
  });

  it("a sale that does not resolve in the caller's scope is the same 404, never not_recorded", async () => {
    setGates("true", "true");
    const { controller } = controllerWith(new SaleNotFoundError());
    const err = await controller.readReturnStatusByProvenance(request() as never, SALE, QUERY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ message: "not_found" });
  });

  it("asks the service with the caller's tenant and store and the query's provenance", async () => {
    setGates("true", "true");
    const { controller, readReturnStatusByProvenance } = controllerWith({ status: "not_recorded" });
    await controller.readReturnStatusByProvenance(request() as never, SALE, QUERY);
    expect(readReturnStatusByProvenance).toHaveBeenCalledWith(
      { tenantId: TENANT, storeId: STORE, userId: USER, saleRef: SALE },
      QUERY,
    );
  });

  it("recorded: answers the verdict and audits the sale ref and the return ref (ref-only)", async () => {
    setGates("true", "true");
    const { controller } = controllerWith(recorded);
    const req = request();
    await expect(controller.readReturnStatusByProvenance(req as never, SALE, QUERY)).resolves.toBe(recorded);
    expect(req.auditMetadata).toEqual({ sale_ref: SALE, return_ref: RETURN });
  });

  it("not_recorded: answers only the status and audits the sale ref alone", async () => {
    setGates("true", "true");
    const { controller } = controllerWith({ status: "not_recorded" });
    const req = request();
    await expect(controller.readReturnStatusByProvenance(req as never, SALE, QUERY)).resolves.toEqual({ status: "not_recorded" });
    expect(req.auditMetadata).toEqual({ sale_ref: SALE });
  });

  it("no store context is a 401, like the sibling reads", async () => {
    setGates("true", "true");
    const { controller } = controllerWith(recorded);
    await expect(
      controller.readReturnStatusByProvenance(request({ storeId: null }) as never, SALE, QUERY),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
interface Fake {
  readonly service: RefundExecutionsService;
  readonly calls: Array<{ sql: string; values: unknown[] | undefined }>;
}

/** A pool whose client answers by statement; `lookup` is the provenance row (or none). */
function serviceWith(opts: { saleFound: boolean; lookup?: { id: string; credit_linked: boolean }; tenders?: unknown[] }): Fake {
  const calls: Fake["calls"] = [];
  const client = {
    query: jest.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("FROM sales WHERE id")) return { rows: opts.saleFound ? [{ "?column?": 1 }] : [], rowCount: opts.saleFound ? 1 : 0 };
      if (sql.includes("credit_linked")) return { rows: opts.lookup ? [opts.lookup] : [] };
      if (sql.includes("FROM sale_returns WHERE id = $1")) {
        return {
          rows: [
            {
              tenant_id: TENANT,
              sale_id: SALE,
              returned_at: new Date("2026-11-22T10:00:00Z"),
              business_date: "2026-11-22",
              source_system: "pos-1",
              external_id: "key-1",
              currency_code: "USD",
              return_total: "5.0000",
              reason: null,
            },
          ],
        };
      }
      if (sql.includes("FROM sale_return_tenders")) return { rows: opts.tenders ?? [] };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { service: new RefundExecutionsService(pool), calls };
}

const SCOPE = { tenantId: TENANT, storeId: STORE, saleRef: SALE };

describe("readReturnStatusByProvenance — service", () => {
  it("a sale outside the caller's scope throws SaleNotFoundError and never looks up the key", async () => {
    const { service, calls } = serviceWith({ saleFound: false });
    await expect(service.readReturnStatusByProvenance(SCOPE, QUERY)).rejects.toBeInstanceOf(SaleNotFoundError);
    expect(calls.some((c) => c.sql.includes("credit_linked"))).toBe(false);
  });

  it("the sale is resolved with the caller's store predicate", async () => {
    const { service, calls } = serviceWith({ saleFound: true });
    await service.readReturnStatusByProvenance(SCOPE, QUERY);
    const sale = calls.find((c) => c.sql.includes("FROM sales WHERE id"))!;
    expect(sale.values).toEqual([SALE, STORE]);
  });

  it("no return of this sale has the key: not_recorded, and nothing else in the body", async () => {
    const { service } = serviceWith({ saleFound: true });
    await expect(service.readReturnStatusByProvenance(SCOPE, QUERY)).resolves.toEqual({ status: "not_recorded" });
  });

  it("the key lookup is limited to THIS sale and counts credit-linked rows too", async () => {
    const { service, calls } = serviceWith({ saleFound: true });
    await service.readReturnStatusByProvenance(SCOPE, QUERY);
    const lookup = calls.find((c) => c.sql.includes("credit_linked"))!;
    expect(lookup.values).toEqual([SALE, "pos-1", "key-1"]);
    expect(lookup.sql).toMatch(/r\.sale_id = \$1/);
    // The ordinary lookup EXCLUDES credit reversals with NOT EXISTS; this one must not.
    expect(lookup.sql).not.toMatch(/NOT EXISTS/i);
  });

  it("an ordinary return: recorded, creditLinked false, the SaleReturn projection", async () => {
    const { service } = serviceWith({
      saleFound: true,
      lookup: { id: RETURN, credit_linked: false },
      tenders: [{ method: "cash", amount: "5.0000", allocation_ref: null, original_tender_ref: null, instrument: null }],
    });
    const res = await service.readReturnStatusByProvenance(SCOPE, QUERY);
    expect(res.status).toBe("recorded");
    if (res.status !== "recorded") throw new Error("unreachable");
    expect(res.creditLinked).toBe(false);
    expect(res.saleReturn).toMatchObject({ returnRef: RETURN, saleRef: SALE, refundTenders: [{ method: "cash", amount: "5.0000" }] });
    expect(res).not.toHaveProperty("settlement");
  });

  it("a credit-sale reversal: recorded with creditLinked true", async () => {
    const { service } = serviceWith({
      saleFound: true,
      lookup: { id: RETURN, credit_linked: true },
      tenders: [{ method: "cash", amount: "5.0000", allocation_ref: null, original_tender_ref: null, instrument: null }],
    });
    const res = await service.readReturnStatusByProvenance(SCOPE, QUERY);
    expect(res).toMatchObject({ status: "recorded", creditLinked: true });
  });

  it("a credit-sale reversal with no cash refund: recorded, creditLinked true, an EMPTY refundTenders (the zero-refund shape)", async () => {
    const { service } = serviceWith({ saleFound: true, lookup: { id: RETURN, credit_linked: true }, tenders: [] });
    const res = await service.readReturnStatusByProvenance(SCOPE, QUERY);
    if (res.status !== "recorded") throw new Error("expected recorded");
    expect(res.creditLinked).toBe(true);
    expect(res.saleReturn.refundTenders).toEqual([]);
  });
});
