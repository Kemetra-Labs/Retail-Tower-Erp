import { describe, expect, it } from 'vitest';

import { classifyBuild, resolveTelemetryMode } from '../telemetry-mode.js';

/**
 * RT-1253 R3 — which Sentry path a build uses. Production builds ignore the env
 * `SENTRY_DSN` and report only through the Backend-Core tunnel; lab and dev keep
 * the existing direct path (RT-1243). The rule fails closed.
 */

const DSN = 'https://abc123@o1.ingest.de.sentry.io/4500000000000001';

describe('classifyBuild', () => {
  it('a shipped build on canary or stable is production', () => {
    expect(classifyBuild({ shipped: true, channel: 'canary' })).toBe('production');
    expect(classifyBuild({ shipped: true, channel: 'stable' })).toBe('production');
  });

  it('a shipped build on the lab channel is lab', () => {
    expect(classifyBuild({ shipped: true, channel: 'lab' })).toBe('lab');
  });

  it('a build that is not shipped is dev, whatever the channel', () => {
    expect(classifyBuild({ shipped: false, channel: 'stable' })).toBe('dev');
    expect(classifyBuild({ shipped: false, channel: null })).toBe('dev');
  });

  it('a shipped build with an unknown channel is unclassified', () => {
    expect(classifyBuild({ shipped: true, channel: null })).toBe('unclassified');
  });
});

describe('resolveTelemetryMode', () => {
  it('production ignores a valid env DSN and uses the tunnel', () => {
    expect(
      resolveTelemetryMode({ shipped: true, channel: 'stable', env: { SENTRY_DSN: DSN } }),
    ).toEqual({ mode: 'tunnel', build: 'production' });
  });

  it('production without an env DSN uses the tunnel', () => {
    expect(resolveTelemetryMode({ shipped: true, channel: 'canary', env: {} })).toEqual({
      mode: 'tunnel',
      build: 'production',
    });
  });

  it('an unclassified build ignores the env DSN (fails closed)', () => {
    expect(
      resolveTelemetryMode({ shipped: true, channel: null, env: { SENTRY_DSN: DSN } }),
    ).toEqual({ mode: 'tunnel', build: 'unclassified' });
  });

  it('lab with an env DSN keeps the direct path', () => {
    expect(
      resolveTelemetryMode({ shipped: true, channel: 'lab', env: { SENTRY_DSN: DSN } }),
    ).toEqual({ mode: 'direct', build: 'lab' });
  });

  it('lab with a malformed env DSN still takes the direct path (it refuses and logs as before)', () => {
    expect(
      resolveTelemetryMode({ shipped: true, channel: 'lab', env: { SENTRY_DSN: 'nonsense' } }),
    ).toEqual({ mode: 'direct', build: 'lab' });
  });

  it('lab without an env DSN uses the tunnel', () => {
    expect(resolveTelemetryMode({ shipped: true, channel: 'lab', env: {} })).toEqual({
      mode: 'tunnel',
      build: 'lab',
    });
  });

  it('a blank env DSN counts as unset', () => {
    expect(
      resolveTelemetryMode({ shipped: true, channel: 'lab', env: { SENTRY_DSN: '  ' } }),
    ).toEqual({ mode: 'tunnel', build: 'lab' });
  });

  it('dev with an env DSN keeps the direct path', () => {
    expect(
      resolveTelemetryMode({ shipped: false, channel: 'stable', env: { SENTRY_DSN: DSN } }),
    ).toEqual({ mode: 'direct', build: 'dev' });
  });

  it('dev without an env DSN stays inert (an unpackaged build never reports through the tunnel)', () => {
    expect(resolveTelemetryMode({ shipped: false, channel: 'stable', env: {} })).toEqual({
      mode: 'inert',
      build: 'dev',
    });
  });
});
