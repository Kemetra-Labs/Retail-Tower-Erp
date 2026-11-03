/**
 * RT-1052 — sale size limits the till enforces so it never builds a sale that
 * Backend-Core would refuse at sync (a refused capture stays stuck in the
 * outbox). They mirror the Backend-Core capture-sale limits the owner set on
 * 2026-11-01 (RT-1051 comment 15078); the server enforces them only after tills
 * run a build with these caps.
 */

/** Distinct lines in one sale (capture `lines` maxItems). */
export const MAX_SALE_LINES = 30;
