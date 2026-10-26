import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { LiveSaleWorkspace } from './LiveSaleWorkspace';
import { PARKED_SALES_PATH } from '../park/ParkedSalesRoute';
import { useSaleScreenMark } from '../printer/printer-store';

/**
 * 023 Slice G — the production `/app/cart` element: the live v5 Sale.
 * RT-886: while it is mounted, the notices stack may offer the printer prompt.
 */
export function V5SaleRoute(): JSX.Element {
  const navigate = useNavigate();
  useSaleScreenMark();
  return (
    <LiveSaleWorkspace
      onPaymentContinue={() => {
        void navigate('/app/checkout');
      }}
      onShowParked={() => {
        void navigate(PARKED_SALES_PATH);
      }}
    />
  );
}
