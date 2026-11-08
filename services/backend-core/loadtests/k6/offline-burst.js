// RT-1281 — offline-sale burst: N terminals come back online together and each
// flushes K sales it took while offline.
//
// A device-path sale is accepted only when its `occurredAt` is no earlier than
// about 120 s before the cashier admission was created (sales.yaml
// `operatorUserId`); the server creates an admission at its own "now", and a
// `reconcile_offline` admission does not cover earlier sales. So the run models
// the offline window forward in time:
//   1. setup(): admit each terminal's cashier online and keep the admission's
//      `server_time` (the start of the offline window);
//   2. the flush scenario starts LOAD_OFFLINE_MINUTES later (`startTime`), with
//      no traffic in between (the terminals are "offline");
//   3. each terminal sends its K sales one after another (a terminal's outbox
//      drains in order), all terminals at once, with `occurredAt` spread across
//      [admission time, flush start].
// LOAD_OFFLINE_MINUTES must stay inside the admission TTL (CASHIER_ADMISSION_TTL_SECONDS,
// default 12 h); the cap below is 240 min. Run only after the steady-state
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
      startTime: `${OFFLINE_MINUTES}m`,
      maxDuration: "30m",
    },
  },
  thresholds: abortThresholds("pos_offline_flush"),
  tags: { run_id: RUN_ID, terminals: String(TERMINALS), scenario: "offline_burst" },
};

export function setup() {
  const terminals = loadTerminals(TERMINALS);
  for (const t of terminals) {
    const admittedAt = admitCashier(t);
    if (!admittedAt) fail(`terminal ${t.index}: cashier admission refused; check fixtures/pos-terminals.md`);
    t.admittedAtMs = Date.parse(admittedAt);
  }
  return { terminals, products: loadProducts() };
}

const flushStart = {};
export default function flush(data) {
  const t = data.terminals[__VU - 1];
  // Fix this terminal's offline window at its first flushed sale, then spread the
  // K sales evenly across it, oldest first, all after the admission time.
  flushStart[t.index] = flushStart[t.index] || Date.now();
  const step = (flushStart[t.index] - t.admittedAtMs) / (BURST + 1);
  const occurredAt = new Date(t.admittedAtMs + step * (__ITER + 1)).toISOString();
  captureSale(t, saleBody(t, data.products, CURRENCY, occurredAt, RUN_ID), "pos_offline_flush");
}
