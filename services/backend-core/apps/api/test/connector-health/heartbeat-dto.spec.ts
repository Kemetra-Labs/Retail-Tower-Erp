/**
 * HeartbeatReportSchema — backlogIndicator is a Postgres int4.
 * 2147483648 must fail here (400), not reach the UPSERT as 22003/500.
 */
import { HeartbeatReportSchema } from "../../src/connector-health/dto/connector-heartbeat.dto";

const INT4_MAX = 2147483647;

describe("HeartbeatReportSchema backlogIndicator int4 bound", () => {
  it("accepts the int4 maximum", () => {
    const parsed = HeartbeatReportSchema.parse({ backlogIndicator: INT4_MAX });
    expect(parsed.backlogIndicator).toBe(INT4_MAX);
  });

  it("rejects one past the int4 maximum", () => {
    const result = HeartbeatReportSchema.safeParse({ backlogIndicator: INT4_MAX + 1 });
    expect(result.success).toBe(false);
  });
});

describe("HeartbeatReportSchema count activation evidence (RT-1427)", () => {
  const checkedAt = "2026-11-16T10:00:00.000Z";

  it("accepts the kinds and a back-dated role report", () => {
    const parsed = HeartbeatReportSchema.parse({
      acceptedWorkItemKinds: ["sale_post", "reversal", "inventory_count"],
      backDatedRole: { status: "verified", checkedAt },
    });
    expect(parsed.acceptedWorkItemKinds).toContain("inventory_count");
    expect(parsed.backDatedRole?.status).toBe("verified");
  });

  it.each(["verified", "missing", "unknown"])("accepts role status %s", (status) => {
    expect(
      HeartbeatReportSchema.safeParse({ backDatedRole: { status, checkedAt } }).success,
    ).toBe(true);
  });

  it("rejects an unknown role status, a missing checkedAt and extra role keys", () => {
    for (const backDatedRole of [
      { status: "granted", checkedAt },
      { status: "verified" },
      { status: "verified", checkedAt, reportedAt: checkedAt },
    ]) {
      expect(HeartbeatReportSchema.safeParse({ backDatedRole }).success).toBe(false);
    }
  });

  it("rejects an unknown work-item kind", () => {
    expect(HeartbeatReportSchema.safeParse({ acceptedWorkItemKinds: ["refund"] }).success).toBe(
      false,
    );
  });
});
