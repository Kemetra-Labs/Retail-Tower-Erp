import { ipcRenderer } from 'electron';

import {
  PRINTER_IPC_CHANNELS,
  type PrinterBridgeAPI,
  type PrinterGetResponse,
  type PrinterListResponse,
  type PrinterSetResponse,
  type PrinterTestPrintResponse,
} from '../shared/printer/types.js';

/**
 * RT-886 — `printer.*` preload bridge. Thin wire-up: main validates every
 * payload and checks the operator session on every call.
 */
export const printer: PrinterBridgeAPI = {
  list: () => ipcRenderer.invoke(PRINTER_IPC_CHANNELS.LIST) as Promise<PrinterListResponse>,
  get: () => ipcRenderer.invoke(PRINTER_IPC_CHANNELS.GET) as Promise<PrinterGetResponse>,
  set: (request) =>
    ipcRenderer.invoke(PRINTER_IPC_CHANNELS.SET, request) as Promise<PrinterSetResponse>,
  testPrint: () =>
    ipcRenderer.invoke(PRINTER_IPC_CHANNELS.TEST_PRINT) as Promise<PrinterTestPrintResponse>,
};
