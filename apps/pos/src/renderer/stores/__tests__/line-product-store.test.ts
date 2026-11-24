import { beforeEach, describe, expect, it } from 'vitest';

import { resetSaleStores } from '../../sale/reset-sale-stores';
import { useLineProductStore } from '../line-product-store';

/** RT-1578 — the product each cart line was added from (feeds the availability badge only). */
beforeEach(() => {
  useLineProductStore.getState().reset();
});

describe('line-product-store', () => {
  it('remembers the product of each line and keeps earlier lines', () => {
    useLineProductStore.getState().remember('line-1', 'p-1');
    useLineProductStore.getState().remember('line-2', 'p-2');
    expect(useLineProductStore.getState().byLine).toEqual({ 'line-1': 'p-1', 'line-2': 'p-2' });
  });

  it('is cleared by the logical «new sale» reset', () => {
    useLineProductStore.getState().remember('line-1', 'p-1');
    resetSaleStores();
    expect(useLineProductStore.getState().byLine).toEqual({});
  });
});
