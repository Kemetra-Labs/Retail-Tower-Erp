import { describe, expect, it } from 'vitest';

import { createBrandingClient } from '../branding-client.js';
import { brandingEtag, isPngOfSize, readBrandingBody } from '../branding-wire.js';
import { boundedDisplayName } from '../branding-service.js';
import { logoBody, noLogoBody, pngBase64, scriptedFetch } from './__helpers__/branding-fixture.js';

/** RT-475 — the `posGetTenantBranding` body is read strictly (contract RT-473). */

function withLogo(patch: Record<string, unknown>): Record<string, unknown> {
  const body = logoBody();
  return { ...body, logo: { ...(body.logo as Record<string, unknown>), ...patch } };
}

describe('RT-475 — readBrandingBody', () => {
  it('reads a logo body and a no-logo body', () => {
    expect(readBrandingBody(logoBody())?.logo?.screen).toHaveLength(8);
    expect(readBrandingBody(noLogoBody())?.logo).toBeNull();
  });

  it.each([
    ['an extra top-level field', { ...logoBody(), tenant_id: 'x' }],
    ['an empty name', { ...logoBody(), tenant_display_name: '' }],
    ['a logo at revision 0', { ...logoBody(), revision: 0 }],
    ['low_contrast without the card (FR-11)', withLogo({ warnings: ['low_contrast'] })],
    ['an unknown warning', withLogo({ warnings: ['blurry'] })],
    [
      'a duplicated warning',
      withLogo({ warnings: ['receipt_thin_strokes', 'receipt_thin_strokes'] }),
    ],
    ['a bad version', withLogo({ version: 'ABC' })],
    [
      '7 screen renditions',
      withLogo({ screen: (logoBody().logo as { screen: unknown[] }).screen.slice(1) }),
    ],
  ])('refuses %s', (_label, body) => {
    expect(readBrandingBody(body)).toBeNull();
  });

  it('refuses a rendition larger than its box × scale, or a duplicated pair', () => {
    const screen = (logoBody().logo as { screen: Record<string, unknown>[] }).screen;
    const oversized = screen.map((r, i) =>
      i === 0 ? { ...r, width_px: 241, png_base64: pngBase64(241, 60) } : r,
    );
    expect(readBrandingBody(withLogo({ screen: oversized }))).toBeNull();
    const duplicated = [...screen.slice(0, 7), screen[0]];
    expect(readBrandingBody(withLogo({ screen: duplicated }))).toBeNull();
  });

  it('refuses a rendition whose PNG header disagrees with its stated size', () => {
    const screen = (logoBody().logo as { screen: Record<string, unknown>[] }).screen;
    const lying = screen.map((r, i) => (i === 0 ? { ...r, png_base64: pngBase64(10, 10) } : r));
    expect(readBrandingBody(withLogo({ screen: lying }))).toBeNull();
  });

  it('accepts low_contrast with the card', () => {
    const body = withLogo({ warnings: ['low_contrast'], presentation: { card: true } });
    expect(readBrandingBody(body)?.logo?.card).toBe(true);
  });
});

describe('RT-475 — local checks', () => {
  it('recomputes the FR-18 ETag: the RT-473 contract test vectors', () => {
    // Pinned in Backend-Core `tenant-branding.contract.spec.ts` (ETag recipe, FR-18).
    expect(brandingEtag('صيدلية النور', 0)).toBe(
      '"3bb27d9a6fa499803a7fc09b5875e62c305fdad24b88cf1f5435b65003de9919"',
    );
    expect(brandingEtag('صيدلية النور', 3)).toBe(
      '"7f0554e64f2d9f8568dceedc793ad4766963e4590215d24f7893b9d187ada13b"',
    );
  });

  it('checks the PNG signature and the IHDR size', () => {
    expect(isPngOfSize(pngBase64(20, 10), 20, 10)).toBe(true);
    expect(isPngOfSize(pngBase64(20, 10), 10, 20)).toBe(false);
    expect(
      isPngOfSize(
        Buffer.from('GIF89a......................................').toString('base64'),
        20,
        10,
      ),
    ).toBe(false);
    expect(isPngOfSize('not base64!', 1, 1)).toBe(false);
  });

  it('bounds the display name to 80 UTF-16 units on a code point (OD-10)', () => {
    expect(boundedDisplayName('a'.repeat(90))).toHaveLength(80);
    const emoji = '😀'.repeat(41); // 82 units
    expect(boundedDisplayName(emoji)).toBe('😀'.repeat(40));
  });
});

describe('RT-475 — branding client', () => {
  it('sends the device bearer and If-None-Match, and maps 304 to not_modified', async () => {
    const scripted = scriptedFetch([{ status: 304 }]);
    const client = createBrandingClient({ baseUrl: 'https://bc.test', fetch: scripted.fetch });
    await expect(client.read('tok', '"abc"')).resolves.toEqual({ kind: 'not_modified' });
    expect(scripted.sent).toEqual(['"abc"']);
  });

  it('treats a 304 to an unconditional read as unreadable', async () => {
    const client = createBrandingClient({
      baseUrl: 'https://bc.test',
      fetch: scriptedFetch([{ status: 304 }]).fetch,
    });
    await expect(client.read('tok', null)).resolves.toEqual({ kind: 'unreadable' });
  });

  it.each([
    [401, 'unauthorized'],
    [500, 'server_error'],
    [429, 'server_error'],
  ])('maps %i to %s', async (status, kind) => {
    const client = createBrandingClient({
      baseUrl: 'https://bc.test',
      fetch: scriptedFetch([{ status, body: { error: 'x' } }]).fetch,
    });
    await expect(client.read('tok', null)).resolves.toEqual({ kind });
  });

  it('sends nothing without a token, and maps a network fault to unreachable', async () => {
    const scripted = scriptedFetch(['offline']);
    const client = createBrandingClient({ baseUrl: 'https://bc.test', fetch: scripted.fetch });
    await expect(client.read('', null)).resolves.toEqual({ kind: 'unreachable' });
    expect(scripted.sent).toHaveLength(0);
    await expect(client.read('tok', null)).resolves.toEqual({ kind: 'unreachable' });
  });
});
