/**
 * Operator credential exchange — the provider-neutral protocol (RT-945).
 *
 * The POS main process exchanges a manager/admin identifier + password with
 * the identity provider for a fresh session JWT, which Backend-Core then
 * verifies. The password NEVER reaches Backend-Core (AD-2). Descope is the
 * only provider (`descope-client.ts`); Clerk was retired on 2026-10-29.
 *
 * An exchanger MUST NOT echo the password into any thrown error, console line,
 * log line, or returned value (PR-1). Success returns a JWT + minimal operator
 * metadata; failure returns a generic refusal marker — `kind: 'refused'` with
 * NO factor-distinguishing detail (NFR-003 / PR-2).
 */

import type { Role } from '../../shared/operator/role.js';

export interface OperatorExchangeRequest {
  identifier: string;
  password: string;
}

export interface OperatorExchangeSuccess {
  kind: 'ok';
  /** Provider session JWT (Bearer token for Backend-Core). */
  jwt: string;
  /** Provider user id (== `sub` claim). */
  operator_id: string;
  /** Best display name from the provider's user record. */
  display_name: string;
  /**
   * Provisional role. Backend-Core is the role authority; exchangers default a
   * manager/admin operator to `manager` so takeover stays on the authoritative
   * backend path (a `cashier` default would route it into the local-only path).
   */
  role: Role;
}

export type OperatorExchangeResult =
  | OperatorExchangeSuccess
  | { kind: 'refused' }
  | { kind: 'no_connection' };

/** Protocol the sign-in, takeover, re-auth and unlock paths depend on. Tests inject a fake. */
export interface OperatorExchanger {
  exchange(req: OperatorExchangeRequest): Promise<OperatorExchangeResult>;
}
