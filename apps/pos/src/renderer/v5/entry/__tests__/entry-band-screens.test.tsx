import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { resetBrandingForTests } from '../../../branding/branding-store';
import { PairedScreen } from '../../../routes/paired/PairedScreen';
import { PairingScreen } from '../../../routes/pairing/PairingScreen';
import { RouteLoading } from '../../foundation/RouteLoading';
import { EntryBand } from '../EntryBand';
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
