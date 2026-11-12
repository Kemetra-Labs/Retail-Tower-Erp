import { describe, expect, it } from 'vitest';

import { isOtherServer, normalizeApiOrigin } from '../api-origin.js';

/** RT-1348 — the normalized Backend-Core origin a pairing is bound to. */
describe('normalizeApiOrigin', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://API.Example.com/', 'https://api.example.com'],
    ['https://api.example.com:443', 'https://api.example.com'],
    ['http://api.example.com:80/', 'http://api.example.com'],
    ['https://api.example.com:8443/base/path?x=1#y', 'https://api.example.com:8443'],
    ['  https://api.example.com  ', 'https://api.example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['https://example.invalid', 'https://example.invalid'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeApiOrigin(input)).toBe(expected);
  });

  it.each(['', '   ', 'not a url', 'api.example.com', 'ftp://api.example.com', 'file:///c:/x'])(
    'is null for %j (no usable http(s) origin)',
    (input) => {
      expect(normalizeApiOrigin(input)).toBeNull();
    },
  );
});

describe('isOtherServer', () => {
  it('is false when nothing is stored (a legacy row or no row)', () => {
    expect(isOtherServer(null, 'https://a.example')).toBe(false);
    expect(isOtherServer(undefined, 'https://a.example')).toBe(false);
    expect(isOtherServer(null, null)).toBe(false);
  });

  it('is false when the stored origin is the current one', () => {
    expect(isOtherServer('https://a.example', 'https://a.example')).toBe(false);
  });

  it('is true when they differ, or the current origin is unusable', () => {
    expect(isOtherServer('https://a.example', 'https://b.example')).toBe(true);
    expect(isOtherServer('https://a.example', null)).toBe(true);
  });
});
