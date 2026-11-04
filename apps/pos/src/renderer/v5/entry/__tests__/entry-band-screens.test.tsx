import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { resetBrandingForTests } from '../../../branding/branding-store';
import { PairedScreen } from '../../../routes/paired/PairedScreen';
import { PairingScreen } from '../../../routes/pairing/PairingScreen';
import { RouteLoading } from '../../foundation/RouteLoading';
import { EntryBand } from '../EntryBand';
import { SignInBand } from '../SignInBand';
import { PAIRING_COPY, READY_COPY } from '../entry-copy';
import type { PairingBridgeAPI } from '../../../../shared/bridge-api';
import type { BrandingSnapshot } from '../../../../shared/branding/types';

/**
 * RT-1096 (RT-1042 S7) — pairing, Ready and boot join the entry family: each
 * root opts into the Ink and Mint roles with `data-entry-surface` and carries
 * the same band (OD-1, OD-8). Behaviour, copy and the RT-475 logo slots do not
 * change. happy-dom resolves no layout, so structure is asserted here; the
 * captures at the four sizes and under forced colours are the visual proof.
 */

afterEach(() => {
  cleanup();
  resetBrandingForTests(undefined);
});

const PNG = 'data:image/png;base64,QUFB';
const image = { width: 100, height: 25, src1x: PNG, src2x: PNG };
const LOGO: BrandingSnapshot = {
  v: 1,
  kind: 'logo',
  displayName: 'صيدلية النور',
  card: false,
  slots: {
    boot: { ...image, width: 240, height: 120 },
    pairing: { ...image, width: 200, height: 80 },
    sign_in: { ...image, width: 128, height: 32 },
    lock: { ...image, width: 200, height: 80 },
  },
};

const pairing: PairingBridgeAPI = {
  getStatus: vi.fn(() =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: 't',
      branch_id: 'b',
      terminal_id: 'term',
      terminal_label: 'Counter 1',
      paired_at: 1735689600,
    } as const),
  ),
  submit: vi.fn(() => Promise.reject(new Error('not used'))),
};

