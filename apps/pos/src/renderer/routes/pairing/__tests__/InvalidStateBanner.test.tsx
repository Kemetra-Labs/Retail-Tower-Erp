import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { InvalidStateBanner } from '../InvalidStateBanner';
import { PAIRING_INVALID_REASONS } from '../../../../shared/pairing-types';

afterEach(cleanup);

describe('InvalidStateBanner (RT-1348)', () => {
  it('says this terminal is paired with another server, and how to carry on', () => {
    render(<InvalidStateBanner reason="other_server" />);
    const banner = screen.getByTestId('invalid-state-banner');
    expect(banner).toHaveTextContent('مرتبط بخادم آخر');
    expect(banner).toHaveTextContent('رمز ربط جديدًا');
    expect(banner).toHaveTextContent('المبيعات التي لم تُرسَل محفوظة على الجهاز');
  });

  it('has an Arabic message for every reason the status can carry', () => {
    for (const reason of PAIRING_INVALID_REASONS) {
      render(<InvalidStateBanner reason={reason} />);
      expect(screen.getByTestId('invalid-state-banner').textContent).toMatch(/[؀-ۿ]/);
      cleanup();
    }
  });
});
