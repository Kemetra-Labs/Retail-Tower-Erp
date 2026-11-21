/**
 * RT-1034 — SyncFailureAlertProcessor unit tests against an in-memory repository that honours the
 * same contract as the Postgres one (a delivery is claimed once per (window, recipient); only a
 * `failed` claim can be retaken). The real SQL, RLS and grants are proven by the integration spec.
 *
 *   S3   a redelivered sweep (and a sweep killed after the send) never sends twice
 *   S4   a retry storm on one open condition is one alert; it re-arms only after it clears
 *   S5   a provider outage fails the job (BullMQ backoff -> failed set -> Sentry), and the
 *        recovery sends exactly once
 *   S8   a secret in a provider error reaches neither a log line, a stored row nor the job error
 *   AC2  100 redeliveries of the same open condition send one email per recipient
 *   AC3  the alert reaches the provider within 10 minutes of the failure state appearing
 */
import { RecordingEmailAdapter } from "../../src/email/email.adapter";
import {
  MalformedSyncFailureAlertJobError,
  SYNC_FAILURE_ALERT_JOB_NAME,
  SyncFailureAlertIncompleteError,
  SyncFailureAlertProcessor,
  UnknownSyncFailureAlertJobError,
  type SyncFailureAlertLogLine,
} from "../../src/sync-failure-alert/sync-failure-alert.processor";
import {
  DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS,
} from "../../src/sync-failure-alert/sync-failure-alert.config";
import type {
  AlertRecipient,
  ClaimInput,
  ClaimOutcome,
  ObservedCondition,
  OpenWindow,
  OutcomeInput,
  ReconcileResult,
  SyncFailureAlertRepository,
} from "../../src/sync-failure-alert/sync-failure-alert.repository";

const TENANT = "0a000000-0000-7000-8000-000000103401";
const STORE = "0a000000-0000-7000-8000-000000103410";
const OWNER: AlertRecipient = { userId: "0a000000-0000-7000-8000-0000001034a1", email: "owner@fixture.invalid" };
const ADMIN: AlertRecipient = { userId: "0a000000-0000-7000-8000-0000001034a2", email: "admin@fixture.invalid" };
const CONDITION: ObservedCondition = {
  storeId: STORE,
  storeName: "Main Store",
  condition: "posting_permanently_rejected",
  failureCount: 3,
};

interface FakeDelivery {
  id: string;
  status: "claimed" | "delivered" | "failed";
  attempts: number;
  errorClass: string | null;
  deliveredAt: Date | null;
}

/** In-memory repository with the Postgres one's dedup semantics. */
class FakeRepo implements SyncFailureAlertRepository {
  observed: ObservedCondition[] = [CONDITION];
  tenantActive = true;
  recipients: AlertRecipient[] = [OWNER];
  authorized = new Set<string>([OWNER.userId, ADMIN.userId]);
  windows: { id: string; seq: number; open: boolean }[] = [];
  deliveries = new Map<string, FakeDelivery>();
  audit: string[] = [];
  /** Make the next markDelivered throw (a worker killed after the provider accepted the mail). */
  killAfterSend = false;
  staleReported = new Set<string>();
  private n = 0;

  listTenantIds(): Promise<string[]> {
    return Promise.resolve([TENANT]);
  }
  observeConditions(): Promise<ObservedCondition[] | null> {
    return Promise.resolve(this.tenantActive ? this.observed : null);
  }
  reconcileWindows(_t: string, observed: readonly ObservedCondition[]): Promise<ReconcileResult> {
    const out: OpenWindow[] = [];
    for (const o of observed) {
      let w = this.windows.find((x) => x.open);
      const justOpened = w === undefined;
      if (w === undefined) {
        w = { id: `w${this.windows.length + 1}`, seq: this.windows.length + 1, open: true };
        this.windows.push(w);
        this.audit.push("fired");
      }
      out.push({ ...o, windowId: w.id, windowSeq: w.seq, justOpened });
    }
    let cleared = 0;
    if (observed.length === 0) {
      for (const w of this.windows) {
        if (w.open) {
          w.open = false;
          cleared += 1;
        }
      }
    }
    return Promise.resolve({ windows: out, cleared });
  }
  listRecipients(): Promise<AlertRecipient[]> {
    return Promise.resolve(this.recipients);
  }
  claimDelivery(input: ClaimInput): Promise<ClaimOutcome> {
    const key = `${input.windowId}|${input.userId}`;
    const existing = this.deliveries.get(key);
    if (existing === undefined) {
      this.n += 1;
      this.deliveries.set(key, {
        id: `d${this.n}`,
        status: "claimed",
        attempts: 1,
        errorClass: null,
        deliveredAt: null,
      });
      return Promise.resolve({ kind: "claimed", deliveryId: `d${this.n}`, retry: false });
    }
    if (existing.status === "failed") {
      existing.status = "claimed";
      existing.attempts += 1;
      return Promise.resolve({ kind: "claimed", deliveryId: existing.id, retry: true });
    }
    return Promise.resolve({ kind: "exists" });
  }
  authorizedEmail(_t: string, _s: string, userId: string): Promise<string | null> {
    const r = [OWNER, ADMIN].find((x) => x.userId === userId);
    return Promise.resolve(r && this.authorized.has(userId) ? r.email : null);
  }
  private find(id: string): FakeDelivery {
    return [...this.deliveries.values()].find((d) => d.id === id)!;
  }
  markDelivered(input: OutcomeInput & { at: Date }): Promise<void> {
    if (this.killAfterSend) {
      this.killAfterSend = false;
      return Promise.reject(new Error("worker killed"));
    }
    const d = this.find(input.deliveryId);
    d.status = "delivered";
    d.deliveredAt = input.at;
    this.audit.push("delivered");
    return Promise.resolve();
  }
  markFailed(input: OutcomeInput & { errorClass: string; at: Date }): Promise<void> {
    const d = this.find(input.deliveryId);
    d.status = "failed";
    d.errorClass = input.errorClass;
    this.audit.push("failed");
    return Promise.resolve();
  }
  recordStaleClaims(): Promise<number> {
    let recorded = 0;
    for (const d of this.deliveries.values()) {
      if (d.status === "claimed" && !this.staleReported.has(d.id)) {
        this.staleReported.add(d.id);
        recorded += 1;
      }
    }
    return Promise.resolve(recorded);
  }
  recordSuppressed(): Promise<void> {
    if (!this.audit.includes("suppressed")) this.audit.push("suppressed");
    return Promise.resolve();
  }
}

