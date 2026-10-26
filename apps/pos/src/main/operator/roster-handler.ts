import type { Logger } from 'pino';

import type { ListBranchRosterResponse } from '../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

import type { CashierAdmissionClient } from './cashier-admission-client.js';

/**
 * 004-operator-session T070b — main-side handler for operator.listBranchRoster.
 *
 * RT-113 P2 (10763 D11, owner decision 10844; fixes RT-182): the roster comes
 * from the device-authenticated `GET /api/pos/v1/cashier-admissions/roster`,
 * not the Clerk-gated `/operators/roster` (which 401s without a manager JWT).
 * The store is the paired device's; there is no branch parameter.
 *
 * Mapping: `{user_id, operator_id, display_name}` → `{id: operator_id,
 * display_name, role: 'cashier'}`. `id` stays the provider subject, the
 * session `operator_id` (RT-116 seam 1); `user_id` never crosses the bridge
 * (Constitution VII). Explicit allowlist: no other field crosses (FR-006 /
 * FR-031). A live roster carries `source: 'online'` (10763 §3).
 *
 * RT-308 (RT113-P3, 10763 D11): when Backend-Core cannot be reached
 * (transport failure or 5xx), the roster is the cashiers holding a currently
 * valid offline grant ON THIS TERMINAL, with `source: 'offline'`, mapped the
 * same way. No such cashier, or no offline source wired: `no_connection`.
 *
 * FR-032 — opaque references only: names and ids never reach pino; only the
 * count is logged.
 */

/** A cashier the offline roster may list (from an admissible grant). */
export interface OfflineRosterEntry {
  operator_id: string;
  display_name: string;
}

export interface RosterHandlerDeps {
  cashierAdmissions: Pick<CashierAdmissionClient, 'listRoster'>;
  /**
   * RT-308 — the cashiers with a currently valid offline grant on this
   * terminal (`OfflineGrantWiring.listAdmissible`). Production wires it.
   */
  offlineCashiers?: () => readonly OfflineRosterEntry[];
  logger?: Pick<Logger, 'info'>;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };
const REFUSE_NO_CONN: OperatorRefusal = { kind: 'refused', category: 'no_connection' };

export class RosterHandler {
  constructor(private readonly deps: RosterHandlerDeps) {}

  async listRoster(): Promise<ListBranchRosterResponse> {
    const result = await this.deps.cashierAdmissions.listRoster();

    if (result.kind === 'no_connection' || result.kind === 'unavailable') {
      return this.offlineRoster();
    }
    if (result.kind !== 'roster') {
      return REFUSE_INVALID;
    }

    return this.answer('online', result.cashiers);
  }

  /**
   * RT-308 (10763 D11) — the offline roster: only cashiers with a currently
   * valid grant on this terminal. Nobody (or a failing source) is the
   * `no_connection` refusal: the cashier must connect to sign in.
   */
  private offlineRoster(): ListBranchRosterResponse {
    const source = this.deps.offlineCashiers;
    if (source === undefined) return REFUSE_NO_CONN;
    let entries: readonly OfflineRosterEntry[];
    try {
      entries = source();
    } catch {
      return REFUSE_NO_CONN;
    }
    if (entries.length === 0) return REFUSE_NO_CONN;
    return this.answer('offline', entries);
  }

  private answer(
    source: 'online' | 'offline',
    entries: readonly OfflineRosterEntry[],
  ): ListBranchRosterResponse {
    // Explicit allowlist: only these three fields cross the bridge.
    const cashiers = entries.map(({ operator_id, display_name }) => ({
      id: operator_id,
      display_name,
      role: 'cashier' as const,
    }));
    this.deps.logger?.info(
      { event: 'operator.roster.fetched', count: cashiers.length, source },
      'roster fetched',
    );
    return { kind: 'roster', source, cashiers };
  }
}
