import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { BrandSlot, PoweredBy } from '../BrandSlot';
import {
  dropUndecodableBranding,
  resetBrandingForTests,
  startBrandingFeed,
  useBranding,
} from '../branding-store';
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
  });

  it('puts the logo on the white card when presentation.card is set', () => {
    render(<BrandSlot slot="lock" snapshot={{ ...LOGO, card: true }} />);
    expect(screen.getByTestId('brand-slot-lock')).toHaveClass('v5-brand-slot--card');
  });

  it('a rendition that fails to decode collapses the slot and the powered-by line', () => {
    resetBrandingForTests(LOGO);
    render(<Branded />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brand-slot-lock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('powered-by')).not.toBeInTheDocument();
  });
});

function Branded() {
  const branding = useBranding();
  return (
    <>
      <BrandSlot slot="lock" snapshot={branding} />
      <PoweredBy snapshot={branding} />
    </>
  );
}

describe('RT-475 — powered-by line', () => {
  it('shows «بدعم من Retail Tower» only with a logo', () => {
    const { rerender } = render(<PoweredBy snapshot={LOGO} />);
    expect(screen.getByTestId('powered-by')).toHaveTextContent('بدعم من Retail Tower');
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

/** A started feed with a controllable pairing push and a held next read. */
async function startedFeed() {
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
  return {
    stop,
    push: fake.push,
    pairingChanged: () => onPairing?.({ kind: 'paired' }),
    answer: async (s: BrandingSnapshot) => {
      await act(async () => {
        resolveNext(s);
        await Promise.resolve();
      });
    },
  };
}

describe('RT-475 — renderer feed', () => {
  it('reads once at start and follows the change push', async () => {
    const fake = fakeBranding(NONE);
    render(<Probe />);
    const stop = startBrandingFeed(fake.bridge);
    expect(await screen.findByText('none')).toBeInTheDocument();
    act(() => {
      fake.push(LOGO);
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('logo');
    stop();
  });

  it.each([
    ['clears the snapshot at once, then shows the re-read', false, NONE, 'none'],
    ['ignores a push that arrives before the re-read answers', true, NONE, 'none'],
  ] as const)('a pairing change %s', async (_label, pushMeanwhile, reread, expected) => {
    const feed = await startedFeed();
    act(() => {
      feed.pairingChanged();
      if (pushMeanwhile) feed.push(LOGO);
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('unknown');
    await feed.answer(reread);
    expect(screen.getByTestId('probe')).toHaveTextContent(expected);
    feed.stop();
  });

  it('a missing bridge leaves every screen as today', () => {
    render(<Probe />);
    startBrandingFeed(undefined);
    expect(screen.getByTestId('probe')).toHaveTextContent('unknown');
  });
});

describe('RT-475 — renderer feed failures', () => {
  it('a failed read leaves today’s screens', async () => {
    const fake = fakeBranding(LOGO);
    fake.get.mockReturnValueOnce(Promise.reject(new Error('branding_unavailable')));
    render(<Probe />);
    const stop = startBrandingFeed(fake.bridge);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('unknown');
    stop();
  });

  it('a read superseded by a push is dropped, whether it answers or fails', async () => {
    const fake = fakeBranding(LOGO);
    let rejectFirst: (e: Error) => void = () => undefined;
    fake.get.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    render(<Probe />);
    const stop = startBrandingFeed(fake.bridge);
    act(() => {
      fake.push(LOGO);
    });
    await act(async () => {
      rejectFirst(new Error('late'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('logo');
    stop();
  });

  it('a decode failure of a snapshot already replaced changes nothing', () => {
    resetBrandingForTests(LOGO);
    render(<Probe />);
    dropUndecodableBranding({ ...LOGO });
    expect(screen.getByTestId('probe')).toHaveTextContent('logo');
  });
});
