/**
 * signup-link.producer.unit.spec.ts — RT-1350 slice 3: the `auth.signup-link` email job.
 * The worker's literal copy of the job name is pinned in
 * apps/worker/test/email/email.processor.signup-link.unit.spec.ts.
 */
import { deriveJobId, EMAIL_JOB_NAMES, EmailQueueProducer, type QueueLike } from "../../src/auth/email-queue.producer";
import { NoOpEmailJobEnqueuer, type SignupLinkEmailJob } from "../../src/auth/email-job.enqueuer";

const JOB: SignupLinkEmailJob = { email: "owner@example.com", rawToken: "raw-signup-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", locale: "ar" };

function queue(): jest.Mocked<QueueLike> {
  return { add: jest.fn<Promise<unknown>, [string, unknown, ({ jobId?: string } | undefined)?]>().mockResolvedValue({ id: "j" }) };
}

describe("EmailQueueProducer.enqueueSignupLink", () => {
  it("adds the job named auth.signup-link with the payload", async () => {
    const q = queue();
    await new EmailQueueProducer(q).enqueueSignupLink(JOB);

    expect(EMAIL_JOB_NAMES.signupLink).toBe("auth.signup-link");
    expect(q.add.mock.calls[0]![0]).toBe("auth.signup-link");
    expect(q.add.mock.calls[0]![1]).toEqual(expect.objectContaining(JOB));
  });

  it("derives a PII-free, deterministic jobId in its own `signup` scope (a retried enqueue collapses)", async () => {
    const q = queue();
    const producer = new EmailQueueProducer(q);
    await producer.enqueueSignupLink(JOB);
    await producer.enqueueSignupLink(JOB);

    const id = q.add.mock.calls[0]![2]!.jobId!;
    expect(id).toBe(deriveJobId("signup", JOB.rawToken));
    expect(id).toMatch(/^signup-[0-9a-f]{32}$/);
    expect(id).not.toContain(JOB.rawToken);
    expect(id).not.toContain("owner");
    expect(q.add.mock.calls[1]![2]!.jobId).toBe(id);
    expect(id).not.toBe(deriveJobId("invite", JOB.rawToken));
  });

  it("propagates a queue failure to the caller", async () => {
    const q = queue();
    q.add.mockRejectedValue(new Error("redis down"));
    await expect(new EmailQueueProducer(q).enqueueSignupLink(JOB)).rejects.toThrow("redis down");
  });
});

describe("NoOpEmailJobEnqueuer.enqueueSignupLink", () => {
  it("does nothing and resolves", async () => {
    await expect(new NoOpEmailJobEnqueuer().enqueueSignupLink(JOB)).resolves.toBeUndefined();
  });
});
