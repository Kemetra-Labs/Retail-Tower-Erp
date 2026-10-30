/**
 * RT-792 / RT-945 — choose the manager/admin credential exchanger.
 *
 * Descope is the only identity provider (owner decision 2026-10-29).
 * `OPERATOR_IDENTITY_PROVIDER` unset, empty or `descope` selects it; any other
 * value — including a retired provider — refuses: it never selects a provider
 * the operator did not pick. Kept out of `index.ts` so the selection is
 * testable (index.ts runs `app.whenReady()` at import and cannot load under
 * vitest).
 *
 * Any missing or malformed setting logs ONE structured warning (never the raw
 * value) and returns an exchanger that refuses generically without a network
 * call, so the app still launches and `/sign-in` renders.
 */

import {
  createDescopeExchanger,
  isDescopeProjectId,
  isRegionalDescopeProjectId,
} from './descope-client.js';
import type { OperatorExchanger } from './operator-exchanger.js';

export interface ResolveOperatorExchangerDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logger: { warn(payload: object, msg: string): void };
}

const refusingExchanger: OperatorExchanger = {
  exchange: () => Promise.resolve({ kind: 'refused' as const }),
};

function refuseWith(
  logger: ResolveOperatorExchangerDeps['logger'],
  event: string,
  msg: string,
): OperatorExchanger {
  logger.warn({ event }, msg);
  return refusingExchanger;
}

export function resolveOperatorExchanger(deps: ResolveOperatorExchangerDeps): OperatorExchanger {
  const provider = (deps.env['OPERATOR_IDENTITY_PROVIDER'] ?? '').trim().toLowerCase();
  if (provider === '' || provider === 'descope') return resolveDescope(deps);
  return refuseWith(
    deps.logger,
    'operator.identity.unknown_provider',
    'OPERATOR_IDENTITY_PROVIDER is not descope; sign-in will refuse generically until corrected.',
  );
}

/** The Descope project id is a public client identifier, not a secret. */
function resolveDescope(deps: ResolveOperatorExchangerDeps): OperatorExchanger {
  const { logger } = deps;
  const projectId = (deps.env['DESCOPE_PROJECT_ID'] ?? '').trim();
  if (projectId.length === 0) {
    return refuseWith(
      logger,
      'operator.descope.missing_project_id',
      'DESCOPE_PROJECT_ID unset; sign-in will refuse generically until configured.',
    );
  }
  if (!isDescopeProjectId(projectId)) {
    return refuseWith(
      logger,
      'operator.descope.malformed_project_id',
      'DESCOPE_PROJECT_ID malformed; sign-in will refuse generically until corrected.',
    );
  }
  if (isRegionalDescopeProjectId(projectId)) {
    return refuseWith(
      logger,
      'operator.descope.regional_project_unsupported',
      'DESCOPE_PROJECT_ID is a regional project; only the api.descope.com region is supported.',
    );
  }
  return createDescopeExchanger({ projectId, fetch: deps.fetch });
}
