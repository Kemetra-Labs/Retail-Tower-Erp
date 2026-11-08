// RT-1281 — N POS terminal-equivalents (TE) selling at a fixed, owner-set rate.
//
// One TE is one paired terminal with one admitted cashier. The run offers
// LOAD_TERMINALS x LOAD_SALES_PER_HOUR sales per hour (constant arrival rate),
// spread round-robin across the terminals, and reads catalog deltas every
// LOAD_CATALOG_EVERY (default 5m) per terminal. At most LOAD_TERMINALS sales are
// in flight at once (one per terminal); if responses get slow enough that the
// rate cannot be met, k6 reports `dropped_iterations` — check it in every run
// report, because a non-zero value means the offered load was not reached.
// Runs only against an isolated lab with synthetic data (RT-1279 boundaries);
// RT-317 owns when and where it runs.
//
// Required env (no defaults, so a run never starts on a guess):
//   BASE_URL, LOAD_TERMINALS (1..10), LOAD_SALES_PER_HOUR (1..600),
//   LOAD_TERMINAL_<n>_TOKEN, LOAD_TERMINAL_<n>_CASHIER_ID for n = 1..LOAD_TERMINALS,
//   LOAD_PRODUCTS, LOAD_CURRENCY, LOAD_ABORT_ERROR_RATE, LOAD_ABORT_P95_MS,
//   LOAD_RUN_ID (marks this run's sales for scripts/reconcile-run.sql).
// Optional: LOAD_DURATION (default 15m steady state), LOAD_CATALOG_EVERY (5m).
//
// Example (step 3 TE):
//   op run --env-file=loadtests/k6/lab.env -- docker run --rm -i \
//     -e BASE_URL -e LOAD_TERMINALS=3 -e LOAD_SALES_PER_HOUR -e LOAD_RUN_ID ... \
//     -v "$PWD/loadtests/k6:/scripts" grafana/k6:0.50.0 run /scripts/pos-terminals.js \
//     --summary-export /scripts/last-pos-terminals.json

import { fail } from "k6";
import exec from "k6/execution";

import {
  MAX_TERMINALS,
  abortThresholds,
  admitCashier,
  captureSale,
  catalogDeltas,
  loadProducts,
  loadTerminals,
  requireEnv,
  saleBody,
  terminalCount,
} from "./lib/pos.js";

const TERMINALS = terminalCount();
const SALES_PER_HOUR = Number.parseInt(requireEnv("LOAD_SALES_PER_HOUR"), 10);
if (!Number.isInteger(SALES_PER_HOUR) || SALES_PER_HOUR < 1 || SALES_PER_HOUR > 600) {
  fail("LOAD_SALES_PER_HOUR must be an integer from 1 to 600 per terminal");
}
const DURATION = __ENV.LOAD_DURATION || "15m";
const CATALOG_EVERY = __ENV.LOAD_CATALOG_EVERY || "5m";
const RUN_ID = requireEnv("LOAD_RUN_ID");
const CURRENCY = requireEnv("LOAD_CURRENCY");

export const options = {
  scenarios: {
    sales: {
      executor: "constant-arrival-rate",
      exec: "sell",
      rate: TERMINALS * SALES_PER_HOUR,
      timeUnit: "1h",
      duration: DURATION,
      // One VU per terminal; never more, so the offered concurrency is the TE count.
      preAllocatedVUs: TERMINALS,
      maxVUs: Math.min(TERMINALS, MAX_TERMINALS),
    },
    catalog: {
      executor: "constant-arrival-rate",
      exec: "readCatalog",
      rate: TERMINALS,
      timeUnit: CATALOG_EVERY,
      duration: DURATION,
      preAllocatedVUs: TERMINALS,
      maxVUs: Math.min(TERMINALS, MAX_TERMINALS),
    },
  },
  thresholds: abortThresholds("pos_sale"),
  tags: { run_id: RUN_ID, terminals: String(TERMINALS) },
};

export function setup() {
  const terminals = loadTerminals(TERMINALS);
  const products = loadProducts();
  for (const t of terminals) {
    if (!admitCashier(t)) fail(`terminal ${t.index}: cashier admission refused; check fixtures/pos-terminals.md`);
  }
  return { terminals, products };
}

// Round-robin by the scenario's iteration number, so every terminal gets an
// equal share of the arrivals regardless of which pooled VU runs them.
function terminalFor(data) {
  return data.terminals[exec.scenario.iterationInTest % data.terminals.length];
}

export function sell(data) {
  const t = terminalFor(data);
  captureSale(t, saleBody(t, data.products, CURRENCY, new Date().toISOString(), RUN_ID), "pos_sale");
}

const cursors = {};
export function readCatalog(data) {
  const t = terminalFor(data);
  cursors[t.index] = catalogDeltas(t, cursors[t.index]);
}
