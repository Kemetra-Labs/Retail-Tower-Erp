/**
 * Lab cashier fixture provisioner — RT-1309.
 *
 * Per fixture, in order: identity-provider lookup (test users only) → database state →
 * plan → (provision only) provider create when absent, re-verified as a test
 * user → one database transaction for the missing rows. The provider and Postgres
 * are not one transaction: a provider user created before a failed database
 * write is adopted by the next run, because it is the same test user.
 *
 * A provider outage stops the whole run (no retries); every other problem
 * refuses that one fixture and the run continues.
 */
import type { FixtureIdentityProvider } from "./provider-port";
import type { FixtureStore } from "./fixture-store";
import type { FixtureIdentity } from "./identity";
import { planFixture, preCreateRefusal, type FixtureAction } from "./plan";

export type Mode = "status" | "provision";

type FixtureOutcome =
  | "ready"
  | "provisioned"
  | "would_provision"
  | "missing"
  | "refused"
  | "stopped";

export interface FixtureReport {
  readonly index: number;
  readonly loginId: string;
  readonly outcome: FixtureOutcome;
  readonly actions: readonly FixtureAction[];
  readonly provider:
    | "test_user"
    | "created"
    | "absent"
    | "not_test_user"
    | "ambiguous"
    | "unavailable"
    | "not_checked";
  readonly reason?: string;
}

export interface ProvisionerDeps {
  readonly provider: FixtureIdentityProvider;
  readonly store: FixtureStore;
  readonly providerKey: string;
  readonly issuer: string;
}

type Resolved =
  | { readonly kind: "subject"; readonly subject: string; readonly provider: FixtureReport["provider"] }
  | { readonly kind: "report"; readonly report: FixtureReport };

export class Provisioner {
  constructor(private readonly deps: ProvisionerDeps) {}

  /** Runs the database guards once, then each fixture in index order. */
  async run(mode: Mode, identities: readonly FixtureIdentity[]): Promise<FixtureReport[]> {
    await this.deps.store.assertGuards();
    const reports: FixtureReport[] = [];
    for (const identity of identities) {
      const report = await this.one(mode, identity);
      reports.push(report);
      if (report.outcome === "stopped") break;
    }
    return reports;
  }

  private async one(mode: Mode, identity: FixtureIdentity): Promise<FixtureReport> {
    const resolved = await this.resolveSubject(mode, identity);
    if (resolved.kind === "report") return resolved.report;
    const subject = { providerKey: this.deps.providerKey, issuer: this.deps.issuer, subject: resolved.subject };
    const state = await this.deps.store.readState(identity, resolved.subject);
    const plan = planFixture(state, subject);
    const base = { index: identity.index, loginId: identity.loginId, provider: resolved.provider };
    if (plan.kind === "refuse") return { ...base, outcome: "refused", actions: [], reason: plan.reason };
    if (plan.actions.length === 0) return { ...base, outcome: "ready", actions: [] };
    if (mode === "status") return { ...base, outcome: "missing", actions: plan.actions };
    await this.deps.store.apply(identity, subject, plan.actions);
    return { ...base, outcome: "provisioned", actions: plan.actions };
  }

  /** The fixture's provider subject, or a final report when there is none to use. */
  private async resolveSubject(mode: Mode, identity: FixtureIdentity): Promise<Resolved> {
    const base = { index: identity.index, loginId: identity.loginId, actions: [] as FixtureAction[] };
    const found = await this.deps.provider.findFixtureUser(identity.loginId);
    switch (found.kind) {
      case "test_user":
        return { kind: "subject", subject: found.userId, provider: "test_user" };
      case "unavailable":
        return { kind: "report", report: { ...base, outcome: "stopped", provider: "unavailable", reason: "provider_unavailable" } };
      case "not_test_user":
      case "ambiguous":
        return { kind: "report", report: { ...base, outcome: "refused", provider: found.kind, reason: `provider_${found.kind}` } };
      case "absent":
        return this.createWhenAbsent(mode, identity);
    }
  }

  private async createWhenAbsent(mode: Mode, identity: FixtureIdentity): Promise<Resolved> {
    const base = { index: identity.index, loginId: identity.loginId };
    const blocked = preCreateRefusal(await this.deps.store.readState(identity, null));
    if (blocked !== null) {
      return { kind: "report", report: { ...base, outcome: "refused", actions: [], provider: "absent", reason: blocked } };
    }
    if (mode === "status") {
      return { kind: "report", report: { ...base, outcome: "missing", actions: [], provider: "absent" } };
    }
    const created = await this.deps.provider.createTestUser(identity.loginId, identity.displayName);
    if (created.kind === "unavailable") {
      return { kind: "report", report: { ...base, outcome: "stopped", actions: [], provider: "unavailable", reason: "provider_unavailable" } };
    }
    if (created.kind === "rejected") {
      return { kind: "report", report: { ...base, outcome: "refused", actions: [], provider: "absent", reason: "provider_create_rejected" } };
    }
    return this.verifyCreated(identity, created.userId);
  }

  /** A created user counts only once the provider reports it back as a test user. */
  private async verifyCreated(identity: FixtureIdentity, userId: string): Promise<Resolved> {
    const again = await this.deps.provider.findFixtureUser(identity.loginId);
    if (again.kind === "test_user" && again.userId === userId) {
      return { kind: "subject", subject: userId, provider: "created" };
    }
    const reason = again.kind === "unavailable" ? "provider_unavailable" : "created_user_not_verified_as_test";
    const outcome = again.kind === "unavailable" ? "stopped" : "refused";
    return {
      kind: "report",
      report: { index: identity.index, loginId: identity.loginId, outcome, actions: [], provider: "created", reason },
    };
  }
}

/** Plan-only output for `--dry-run`: no provider call, no database connection. */
export function dryRunReports(identities: readonly FixtureIdentity[]): FixtureReport[] {
  return identities.map((i) => ({
    index: i.index,
    loginId: i.loginId,
    outcome: "would_provision" as const,
    actions: [],
    provider: "not_checked" as const,
    reason: "dry_run_no_io",
  }));
}
