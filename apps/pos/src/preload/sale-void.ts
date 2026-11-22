import { ipcRenderer } from 'electron';

import {
  SALE_VOID_IPC_CHANNELS,
  type SaleVoidAcknowledgeResponse,
  type SaleVoidBridgeAPI,
  type SaleVoidCashExceptionResponse,
  type SaleVoidListResponse,
  type SaleVoidLookupResponse,
  type SaleVoidPayOutResponse,
  type SaleVoidRequestResponse,
} from '../shared/sale-void/types.js';

/**
 * RT-530 — `saleVoid.*` preload bridge. Thin wire-up: main validates every
 * payload, checks the flag and the session, and consumes the manager approval.
 */
export const saleVoid: SaleVoidBridgeAPI = {
  lookup: (req) =>
    ipcRenderer.invoke(SALE_VOID_IPC_CHANNELS.LOOKUP, req) as Promise<SaleVoidLookupResponse>,
  request: (req) =>
    ipcRenderer.invoke(SALE_VOID_IPC_CHANNELS.REQUEST, req) as Promise<SaleVoidRequestResponse>,
  list: () => ipcRenderer.invoke(SALE_VOID_IPC_CHANNELS.LIST) as Promise<SaleVoidListResponse>,
  acknowledge: (req) =>
    ipcRenderer.invoke(
      SALE_VOID_IPC_CHANNELS.ACKNOWLEDGE,
      req,
    ) as Promise<SaleVoidAcknowledgeResponse>,
  payOut: (req) =>
    ipcRenderer.invoke(SALE_VOID_IPC_CHANNELS.PAY_OUT, req) as Promise<SaleVoidPayOutResponse>,
  recordCashException: (req) =>
    ipcRenderer.invoke(
      SALE_VOID_IPC_CHANNELS.CASH_EXCEPTION,
      req,
    ) as Promise<SaleVoidCashExceptionResponse>,
};