describe('RT-1096 — EntryBand', () => {
  it('is the entry banner: the «Retail Tower» wordmark (OD-8) isolated LTR, a decorative mark', () => {
    render(<EntryBand />);
    const band = screen.getByTestId('entry-band');
    expect(band.tagName).toBe('HEADER');
    const name = within(band).getByText('Retail Tower');
    expect(name).toHaveAttribute('dir', 'ltr');
    expect(band.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(band).not.toHaveTextContent('POS Pulse');
  });

  it('never changes with state: no tenant logo, no terminal label, no powered-by inside it', () => {
    resetBrandingForTests(LOGO);
    render(<EntryBand />);
    const band = screen.getByTestId('entry-band');
    expect(within(band).queryByRole('img')).not.toBeInTheDocument();
    expect(within(band).queryByTestId('powered-by')).not.toBeInTheDocument();
  });

  // RT-1092 (RT-1042 S3): sign-in renders the same band with three optional additions.
  it('`brand` replaces the mark and the wordmark', () => {
    render(<EntryBand brand={<span data-testid="tenant-brand">logo</span>} />);
    const band = screen.getByTestId('entry-band');
    expect(within(band).getByTestId('tenant-brand')).toBeInTheDocument();
    expect(band).not.toHaveTextContent('Retail Tower');
    expect(band.querySelector('svg')).toBeNull();
  });

  it('`children` follow the brand, after the wordmark', () => {
    render(
      <EntryBand>
        <span data-testid="band-context">الجهاز</span>
      </EntryBand>,
    );
    const band = screen.getByTestId('entry-band');
    const name = within(band).getByText('Retail Tower');
    const context = within(band).getByTestId('band-context');
    expect(name.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('`testId` replaces the default test id, and nothing else', () => {
    render(<EntryBand testId="entry-strip" />);
    expect(screen.queryByTestId('entry-band')).not.toBeInTheDocument();
    const band = screen.getByTestId('entry-strip');
    expect(band).toHaveClass('v5-entry-band');
    expect(band).toHaveTextContent('Retail Tower');
  });
});

describe('RT-1096 — pairing screen', () => {
  const renderPairing = (invalidReason?: 'device_revoked'): void => {
    render(
      <MemoryRouter>
        <PairingScreen pairing={pairing} {...(invalidReason ? { invalidReason } : {})} />
      </MemoryRouter>,
    );
  };

  it('opts into the entry surface and wears the band, not the sign-in strip', () => {
    renderPairing();
    const root = screen.getByTestId('route-pairing');
    expect(root).toHaveAttribute('data-entry-surface');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(root).toHaveAttribute('lang', 'ar');
    expect(within(root).getByTestId('entry-band')).toBeInTheDocument();
    expect(within(root).queryByTestId('entry-strip')).not.toBeInTheDocument();
  });

  it('keeps its copy and its one input', () => {
    renderPairing();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PAIRING_COPY.title);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('with a tenant logo: the pairing slot sits in the card, below the band, with powered-by', () => {
    resetBrandingForTests(LOGO);
    renderPairing();
    const card = document.querySelector('.v5-entry__card');
    const slot = screen.getByTestId('brand-slot-pairing');
    expect(card).toContainElement(slot);
    expect(screen.getByTestId('entry-band')).not.toContainElement(slot);
    expect(screen.getByTestId('powered-by')).toBeInTheDocument();
  });

  it('with no logo: no slot and no powered-by', () => {
    renderPairing();
    expect(screen.queryByTestId('brand-slot-pairing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
  });

  it('keeps the data-invalid-reason hook the router tests read', () => {
    renderPairing('device_revoked');
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
    expect(screen.getByTestId('entry-band')).toBeInTheDocument();
  });
});

describe('RT-1096 — Ready screen', () => {
  it('opts into the entry surface and wears the band, with its copy and commit unchanged', async () => {
    render(
      <MemoryRouter>
        <PairedScreen pairing={pairing} />
      </MemoryRouter>,
    );
    const root = await screen.findByTestId('route-paired');
    expect(root).toHaveAttribute('data-entry-surface');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(within(root).getByTestId('entry-band')).toBeInTheDocument();
    expect(within(root).queryByTestId('entry-strip')).not.toBeInTheDocument();
    expect(root).toHaveAttribute('data-terminal-label', 'Counter 1');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(READY_COPY.title);
    expect(screen.getByTestId('paired-continue')).toHaveTextContent(READY_COPY.continue);
  });
});

describe('RT-1096 — boot screen', () => {
  it('opts into the entry surface with the band and keeps its status line and landmark', () => {
    render(<RouteLoading />);
    const root = screen.getByTestId('route-loading');
    expect(root.tagName).toBe('MAIN');
    expect(root).toHaveAttribute('data-entry-surface');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(within(root).getByTestId('entry-band')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('جارٍ التحميل…');
  });

  it('with a tenant logo: the 240×120 boot slot stays in the stage, not on the Ink band', () => {
    resetBrandingForTests(LOGO);
    render(<RouteLoading />);
    const slot = screen.getByTestId('brand-slot-boot');
    expect(screen.getByTestId('entry-band')).not.toContainElement(slot);
    expect(screen.getByTestId('powered-by')).toBeInTheDocument();
  });

  it('with no logo: the band and the status only', () => {
    render(<RouteLoading />);
    expect(screen.queryByTestId('brand-slot-boot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
  });
});

/**
 * RT-1093 (RT-1042 S4, OD-5) — the ornament is an additive opt-in that only the
 * sign-in band takes. happy-dom resolves no layout, so the removal below 1280
 * wide / 768 high and under forced colours are checked in the stylesheet tests.
 */
describe('RT-1093 — band ornament', () => {
  const ornamentOf = (root: ParentNode): Element | null =>
    root.querySelector('.v5-entry-band__ornament');

  const allOf = (root: ParentNode): Element[] =>
    Array.from(root.querySelectorAll('.v5-entry-band__ornament'));

  it('sign-in draws it: static, decorative, non-focusable SVGs behind the content', () => {
    render(<SignInBand terminalLabel="Counter 1" />);
    const band = screen.getByTestId('entry-strip');
    expect(band).toHaveClass('v5-entry-band', 'v5-entry-band--ornament');
    const svgs = allOf(band);
    expect(svgs.map((svg) => svg.getAttribute('viewBox'))).toEqual(['0 0 1280 96', '0 0 1920 120']);
    for (const orn of svgs) {
      expect(orn.tagName.toLowerCase()).toBe('svg');
      expect(orn).toHaveAttribute('aria-hidden', 'true');
      expect(orn).toHaveAttribute('focusable', 'false');
      expect(orn.getAttribute('tabindex')).toBeNull();
      expect(orn.querySelectorAll('a, button, input, [tabindex], title, desc, text')).toHaveLength(
        0,
      );
      expect(orn.querySelectorAll('animate, animateTransform, animateMotion, set')).toHaveLength(0);
    }
    expect(band.firstElementChild).toBe(svgs[0]);
    expect(svgs[1]?.previousElementSibling).toBe(svgs[0]);
    expect(band).toHaveTextContent('Retail Tower');
  });

  it('sign-in with a tenant logo still draws it, decorative', () => {
    resetBrandingForTests(LOGO);
    render(<SignInBand branding={LOGO} />);
    const svgs = allOf(screen.getByTestId('entry-strip'));
    expect(svgs).toHaveLength(2);
    for (const orn of svgs) expect(orn).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the approved geometry per variant: 13 bars, grid, ruler, no text', () => {
    render(<SignInBand />);
    const band = screen.getByTestId('entry-strip');
    const variants = [
      ['base', 28, 10, 96],
      ['wide', 40, 16, 120],
    ] as const;
    for (const [name, barWidth, gap, height] of variants) {
      const orn = band.querySelector(`.v5-entry-band__ornament--${name}`);
      const bars = Array.from(orn?.querySelectorAll('.v5-entry-band__ornament-skyline rect') ?? []);
      expect(bars, name).toHaveLength(13);
      expect(bars.map((b) => Number(b.getAttribute('width')))).toEqual(Array(13).fill(barWidth));
      const xs = bars.map((b) => Number(b.getAttribute('x')));
      expect(xs[0]).toBe(40);
      expect(xs[1]).toBe(40 + barWidth + gap);
      // the tallest bar (116) reaches H - 24 above the baseline
      expect(Math.min(...bars.map((b) => Number(b.getAttribute('y'))))).toBe(24);
      expect(Number(bars[5]?.getAttribute('y')) + Number(bars[5]?.getAttribute('height'))).toBe(
        height,
      );
      expect(orn?.querySelectorAll('.v5-entry-band__ornament-grid')).toHaveLength(1);
      expect(orn?.querySelectorAll('.v5-entry-band__ornament-ruler')).toHaveLength(1);
      expect(orn?.textContent).toBe('');
    }
    // pattern ids stay unique across the two SVGs
    const ids = Array.from(band.querySelectorAll('pattern')).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the default EntryBand render has no ornament and no modifier class', () => {
    render(<EntryBand />);
    const band = screen.getByTestId('entry-band');
    expect(band.className).toBe('v5-entry-band');
    expect(ornamentOf(band)).toBeNull();
    expect(band.querySelectorAll('svg')).toHaveLength(1); // the mark only
  });

  it('is absent on pairing', () => {
    render(
      <MemoryRouter>
        <PairingScreen pairing={pairing} />
      </MemoryRouter>,
    );
    expect(ornamentOf(document.body)).toBeNull();
    expect(screen.getByTestId('entry-band').className).toBe('v5-entry-band');
  });

  it('is absent on Ready', async () => {
    render(
      <MemoryRouter>
        <PairedScreen pairing={pairing} />
      </MemoryRouter>,
    );
    await screen.findByTestId('route-paired');
    expect(ornamentOf(document.body)).toBeNull();
    expect(screen.getByTestId('entry-band').className).toBe('v5-entry-band');
  });

  it('is absent on boot', () => {
    render(<RouteLoading />);
    expect(ornamentOf(document.body)).toBeNull();
    expect(screen.getByTestId('entry-band').className).toBe('v5-entry-band');
  });
});
