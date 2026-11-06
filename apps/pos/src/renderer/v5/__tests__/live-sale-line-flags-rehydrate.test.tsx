/**
 * RT-1178 — the Rx and controlled-substance flags of cart lines survive a
 * renderer reload (or an app restart): the Sale reads the cart back from
 * main's `cart.snapshot`, which carries each line's flags from the local
 * catalogue, and refills the renderer flag store from it.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CartSnapshotLine } from '../../../shared/cart/bridge-types';
import { CartState } from '../../../shared/cart/cart-state';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useLineFlagsStore } from '../../stores/line-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';
import {
  PANADOL,
  addLineByScan,
  makeBridges,
  renderSale,
  signIn,
  type Bridges,
} from './__helpers__/live-sale-harness';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useLineFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

const RX: ProductSnapshotDisplay = {
  product_id: 'p-rx',
  display_name_ar: 'أموكسيسيلين',
  price_minor: 4500,
  active: true,
  controlled_substance: false,
  prescription_required: true,
};

const CONTROLLED: ProductSnapshotDisplay = {
  product_id: 'p-ctl',
  display_name_ar: 'ترامادول',
  price_minor: 6000,
  active: true,
  controlled_substance: true,
  prescription_required: true,
};

function line(id: string, product: ProductSnapshotDisplay): CartSnapshotLine {
  return {
    line_id: id,
    display_name: product.display_name_ar,
    quantity: 1,
    unit_price_minor: product.price_minor,
    line_subtotal_minor: product.price_minor,
    note: null,
    version: 1,
    controlled_substance: product.controlled_substance,
    prescription_required: product.prescription_required,
  };
}

/** What main's `cart.snapshot` reports for the cart the scans built. */
function mainSnapshot(): unknown {
  return {
    kind: 'ok',
    snapshot: {
      cart_id: 'cart-1',
      state: CartState.editing,
      paid: false,
      lines: [line('line-1', RX), line('line-2', CONTROLLED), line('line-3', PANADOL)],
      discount_placeholders: [],
      envelope: null,
    },
  };
}

function addOk(lineId: string, product: ProductSnapshotDisplay): unknown {
  return {
    kind: 'ok',
    line_id: lineId,
    merged: false,
    version: 1,
    display_name: product.display_name_ar,
    unit_price_minor: product.price_minor,
    line_subtotal_minor: product.price_minor,
    quantity: 1,
  };
}

function flagsBridges(): Bridges {
  const bridges = makeBridges();
  bridges.lookupBarcode
    .mockReset()
    .mockResolvedValueOnce({ kind: 'one', product: RX })
    .mockResolvedValueOnce({ kind: 'one', product: CONTROLLED })
    .mockResolvedValueOnce({ kind: 'one', product: PANADOL });
  bridges.add
    .mockReset()
    .mockResolvedValueOnce(addOk('line-1', RX))
    .mockResolvedValueOnce(addOk('line-2', CONTROLLED))
    .mockResolvedValueOnce(addOk('line-3', PANADOL));
  bridges.snapshot.mockResolvedValue(mainSnapshot());
  return bridges;
}

function cartLine(name: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.v5-sale-cart-line')).find((el) =>
    el.textContent.includes(name),
  );
  if (row === undefined) throw new Error(`no cart line for ${name}`);
  return row;
}

function flagsOf(name: string): { rx: boolean; controlled: boolean } {
  const row = cartLine(name);
  return {
    rx: row.querySelector('.v5-live-flag--rx') !== null,
    controlled: row.querySelector('.v5-live-flag--controlled') !== null,
  };
}

describe('RT-1178 line flags after a renderer reload', () => {
  it('keeps the Rx and controlled flags on existing lines once the cart is read back', async () => {
    signIn();
    const bridges = flagsBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addLineByScan(user);
    await addLineByScan(user);
    await addLineByScan(user);

    // Flags shown at add time.
    expect(flagsOf(RX.display_name_ar)).toEqual({ rx: true, controlled: false });
    expect(flagsOf(CONTROLLED.display_name_ar)).toEqual({ rx: true, controlled: true });
    expect(flagsOf(PANADOL.display_name_ar)).toEqual({ rx: false, controlled: false });

    // Renderer reload: the screen and every renderer store are gone; only the
    // active cart id is known again, and the cart is read back from main.
    cleanup();
    useLineFlagsStore.getState().reset();
    useCartStore.setState({
      activeCart: { cart_id: 'cart-1', state: CartState.editing, lastLineId: null },
    });
    expect(useLineFlagsStore.getState().byLine).toEqual({});

    render(
      <LiveSaleWorkspace
        cartBridge={bridges.cart}
        catalogueBridge={bridges.catalogue}
        onPaymentContinue={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(3);
    });
    expect(bridges.snapshot).toHaveBeenCalledWith({ cart_id: 'cart-1' });
    await waitFor(() => {
      expect(flagsOf(RX.display_name_ar)).toEqual({ rx: true, controlled: false });
    });
    expect(flagsOf(CONTROLLED.display_name_ar)).toEqual({ rx: true, controlled: true });
    expect(flagsOf(PANADOL.display_name_ar)).toEqual({ rx: false, controlled: false });
  });
});