function build(repo = new FakeRepo(), adapter = new RecordingEmailAdapter(), clock = () => new Date()) {
  const logs: SyncFailureAlertLogLine[] = [];
  const outcomes: string[] = [];
  const processor = new SyncFailureAlertProcessor(
    repo,
    adapter,
    true,
    (o) => outcomes.push(o),
    clock,
    (l) => logs.push(l),
  );
  return { repo, adapter, processor, logs, outcomes };
}

const run = (p: SyncFailureAlertProcessor) => p.process(SYNC_FAILURE_ALERT_JOB_NAME, {});

describe("RT-1034 SyncFailureAlertProcessor", () => {
  it("is inert unless enabled: no tenant is read and nothing is sent", async () => {
    const repo = new FakeRepo();
    const adapter = new RecordingEmailAdapter();
    const off = new SyncFailureAlertProcessor(repo, adapter, false);
    const result = await run(off);
    expect(result.enabled).toBe(false);
    expect(adapter.sent).toHaveLength(0);
    expect(repo.windows).toHaveLength(0);
  });

  it("skips a suspended or deleted tenant: no window, no email", async () => {
    const repo = new FakeRepo();
    repo.tenantActive = false;
    const { processor, adapter } = build(repo);
    expect(await run(processor)).toMatchObject({ tenants: 1, fired: 0, delivered: 0 });
    expect(adapter.sent).toHaveLength(0);
    expect(repo.windows).toHaveLength(0);
  });

  it("any error between the claim and the send is released as PreSendError: the retry sends it, once", async () => {
    const repo = new FakeRepo();
    const { processor, adapter } = build(repo);
    const realAuthorized = repo.authorizedEmail.bind(repo);
    let failures = 1;
    repo.authorizedEmail = (t, s, u) =>
      failures-- > 0 ? Promise.reject(new Error("pool timeout")) : realAuthorized(t, s, u);
    await expect(run(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    const row = [...repo.deliveries.values()][0]!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("PreSendError");
    await run(processor);
    await run(processor);
    expect(adapter.sent).toHaveLength(1);
  });

  it("S3 (the one unrecoverable case): a crash that also loses the outcome write leaves the claim stuck; the stale-claim metric reports it", async () => {
    const repo = new FakeRepo();
    const { processor, adapter, outcomes } = build(repo);
    const realAuthorized = repo.authorizedEmail.bind(repo);
    let crashed = false;
    repo.authorizedEmail = (t, s, u) => {
      if (!crashed) {
        crashed = true;
        return Promise.reject(new Error("worker killed between claim and send"));
      }
      return realAuthorized(t, s, u);
    };
    // The process dies: not even the outcome write happens, so the row stays 'claimed'.
    repo.markFailed = () => Promise.reject(new Error("process gone"));
    await expect(run(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    await run(processor);
    await run(processor);
    expect(adapter.sent).toHaveLength(0); // the stuck 'claimed' row is never re-sent
    expect([...repo.deliveries.values()][0]!.status).toBe("claimed");
    expect(outcomes.filter((o) => o === "stale")).toHaveLength(1); // reported once, not every sweep
  });

  it("rejects an unknown job name and a non-object payload", async () => {
    const { processor } = build();
    await expect(processor.process("other", {})).rejects.toBeInstanceOf(UnknownSyncFailureAlertJobError);
    await expect(processor.process(SYNC_FAILURE_ALERT_JOB_NAME, "x")).rejects.toBeInstanceOf(
      MalformedSyncFailureAlertJobError,
    );
  });

  it("sends one allowlisted email for a new condition and records fired + delivered", async () => {
    const { processor, adapter, repo, outcomes } = build();
    const result = await run(processor);
    expect(result).toMatchObject({ fired: 1, delivered: 1, suppressed: 0, failed: 0 });
    expect(outcomes).toEqual(["fired", "delivered"]); // the metric recorder sees fired + delivered
    expect(adapter.sent).toHaveLength(1);
    const mail = adapter.sent[0]!;
    expect(mail.to).toBe(OWNER.email);
    expect(mail.subject).toContain("Main Store");
    expect(mail.textBody).toContain("3 sale record(s)");
    expect(mail.tags).toEqual({ template_id: "alerts.sync-failure", condition: "posting_permanently_rejected" });
    expect(repo.audit).toEqual(["fired", "delivered"]);
  });

  it("AC2: 100 redeliveries of the same open condition send exactly one email per recipient", async () => {
    const repo = new FakeRepo();
    repo.recipients = [OWNER, ADMIN];
    const { processor, adapter } = build(repo);
    for (let i = 0; i < 100; i += 1) await run(processor);
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent.map((m) => m.to).sort()).toEqual([ADMIN.email, OWNER.email]);
    expect(repo.audit.filter((a) => a === "suppressed")).toHaveLength(1);
  });

  it("S3: a worker killed after the provider accepted the mail does not send a second one", async () => {
    const repo = new FakeRepo();
    const { processor, adapter } = build(repo);
    repo.killAfterSend = true;
    // The failed outcome write fails the tenant, so the job fails and BullMQ redelivers it.
    await expect(run(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    expect(adapter.sent).toHaveLength(1);
    // BullMQ redelivers the job: the claimed row suppresses the resend.
    await run(processor);
    await run(processor);
    expect(adapter.sent).toHaveLength(1);
  });

  it("S4: a retry storm is one alert; it re-arms only after the condition clears", async () => {
    const repo = new FakeRepo();
    const { processor, adapter } = build(repo);
    for (let i = 0; i < 5; i += 1) {
      repo.observed = [{ ...CONDITION, failureCount: 3 + i }];
      await run(processor);
    }
    expect(adapter.sent).toHaveLength(1);

    repo.observed = [];
    const cleared = await run(processor);
    expect(cleared.cleared).toBe(1);

    repo.observed = [CONDITION];
    const again = await run(processor);
    expect(again.fired).toBe(1);
    expect(adapter.sent).toHaveLength(2);
  });

  it("S5: a provider outage fails the job; the recovery sends once and never again", async () => {
    const repo = new FakeRepo();
    const { processor, adapter } = build(repo);
    adapter.reject = new Error("provider 503");
    await expect(run(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    await expect(run(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    const attemptsBeforeRecovery = adapter.sent.length;

    delete adapter.reject;
    const recovered = await run(processor);
    expect(recovered.delivered).toBe(1);
    expect(adapter.sent.length).toBe(attemptsBeforeRecovery + 1);
    await run(processor);
    await run(processor);
    expect(adapter.sent.length).toBe(attemptsBeforeRecovery + 1);
    expect([...repo.deliveries.values()][0]!.attempts).toBe(3);
  });

  it("S8: a secret in the provider error reaches no log line, row, audit entry or job error", async () => {
    const secret = ["AKIA", "S8CANARY", "0123456789"].join("");
    const repo = new FakeRepo();
    const { processor, adapter, logs } = build(repo);
    adapter.reject = new Error(`SignatureDoesNotMatch ${secret}`);
    let jobError: Error | undefined;
    try {
      await run(processor);
    } catch (err) {
      jobError = err as Error;
    }
    const everything = JSON.stringify({
      logs,
      deliveries: [...repo.deliveries.values()],
      audit: repo.audit,
      jobError: jobError?.message,
    });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(OWNER.email);
    expect(JSON.stringify(logs)).not.toContain("SignatureDoesNotMatch");
  });

  it("AC5 (send time): a recipient who lost authorization after listing gets no email", async () => {
    const repo = new FakeRepo();
    repo.authorized.delete(OWNER.userId);
    const { processor, adapter } = build(repo);
    const result = await run(processor);
    expect(adapter.sent).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect([...repo.deliveries.values()][0]!.errorClass).toBe("RecipientNotAuthorized");
    // Not a provider failure: the job does not fail, so BullMQ does not retry it.
  });

  it("AC3: the alert reaches the provider within 10 minutes of the failure appearing", async () => {
    const failureAppearedAt = new Date("2026-11-21T10:00:00.000Z");
    // Worst case: the failure lands just after a tick, so the next tick is one interval later.
    const tickAt = new Date(failureAppearedAt.getTime() + DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS);
    const repo = new FakeRepo();
    const { processor } = build(repo, new RecordingEmailAdapter(), () => tickAt);
    await run(processor);
    const deliveredAt = [...repo.deliveries.values()][0]!.deliveredAt!;
    const elapsedMs = deliveredAt.getTime() - failureAppearedAt.getTime();
    expect(elapsedMs).toBeLessThan(10 * 60 * 1000);
    expect(DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
