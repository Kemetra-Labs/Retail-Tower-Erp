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
  // (`return.resolve_unknown`, disposition `escalate`). There is no `returns:close` channel yet:
  // a close needs a server status read that is owed (RT-1498 C0).
  ESCALATE: 'returns:escalate',
} as const;

export type ReturnsIpcChannel = (typeof RETURNS_IPC_CHANNELS)[keyof typeof RETURNS_IPC_CHANNELS];
