/**
 * RT-15 S2 — `returns:*` IPC channel constants.
 *
 * Single source of truth for the preload bridge and the main-process handlers.
 * None of these channels is on the locked-session allowlist
 * (`src/main/ipc/session-lock-guard.ts`), so every one is refused while the
 * operator session is locked (default deny).
 */

export const RETURNS_IPC_CHANNELS = {
  LOOKUP: 'returns:lookup',
  QUOTE: 'returns:quote',
  SUBMIT: 'returns:submit',
  RESOLVE: 'returns:resolve',
  LIST: 'returns:list',
  // RT-15 S4
  PAYOUT: 'returns:payout',
  REPRINT_SLIP: 'returns:reprintSlip',
  // RT-1498 (RT-196 S1 remainder; §A4 record C-1): resend ONE unresolved return.
  RESEND: 'returns:resend',
  // RT-1498 S4/S5: hand ONE unresolved return to support, with a single-use manager approval
  // (`return.resolve_unknown`, disposition `escalate`).
  ESCALATE: 'returns:escalate',
  // RT-1498 close slice: ask the server whether ONE unresolved return was recorded (a read; it sends
  // nothing), and close it as "not recorded" with a single-use manager approval (`return.resolve_unknown`,
  // disposition `close`). Neither is on the locked-session allowlist; recovery mode refuses `returns:*`.
  READ_STATUS: 'returns:readStatus',
  CLOSE: 'returns:close',
} as const;

export type ReturnsIpcChannel = (typeof RETURNS_IPC_CHANNELS)[keyof typeof RETURNS_IPC_CHANNELS];
