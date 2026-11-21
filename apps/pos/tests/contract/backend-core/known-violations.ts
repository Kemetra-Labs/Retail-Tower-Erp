/**
 * RT-217 — contract violations that exist on POS `main` today and are tracked by
 * a ticket. The suite requires the observed violations to equal this list EXACTLY:
 *   - a violation not listed here fails the suite (a new bug);
 *   - a listed violation that no longer occurs also fails the suite, so the entry
 *     is deleted by the PR that fixes it (the list can never go stale).
 * Nothing here is skipped: every call is still driven and checked on every run.
 */
import type { CredentialKind } from './openapi-index.js';

export interface KnownViolation {
  /** `ClientCall.id` from the registry. */
  readonly call: string;
  readonly kind: 'credential-mismatch' | 'endpoint-missing';
  /** For `credential-mismatch`: what the client sends today. */
  readonly sent?: CredentialKind;
  /**
   * For `credential-mismatch`: the credentials the pinned contract accepts. Part of
   * the identity, so a re-pin that changes the route's security fails the suite.
   */
  readonly requires?: readonly CredentialKind[];
  /** Jira key(s), or `TODO-ticket` when none is filed yet. */
  readonly tickets: readonly string[];
  readonly note: string;
}

export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  {
    call: 'runLivenessProbe',
    kind: 'endpoint-missing',
    tickets: ['RT-602', 'RT-600'],
    note:
      'GET /api/v1/health/live is a real Backend-Core route (@Public, unthrottled; confirmed by ' +
      'RT-600 / DEP-1), but Backend-Core publishes no health contract under ' +
      'packages/contracts/openapi, so the pinned snapshot cannot hold it. Delete this entry when a ' +
      're-pin brings the health contract in.',
  },
  {
    call: 'brandingClient.read',
    kind: 'endpoint-missing',
    tickets: ['RT-475', 'RT-1046'],
    note:
      'GET /api/pos/v1/tenant/branding is real (RT-473 S2, backend-core/v0.3.3, ' +
      'tenant-branding.openapi.yaml, device bearer). It is not vendored yet: the file also holds ' +
      'the Console /api/v1/tenants/{tenant_id}/logo routes, and pinning it regenerates ' +
      'src/shared/api-types.ts (a forbidden path) and needs codegen to keep only /api/pos/v1/ ' +
      'paths (RT-869). RT-1046 vendors it under its own exemption and deletes this entry.',
  },
  {
    call: 'policyClient.read',
    kind: 'endpoint-missing',
    tickets: ['RT-388', 'RT-1046'],
    note:
      'GET /api/pos/v1/store/cash-variance-policy (posGetCashVariancePolicy, device bearer) is real ' +
      '(RT-387, cash-variance-policy.openapi.yaml). It is not vendored: the file also holds the ' +
      'Console /api/v1/tenants/{tenant_id}/cash-variance-policy routes, and pinning it regenerates ' +
      'src/shared/api-types.ts (a forbidden path without an owner-approved branch exemption). Until ' +
      'then policy-wire.ts reads the 200 body strictly against the contract text. Vendor the file ' +
      'under its own exemption and delete this entry.',
  },
  {
    call: 'unknownItemCaptureClient.send',
    kind: 'endpoint-missing',
    tickets: ['RT-1490', 'RT-1046'],
    note:
      'POST /api/pos/v1/catalog/unknown-items (posCaptureItem) is real (spec 005, ' +
      'catalog/unknown-items.yaml). It is not vendored for the same reason as branding: the file ' +
      'also holds the Console /api/v1/catalog/unknown-items routes, which the POS codegen may not ' +
      'carry (RT-869). When it is vendored, expect a credential-mismatch: the contract still names ' +
      'the legacy `clerkJwt` scheme, but the route is guarded by PosOperatorAuthGuard, which accepts ' +
      'only the pos_operator envelope this client sends (the same credential as the sale read).',
  },
  {
    call: 'saleVoidClient.recordVoidAsCashier',
    kind: 'endpoint-missing',
    tickets: ['RT-1403'],
    note:
      'POST /api/pos/v1/sales/{saleRef}/cashier-void (recordCashierVoid, RT-530 c12029, RT-1403 ' +
      'comment 18113) is a new device-only route of pos-sales/sales.yaml 1.26.0-draft; the vendored ' +
      'contract is pinned at 1.25.0-draft, which does not have it. Delete this entry in the POS repin ' +
      'to a main commit that carries 1.26.0-draft (follow-up PR after the merge; it needs its own ' +
      'source-scope-guard exemption and an owner ask). The POS sends the call only under ' +
      'POS_PULSE_FEATURE_SALE_VOID (default off), which stays off until Backend-Core carries RT-1403.',
  },
];
