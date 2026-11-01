import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { BrandSlot, PoweredBy } from '../BrandSlot';
import { resetBrandingForTests, startBrandingFeed, useBranding } from '../branding-store';
import { EntryStrip } from '../../v5/entry/EntryStrip';
import { RouteLoading } from '../../v5/foundation/RouteLoading';
import type { BrandingBridgeAPI } from '../../../shared/bridge-api';
import type { BrandingSnapshot } from '../../../shared/branding/types';
import type { PairingStatusChangedEvent } from '../../../shared/pairing-types';

/**
 * RT-475 — the four tenant-logo slots (RT-832) and the renderer feed.
 * Visual sizes at 1024/1280 need the packaged app (RT-952); these tests pin
 * the structure: fixed box, own image size, fallback, collapse, powered-by.
 */

afterEach(() => {
  cleanup();
  resetBrandingForTests(undefined);
});

const PNG_A = 'data:image/png;base64,QUFB';
const PNG_B = 'data:image/png;base64,QkJC';
const image = { width: 100, height: 25, src1x: PNG_A, src2x: PNG_B };
const LOGO: BrandingSnapshot = {
  v: 1,
  kind: 'logo',
  displayName: 'صيدلية النور',
  card: false,
  slots: {
    boot: { ...image, width: 240, height: 60 },
    pairing: image,
    sign_in: { ...image, width: 128, height: 32 },
    lock: image,
  },
};
const NAME: BrandingSnapshot = { v: 1, kind: 'name', displayName: 'صيدلية النور' };
const NONE: BrandingSnapshot = { v: 1, kind: 'none' };

describe('RT-475 — BrandSlot', () => {
  it('collapses with no logo or before the first read (RT-832: today’s screen)', () => {
    const { container: a } = render(<BrandSlot slot="lock" snapshot={NONE} />);
    expect(a).toBeEmptyDOMElement();
    const { container: b } = render(<BrandSlot slot="lock" snapshot={undefined} />);
    expect(b).toBeEmptyDOMElement();
  });

  it('shows the 1x rendition at its own size with a 2x srcset, never sized to the box', () => {
    render(<BrandSlot slot="pairing" snapshot={LOGO} />);
    const img = screen.getByRole('img', { name: 'صيدلية النور' });
    expect(img).toHaveAttribute('width', '100');
    expect(img).toHaveAttribute('height', '25');
    expect(img).toHaveAttribute('srcset', `${PNG_A} 1x, ${PNG_B} 2x`);
    expect(screen.getByTestId('brand-slot-pairing')).toHaveAttribute('data-brand-kind', 'logo');
  });

  it('puts the logo on the white card when presentation.card is set', () => {
    render(<BrandSlot slot="lock" snapshot={{ ...LOGO, card: true }} />);
    expect(screen.getByTestId('brand-slot-lock')).toHaveClass('v5-brand-slot--card');
  });

  it('shows the tenant name as text when the logo record is unusable', () => {
    render(<BrandSlot slot="boot" snapshot={NAME} />);
    expect(screen.getByTestId('brand-slot-boot')).toHaveAttribute('data-brand-kind', 'name');
    expect(screen.getByText('صيدلية النور')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('falls back to the name, never a broken image, when the rendition fails to decode', () => {
    render(<BrandSlot slot="lock" snapshot={LOGO} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('صيدلية النور')).toBeInTheDocument();
  });
});

describe('RT-475 — powered-by line', () => {
  it('shows «بدعم من Retail Tower» only with a logo', () => {
    const { rerender } = render(<PoweredBy snapshot={LOGO} />);
    expect(screen.getByTestId('powered-by')).toHaveTextContent('بدعم من Retail Tower');
    rerender(<PoweredBy snapshot={NAME} />);
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
    rerender(<PoweredBy snapshot={NONE} />);
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
  });
});

describe('RT-475 — sign-in strip (option A)', () => {
  it('the logo replaces the mark and the wordmark; the powered-by line is added', () => {
    render(<EntryStrip terminalLabel="POS-03" branding={LOGO} />);
    expect(screen.queryByText('POS Pulse')).not.toBeInTheDocument();
    expect(screen.getByTestId('brand-slot-sign_in')).toBeInTheDocument();
    expect(screen.getByTestId('entry-terminal-label')).toHaveTextContent('POS-03');
    expect(screen.getByTestId('powered-by')).toBeInTheDocument();
  });

  it('with no logo the strip is today’s: the wordmark, no slot, no powered-by', () => {
    render(<EntryStrip terminalLabel="POS-03" branding={NONE} />);
    expect(screen.getByText('POS Pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-slot-sign_in')).not.toBeInTheDocument();
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
  });
});

describe('RT-475 — boot screen', () => {
  it('shows the logo and the powered-by line during the load, the status unchanged', () => {
    resetBrandingForTests(LOGO);
    render(<RouteLoading />);
    expect(screen.getByTestId('brand-slot-boot')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('جارٍ التحميل…');
    expect(screen.getByTestId('powered-by')).toBeInTheDocument();
  });

  it('is exactly today’s screen with no branding', () => {
    render(<RouteLoading />);
    expect(screen.queryByTestId('brand-slot-boot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
  });
});

function Probe() {
  const branding = useBranding();
  return <span data-testid="probe">{branding?.kind ?? 'unknown'}</span>;
}

function fakeBranding(first: BrandingSnapshot) {
  let push: ((s: BrandingSnapshot) => void) | undefined;
  const get = vi.fn<() => Promise<BrandingSnapshot>>(() => Promise.resolve(first));
  const bridge: BrandingBridgeAPI = {
    get,
    onChanged: (cb) => {
      push = cb;
      return () => {
        push = undefined;
      };
    },
  };
  return { bridge, get, push: (s: BrandingSnapshot) => push?.(s) };
}

describe('RT-475 — renderer feed', () => {
  it('reads once at start and follows the change push', async () => {
    const fake = fakeBranding(NAME);
    render(<Probe />);
    const stop = startBrandingFeed(fake.bridge);
    expect(await screen.findByText('name')).toBeInTheDocument();
    act(() => {
      fake.push(LOGO);
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('logo');
    stop();
  });

  it('a pairing change clears the snapshot at once, then re-reads it', async () => {
    const fake = fakeBranding(LOGO);
    let onPairing: ((e: PairingStatusChangedEvent) => void) | undefined;
    const pairing = {
      onStatusChanged: (cb: (e: PairingStatusChangedEvent) => void) => {
        onPairing = cb;
        return () => undefined;
      },
    };
    render(<Probe />);
    const stop = startBrandingFeed(fake.bridge, pairing);
    expect(await screen.findByText('logo')).toBeInTheDocument();

    let resolveNext: (s: BrandingSnapshot) => void = () => undefined;
    fake.get.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );
    act(() => {
      onPairing?.({ kind: 'paired' });
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('unknown');
    await act(async () => {
      resolveNext(NONE);
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('none');
    stop();
  });

  it('a missing bridge leaves every screen as today', () => {
    render(<Probe />);
    startBrandingFeed(undefined);
    expect(screen.getByTestId('probe')).toHaveTextContent('unknown');
  });
});
