import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

// The handler's import graph reaches the PIN module, which loads the argon2 native addon.
// This spec never verifies a PIN, so the addon is replaced and never loaded.
vi.mock('argon2', () => ({ default: {} }));

import type { ManagerAdminSignInRequest } from '../../../shared/bridge-api.js';
import type { RuntimeConfigProblem } from '../../config/lane-config.js';
import type { BackendClient } from '../backend-client.js';
import type { OperatorExchanger } from '../operator-exchanger.js';
import { SessionManager } from '../session-manager.js';
import { SignInHandler } from '../sign-in-handler.js';
import { ProtoSessionStore } from '../takeover-handler.js';

/**
 * RT-1346 (RT-1345 D4) — a terminal with no usable server address or sign-in identity
 * setting (after environment, then the baked file) is told so, with a category the
 * renderer maps to Arabic copy naming the setting and who fixes it; it is not shown the
 * generic credential refusal, and nothing is sent to the identity provider or to
 * Backend-Core. The copy itself is pinned in the renderer's `config-refusal-copy` spec.
 */

function setup(configProblem: (() => RuntimeConfigProblem | null) | undefined) {
  const exchange = vi.fn(() => Promise.resolve({ kind: 'refused' as const }));
  const clerk: OperatorExchanger = { exchange };
  const backendSignIn = vi.fn();
  const backend = {
    signIn: backendSignIn,
    signOut: vi.fn(),
    listRoster: vi.fn(),
    confirmTakeover: vi.fn(),
    getStuckShifts: vi.fn(),
  } as unknown as BackendClient;
  const info = vi.fn();
  const handler = new SignInHandler({
    clerk,
    backend,
    sessionManager: new SessionManager(),
    deviceTokenAttestation: () => 'device-token',
    protoStore: new ProtoSessionStore(),
    ...(configProblem === undefined ? {} : { configProblem }),
    logger: { info } as unknown as Logger,
  });
  return { handler, exchange, backendSignIn, info };
}

const REQ: ManagerAdminSignInRequest = {
  kind: 'manager_admin',
  identifier: 'manager@example.test',
  password: 'a-password',
};

describe('SignInHandler — missing configuration (D4)', () => {
  it('names the server address, calls nobody', async () => {
    const { handler, exchange, backendSignIn } = setup(() => 'server_address');
    expect(await handler.signIn(REQ)).toEqual({
      kind: 'refused',
      category: 'server_address_unconfigured',
    });
    expect(exchange).not.toHaveBeenCalled();
    expect(backendSignIn).not.toHaveBeenCalled();
  });

  it('names the sign-in identity (Descope project id), calls nobody', async () => {
    const { handler, exchange, backendSignIn } = setup(() => 'identity_provider');
    expect(await handler.signIn(REQ)).toEqual({
      kind: 'refused',
      category: 'identity_unconfigured',
    });
    expect(exchange).not.toHaveBeenCalled();
    expect(backendSignIn).not.toHaveBeenCalled();
  });

  it('logs the category and the stage, never the identifier or the password', async () => {
    const { handler, info } = setup(() => 'identity_provider');
    await handler.signIn(REQ);
    expect(info).toHaveBeenCalledWith(
      {
        event: 'operator.sign_in.refused',
        category: 'identity_unconfigured',
        stage: 'configuration',
      },
      expect.any(String),
    );
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(REQ.identifier);
    expect(logged).not.toContain(REQ.password);
  });

  it('with the configuration complete, sign-in proceeds to the identity provider as before', async () => {
    const { handler, exchange } = setup(() => null);
    expect(await handler.signIn(REQ)).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('without the seam (every other caller and test) behaves as before', async () => {
    const { handler, exchange } = setup(undefined);
    expect(await handler.signIn(REQ)).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('empty input is still the generic refusal, before the configuration is looked at', async () => {
    const { handler, exchange } = setup(() => 'server_address');
    expect(await handler.signIn({ ...REQ, identifier: '', password: '' })).toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    expect(exchange).not.toHaveBeenCalled();
  });
});
