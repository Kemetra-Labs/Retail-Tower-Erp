/**
 * return-commit-deadline.wiring.unit.spec.ts — RT-1548 BR-7, Docker-free: the
 * receipt stamp is mounted on `POST api/pos/v1/sales/:saleRef/returns` by
 * `ReturnCommitDeadlineModule` and runs BEFORE the guards, so time spent in a
 * guard is charged to the budget. A real Nest app and real HTTP, with a stub
 * controller and a fake clock (the real database path is the db-integration spec).
 */
import { CanActivate, Controller, Get, Module, Post, Req, type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import {
  commitDeadlineOf,
  RETURN_COMMIT_BUDGET_MS,
  RETURN_DEADLINE_CLOCK,
  ReturnCommitDeadlineModule,
  type DeadlineClock,
} from "../../../src/catalog/sales/return-commit-deadline";

class FakeClock implements DeadlineClock {
  t = 50_000;
  now(): number {
    return this.t;
  }
}

const clock = new FakeClock();
const GUARD_MS = 7_000;

/** A global guard that "takes" 7 s, as authentication and the idempotency claim might. */
class SlowGuard implements CanActivate {
  canActivate(): boolean {
    clock.t += GUARD_MS;
    return true;
  }
}

@Controller()
class StubController {
  @Post("api/pos/v1/sales/:saleRef/returns")
  returns(@Req() req: object): { remainingMs: number } {
    return { remainingMs: commitDeadlineOf(req).remainingMs() };
  }

  @Get("api/pos/v1/sales/:saleRef/returns")
  list(@Req() req: object): { remainingMs: number } {
    return { remainingMs: commitDeadlineOf(req).remainingMs() };
  }
}

@Module({
  imports: [ReturnCommitDeadlineModule],
  controllers: [StubController],
  providers: [{ provide: APP_GUARD, useClass: SlowGuard }],
})
class StubModule {}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [StubModule] })
    .overrideProvider(RETURN_DEADLINE_CLOCK)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app.close();
});

describe("ReturnCommitDeadlineModule", () => {
  it("stamps the receipt of the recordReturn POST before the guards: the guard's time is charged to the budget", async () => {
    const res = await request(app.getHttpServer()).post("/api/pos/v1/sales/0a000000-0000-7000-8000-0000000548c1/returns").send({});
    expect(res.status).toBe(201);
    expect(res.body.remainingMs).toBe(RETURN_COMMIT_BUDGET_MS - GUARD_MS);
  });

  it("does not stamp other routes (the same path by GET gets a fresh deadline from the handler, not the middleware)", async () => {
    const res = await request(app.getHttpServer()).get("/api/pos/v1/sales/0a000000-0000-7000-8000-0000000548c1/returns");
    expect(res.status).toBe(200);
    // Unstamped: commitDeadlineOf starts a fresh real-clock budget, which is not the fake-clock arithmetic above.
    expect(res.body.remainingMs).not.toBe(RETURN_COMMIT_BUDGET_MS - GUARD_MS);
    expect(res.body.remainingMs).toBeGreaterThan(RETURN_COMMIT_BUDGET_MS - 5_000);
  });

  it("every request gets its own stamp (no leak between requests)", async () => {
    const a = await request(app.getHttpServer()).post("/api/pos/v1/sales/0a000000-0000-7000-8000-0000000548c2/returns").send({});
    clock.t += 20_000;
    const b = await request(app.getHttpServer()).post("/api/pos/v1/sales/0a000000-0000-7000-8000-0000000548c2/returns").send({});
    expect(a.body.remainingMs).toBe(RETURN_COMMIT_BUDGET_MS - GUARD_MS);
    expect(b.body.remainingMs).toBe(RETURN_COMMIT_BUDGET_MS - GUARD_MS);
  });
});
