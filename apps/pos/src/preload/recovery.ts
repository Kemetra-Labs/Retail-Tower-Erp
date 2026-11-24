import { ipcRenderer } from 'electron';

import {
  RECOVERY_IPC_CHANNELS,
  type RecoveryBridgeAPI,
  type RecoveryCancelAttemptResponse,
  type RecoveryCancelHeldCartResponse,
  type RecoveryCancelHeldCartsResponse,
  type RecoveryCompleteAttemptResponse,
  type RecoveryListHeldResponse,
  type RecoveryPrepareCancelHeldCartsResponse,
} from '../shared/operator/recovery.js';

/**
 * RT-441 (RT-116 §7.2) — `recovery.*` preload bridge. Thin wire-up: main
 * validates every payload, checks the session and consumes the approval.
 */
export const recovery: RecoveryBridgeAPI = {
  listHeld: () =>
    ipcRenderer.invoke(RECOVERY_IPC_CHANNELS.LIST_HELD) as Promise<RecoveryListHeldResponse>,
  completeAttempt: (req) =>
    ipcRenderer.invoke(
      RECOVERY_IPC_CHANNELS.COMPLETE_ATTEMPT,
      req,
    ) as Promise<RecoveryCompleteAttemptResponse>,
  cancelAttempt: (req) =>
    ipcRenderer.invoke(
      RECOVERY_IPC_CHANNELS.CANCEL_ATTEMPT,
      req,
    ) as Promise<RecoveryCancelAttemptResponse>,
  cancelHeldCart: (req) =>
    ipcRenderer.invoke(
      RECOVERY_IPC_CHANNELS.CANCEL_HELD_CART,
      req,
    ) as Promise<RecoveryCancelHeldCartResponse>,
  prepareCancelHeldCarts: (req) =>
    ipcRenderer.invoke(
      RECOVERY_IPC_CHANNELS.PREPARE_CANCEL_HELD_CARTS,
      req,
    ) as Promise<RecoveryPrepareCancelHeldCartsResponse>,
  cancelHeldCarts: (req) =>
    ipcRenderer.invoke(
      RECOVERY_IPC_CHANNELS.CANCEL_HELD_CARTS,
      req,
    ) as Promise<RecoveryCancelHeldCartsResponse>,
};
