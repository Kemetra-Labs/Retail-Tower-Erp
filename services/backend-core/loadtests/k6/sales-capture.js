// loadtests/k6/sales-capture.js
//
// 008-POLISH T090 — sale-capture performance scenario (SC-010).
//
// Measures inline single-sale capture latency at the SaaS boundary:
//   POST /api/pos/v1/sales  (operationId captureSale)
// against the SC-010 release gate: p95 <= 500 ms, p99 <= 1 s.
//
// RT-1281: the sale now authenticates the way a paired terminal does
// (sales.yaml `device` scheme): the terminal's device token plus
// `operatorUserId`, under a cashier admission made in setup(). The body is a
// realistic sale (seeded products, a cash tender, the tenant currency); see
// lib/pos.js. The old single LOAD_POS_TOKEN path could not authorize a sale
// (a device token without `operatorUserId` is refused).
//
// Each VU is one terminal and sells back to back (closed loop), so this is the
// latency-under-concurrency check; pos-terminals.js is the owner-rate model.
// Lab and synthetic data only; do NOT weaken the thresholds to make a box pass.
//
// Required env: BASE_URL, LOAD_TERMINALS (1..10), LOAD_TERMINAL_<n>_TOKEN,
// LOAD_TERMINAL_<n>_CASHIER_ID, LOAD_PRODUCTS, LOAD_CURRENCY, LOAD_RUN_ID
// (fixtures/pos-terminals.md). Optional: LOAD_DURATION (default 5m).

import { fail } from "k6";

import {
  admitCashier,
  captureSale,
  loadProducts,
  loadTerminals,
  requireEnv,
  saleBody,
  terminalCount,
} from "./lib/pos.js";
import { sleepJitter } from "./lib/util.js";

const TERMINALS = terminalCount();
const DURATION = __ENV.LOAD_DURATION || "5m";
const RUN_ID = requireEnv("LOAD_RUN_ID");
const CURRENCY = requireEnv("LOAD_CURRENCY");

export const options = {
  scenarios: {
    sales_capture: {
      executor: "constant-vus",
      vus: TERMINALS,
      duration: DURATION,
    },
  },
  // SC-010 release gate — the inline single-sale capture budget at the SaaS boundary.
  thresholds: {
    "http_req_duration{flow:sales_capture}": ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    "checks{kind:no_5xx}": ["rate>0.99"],
  },
  tags: { run_id: RUN_ID },
};

export function setup() {
  const terminals = loadTerminals(TERMINALS);
  for (const t of terminals) {
    if (!admitCashier(t)) fail(`terminal ${t.index}: cashier admission refused; check fixtures/pos-terminals.md`);
  }
  return { terminals, products: loadProducts() };
}

export default function salesCapture(data) {
  const t = data.terminals[(__VU - 1) % data.terminals.length];
  captureSale(t, saleBody(t, data.products, CURRENCY, new Date().toISOString(), RUN_ID), "sales_capture");
  sleepJitter(0.5);
}
