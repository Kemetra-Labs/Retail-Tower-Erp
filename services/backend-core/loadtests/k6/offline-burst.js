// RT-1281 — offline-sale burst: N terminals come back online together and each
// flushes K sales it took while offline.
//
// Each terminal first reconciles an offline admission that started
// LOAD_OFFLINE_MINUTES ago (`mode: reconcile_offline`), so every backdated
// `occurredAt` lies inside an admission window, as with a real offline shift.
// Each terminal then sends its K sales one after another (a terminal's outbox
// drains in order), all terminals at once. Run only after the steady-state
// pos-terminals.js step for the same TE count has passed (RT-1279 plan).
//
// Required env: BASE_URL, LOAD_TERMINALS (1..10), LOAD_BURST_SALES (K, 1..500),
// LOAD_OFFLINE_MINUTES (1..240), LOAD_TERMINAL_<n>_TOKEN / _CASHIER_ID,
// LOAD_PRODUCTS, LOAD_CURRENCY, LOAD_ABORT_ERROR_RATE, LOAD_ABORT_P95_MS, LOAD_RUN_ID.

import { fail } from "k6";

import {
  abortThresholds,
  admitCashier,
  captureSale,
  loadProducts,
  loadTerminals,
  requireEnv,
  saleBody,
  terminalCount,
} from "./lib/pos.js";

const TERMINALS = terminalCount();
const BURST = Number.parseInt(requireEnv("LOAD_BURST_SALES"), 10);
if (!Number.isInteger(BURST) || BURST < 1 || BURST > 500) fail("LOAD_BURST_SALES must be an integer from 1 to 500");
const OFFLINE_MINUTES = Number.parseInt(requireEnv("LOAD_OFFLINE_MINUTES"), 10);
if (!Number.isInteger(OFFLINE_MINUTES) || OFFLINE_MINUTES < 1 || OFFLINE_MINUTES > 240) {
  fail("LOAD_OFFLINE_MINUTES must be an integer from 1 to 240");
}
const RUN_ID = requireEnv("LOAD_RUN_ID");
const CURRENCY = requireEnv("LOAD_CURRENCY");

export const options = {
  scenarios: {
    flush: {
      executor: "per-vu-iterations",
      vus: TERMINALS,
      iterations: BURST,
      maxDuration: "30m",
    },
  },
  thresholds: abortThresholds("pos_offline_flush"),
  tags: { run_id: RUN_ID, terminals: String(TERMINALS), scenario: "offline_burst" },
};

export function setup() {
  const offlineStart = Date.now() - OFFLINE_MINUTES * 60 * 1000;
  const terminals = loadTerminals(TERMINALS);
  for (const t of terminals) {
    if (!admitCashier(t, new Date(offlineStart).toISOString())) {
      fail(`terminal ${t.index}: offline admission reconcile refused; check fixtures/pos-terminals.md`);
    }
  }
  return { terminals, products: loadProducts(), offlineStart };
}

export default function flush(data) {
  const t = data.terminals[__VU - 1];
  // Spread the K sales evenly across the offline window, oldest first.
  const step = (Date.now() - data.offlineStart) / (BURST + 1);
  const occurredAt = new Date(data.offlineStart + step * (__ITER + 1)).toISOString();
  captureSale(t, saleBody(t, data.products, CURRENCY, occurredAt, RUN_ID), "pos_offline_flush");
}
