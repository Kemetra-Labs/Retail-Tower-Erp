import path from 'node:path';
import { app } from 'electron';
import type { ClerkExchanger } from '../operator/clerk-client.js';
import { resolveOperatorExchanger } from '../operator/resolve-exchanger.js';

/**
 * 002-terminal-pairing US2: API base URL for the pair endpoint. Reads
 * `VITE_API_BASE_URL` from `process.env` (Vite does NOT prefix-filter
 * the main bundle — main is built with tsc, not Vite). Falls back to
 * a non-routable placeholder when unset.
 *
 * Public hardening: source must not publish live environment endpoints.
 * Configure the real Data-Pulse-2 host per environment via `VITE_API_BASE_URL`;
 * the default intentionally fails closed.
 */
const DEFAULT_API_BASE_URL = 'https://example.invalid';

export function resolveApiBaseUrl(): string {
  const fromEnv = process.env['VITE_API_BASE_URL'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv;
  return DEFAULT_API_BASE_URL;
}

/**
 * 004-operator-session / RT-792 — resolve the production `ClerkExchanger`.
 *
 * `OPERATOR_IDENTITY_PROVIDER` picks Clerk (default) or Descope; see
 * `operator/resolve-exchanger.ts`. When the provider's setting is unset or
 * malformed, returns a stub that always refuses so the app still launches
 * (the `/sign-in` route renders; submit fails with the generic
 * `invalid_input` refusal).
 *
 * The fetch is the raw global, not `withRequestId`: the identity provider is
 * a third party, not Backend-Core.
 */
export function resolveClerkExchanger(logger: {
  warn(payload: object, msg: string): void;
}): ClerkExchanger {
  return resolveOperatorExchanger({
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    logger,
  });
}

/**
 * Resolve the directory where migration *.sql files live.
 *   - Dev (`npm run dev`): repo-root `./migrations` (cwd is the repo root).
 *   - Packaged: bundled into the app via electron-builder `files: [migrations/**]`,
 *     so they sit at `<app.getAppPath()>/migrations` (inside `app.asar`; the
 *     builder-patched `fs` reads them transparently). Using cwd here crashes the
 *     packaged exe (cwd is wherever the user launched it, not the repo).
 *   - RT-165: keyed on `shippedApp`, so a renamed shipped exe also reads the
 *     bundled migrations, never `*.sql` from whatever directory it ran in.
 */
export function resolveMigrationsDir(shippedApp: boolean): string {
  return shippedApp
    ? path.join(app.getAppPath(), 'migrations')
    : path.join(process.cwd(), 'migrations');
}
