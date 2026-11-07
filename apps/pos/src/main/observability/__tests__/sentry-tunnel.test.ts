import { describe, expect, it, vi } from 'vitest';
import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';

import { initSentryTunnel, TUNNEL_PLACEHOLDER_DSN } from '../sentry-tunnel.js';
import type { Integration } from '../sentry-main.js';
import type { TelemetryConfig } from '../telemetry-config.js';
import { CAPTURE_TERMINAL_TAG } from '../tunnel-transport.js';

/**
 * RT-1253 — Sentry init in tunnel mode. The real SDK is never called: `sentryInit`
 * is injected, as for the direct mode (`sentry-main.test.ts`).
 */

const COMMIT = 'a'.repeat(12) + 'b'.repeat(28);
const FAKE_INTEGRATIONS = [{ name: 'Fake' } as Integration];

type InitFn = (options: ElectronMainOptions) => void;
type WarnFn = (fields: Record<string, unknown>, msg: string) => void;

function setup(
  over: {
    commit?: string | null;
    config?: TelemetryConfig | null;
    terminal?: string | null;
    sentryInit?: ReturnType<typeof vi.fn<InitFn>>;
  } = {},
) {
  const sentryInit = over.sentryInit ?? vi.fn<InitFn>();
  const warn = vi.fn<WarnFn>();
  const transport = vi.fn();
  const result = initSentryTunnel({
    sentryInit,
    integrations: () => FAKE_INTEGRATIONS,
    logger: { warn },
    tunnelUrl: 'https://api.example.com/api/pos/v1/telemetry/envelope',
    commit: over.commit === undefined ? COMMIT : over.commit,
    config: {
      current: () =>
        over.config === undefined ? { kind: 'enabled', environment: 'lab' } : over.config,
    },
    currentTerminalId: () => (over.terminal === undefined ? 'term-A' : over.terminal),
    makeTransport: () => transport as never,
    queuePath: 'C:/userData/telemetry-queue',
  });
  const options = sentryInit.mock.calls[0]?.[0];
  return { result, options, warn, sentryInit };
}

function event(): ErrorEvent {
  return {
    event_id: 'e1',
    exception: { values: [{ type: 'Error', value: 'boom' }] },
  } as unknown as ErrorEvent;
}

type BeforeSend = (e: ErrorEvent) => ErrorEvent | null;

function beforeSendOf(options: ElectronMainOptions | undefined): BeforeSend {
  if (options?.beforeSend === undefined) throw new Error('no beforeSend');
  return options.beforeSend as unknown as BeforeSend;
}

describe('initSentryTunnel', () => {
  it('initialises once with the reserved placeholder DSN, the tunnel URL and the reviewed options', () => {
    const { result, options } = setup();
    expect(result.kind).toBe('initialized');
    expect(options?.dsn).toBe(TUNNEL_PLACEHOLDER_DSN);
    expect(new URL(TUNNEL_PLACEHOLDER_DSN).hostname.endsWith('.invalid')).toBe(true);
    expect(options?.tunnel).toBe('https://api.example.com/api/pos/v1/telemetry/envelope');
    expect(typeof options?.transport).toBe('function');
  });

  it('keeps the OBS-1 hardening: reviewed integrations only, errors only, no breadcrumbs', () => {
    const { options } = setup();
    expect(options).toMatchObject({
      defaultIntegrations: false,
      integrations: FAKE_INTEGRATIONS,
      maxBreadcrumbs: 0,
      sendDefaultPii: false,
      sendClientReports: false,
    });
    expect(options?.tracesSampleRate).toBeUndefined();
  });

  it('bounds the offline queue (30 envelopes, 7 days) at the explicit path', () => {
    expect(setup().options?.transportOptions).toMatchObject({
      maxQueueSize: 30,
      maxAgeDays: 7,
      queuePath: 'C:/userData/telemetry-queue',
    });
  });

  it('release is the build stamp SHA12', () => {
    const { options } = setup();
    expect(options?.release).toBe('a'.repeat(12));
    const sent = beforeSendOf(options)(event());
    expect(sent?.release).toBe('a'.repeat(12));
    expect(sent?.tags?.['version']).toBe('a'.repeat(12));
  });

  it('a build without a valid stamp reports release unknown (never a made-up commit)', () => {
    const { options } = setup({ commit: null });
    const sent = beforeSendOf(options)(event());
    expect(sent?.release).toBe('unknown');
  });

  it('stamps the capture terminal AFTER the allowlist scrub, so it reaches the disk queue', () => {
    const { options } = setup();
    const sent = beforeSendOf(options)(event());
    expect(sent?.tags).toMatchObject({
      service: 'pos',
      env: 'lab',
      [CAPTURE_TERMINAL_TAG]: 'term-A',
    });
  });

  it('writes nothing to the disk queue while the config is inert or never fetched', () => {
    expect(beforeSendOf(setup({ config: { kind: 'inert' } }).options)(event())).toBeNull();
    expect(beforeSendOf(setup({ config: null }).options)(event())).toBeNull();
  });

  it('writes nothing while the terminal is unpaired', () => {
    expect(beforeSendOf(setup({ terminal: null }).options)(event())).toBeNull();
  });

  it('reads the config and terminal at capture time, not at init', () => {
    let config: TelemetryConfig | null = null;
    let terminal: string | null = null;
    const sentryInit = vi.fn<InitFn>();
    initSentryTunnel({
      sentryInit,
      integrations: () => FAKE_INTEGRATIONS,
      logger: { warn: vi.fn() },
      tunnelUrl: 'https://api.example.com/api/pos/v1/telemetry/envelope',
      commit: COMMIT,
      config: { current: () => config },
      currentTerminalId: () => terminal,
      makeTransport: () => vi.fn() as never,
      queuePath: 'q',
    });
    const beforeSend = beforeSendOf(sentryInit.mock.calls[0]?.[0]);
    expect(beforeSend(event())).toBeNull();
    config = { kind: 'enabled', environment: 'prod' };
    terminal = 'term-B';
    expect(beforeSend(event())?.tags).toMatchObject({
      env: 'prod',
      [CAPTURE_TERMINAL_TAG]: 'term-B',
    });
  });

  it('drops an event that carries no exception (the same allowlist scrubber as direct mode)', () => {
    const { options } = setup();
    expect(beforeSendOf(options)({ event_id: 'x' } as ErrorEvent)).toBeNull();
  });

  it('a throwing init logs one stable warning without the error text and never throws', () => {
    const sentryInit = vi.fn<InitFn>(() => {
      throw new Error('dsn https://secret@host/1');
    });
    const { result, warn } = setup({ sentryInit });
    expect(result.kind).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});
