// RT-1281: POS terminal helpers for the terminal-equivalent (TE) scenarios.
//
// A sale is captured the way a paired terminal does it (sales.yaml, `device`
// scheme): `Authorization: Bearer <device token>` plus `operatorUserId` in the
// body, and the server requires a cashier admission of that device, store and
// user covering the sale's `occurredAt`. No provider (Descope) sign-in is
// scripted. See fixtures/pos-terminals.md for provisioning.
//
// Env (credentials only via `op run`; never commit them):
//   LOAD_TERMINAL_<n>_TOKEN       device token of paired terminal n (1-based)
//   LOAD_TERMINAL_<n>_CASHIER_ID  users.id of the cashier admitted on terminal n
//   LOAD_PRODUCTS                 JSON array of {"ref","name","price"} (price as
//                                 an exact decimal string), seeded in the store
//   LOAD_CURRENCY                 the tenant currency (ISO 4217), e.g. EGP
//   LOAD_LINES_MIN / _MAX         lines per sale (default 2 / 5)

import http from "k6/http";
import { check, fail } from "k6";

import { baseUrl, uuidv4 } from "./util.js";

/** Hard ceiling on terminal-equivalents in one run (RT-1279: 1, 3 or 10). */
export const MAX_TERMINALS = 10;

export function requireEnv(name) {
  const v = __ENV[name];
  if (v === undefined || v === "") fail(`missing required env ${name} (see fixtures/pos-terminals.md)`);
  return v;
}

export function terminalCount() {
  const n = Number.parseInt(requireEnv("LOAD_TERMINALS"), 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TERMINALS) {
    fail(`LOAD_TERMINALS must be an integer from 1 to ${MAX_TERMINALS}, got ${__ENV.LOAD_TERMINALS}`);
  }
  return n;
}

/** Terminals 1..n with their device token and cashier user id. */
export function loadTerminals(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      index: i,
      token: requireEnv(`LOAD_TERMINAL_${i}_TOKEN`),
      cashierId: requireEnv(`LOAD_TERMINAL_${i}_CASHIER_ID`),
    });
  }
  return out;
}

const DECIMAL = /^\d+(\.\d{1,2})?$/;

export function loadProducts() {
  let products;
  try {
    products = JSON.parse(requireEnv("LOAD_PRODUCTS"));
  } catch (e) {
    fail(`LOAD_PRODUCTS is not valid JSON: ${e}`);
  }
  if (!Array.isArray(products) || products.length === 0) fail("LOAD_PRODUCTS must be a non-empty array");
  for (const p of products) {
    if (!p || typeof p.ref !== "string" || typeof p.name !== "string" || !DECIMAL.test(String(p.price))) {
      fail("each LOAD_PRODUCTS entry needs string ref and name and a decimal-string price");
    }
  }
  return products;
}

function deviceHeaders(token, extra) {
  return Object.assign(
    {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + token,
    },
    extra || {},
  );
}

/**
 * Admit the terminal's cashier online. Returns the admission's `server_time`
 * (ISO string) when the server answers `admitted`, otherwise null. A device-path
 * sale is accepted only when its `occurredAt` is no earlier than about 120 s
 * before the admission was created (sales.yaml `operatorUserId`), so backdated
 * sales must lie after this time.
 */
export function admitCashier(terminal) {
  const body = { mode: "online", user_id: terminal.cashierId, idempotency_key: uuidv4() };
  const res = http.post(`${baseUrl()}/api/pos/v1/cashier-admissions`, JSON.stringify(body), {
    headers: deviceHeaders(terminal.token),
    tags: { flow: "cashier_admission" },
  });
  let kind = null;
  let serverTime = null;
  try {
    kind = res.json("kind");
    serverTime = res.json("server_time");
  } catch (_) {
    kind = null;
  }
  const ok = check(res, { "admission admitted": (r) => r.status === 200 && kind === "admitted" });
  return ok ? serverTime || new Date().toISOString() : null;
}

/** Cents arithmetic on 2-decimal strings, so totals stay exact (no float drift). */
function toCents(price) {
  const [whole, frac = ""] = String(price).split(".");
  return Number.parseInt(whole, 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
}
function fromCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

const LINES_MIN = Number.parseInt(__ENV.LOAD_LINES_MIN || "2", 10);
const LINES_MAX = Number.parseInt(__ENV.LOAD_LINES_MAX || "5", 10);
if (!Number.isInteger(LINES_MIN) || !Number.isInteger(LINES_MAX) || LINES_MIN < 1 || LINES_MIN > LINES_MAX || LINES_MAX > 500) {
  fail("LOAD_LINES_MIN and LOAD_LINES_MAX must be integers with 1 <= min <= max <= 500");
}

function linesPerSale() {
  return LINES_MIN + Math.floor(Math.random() * (LINES_MAX - LINES_MIN + 1));
}

/**
 * A CaptureSaleRequest a real cashier sale would produce: seeded products,
 * quantities 1-3, one cash tender equal to posTotal, the tenant currency, and
 * `operatorUserId` for the device scheme. `sourceSystem` marks k6 rows so the
 * reconciliation script can find exactly this run's sales.
 */
export function saleBody(terminal, products, currency, occurredAt, runId) {
  const lines = [];
  let total = 0;
  const lineCount = linesPerSale();
  for (let i = 0; i < lineCount; i++) {
    const p = products[Math.floor(Math.random() * products.length)];
    const qty = 1 + Math.floor(Math.random() * 3);
    const amount = toCents(p.price) * qty;
    total += amount;
    lines.push({
      lineName: p.name,
      unitPrice: fromCents(toCents(p.price)),
      currencyCode: currency,
      quantity: String(qty),
      lineAmount: fromCents(amount),
      unit: "each",
      tenantProductRef: p.ref,
    });
  }
  return JSON.stringify({
    sourceSystem: "k6-perf",
    externalId: `${runId}-t${terminal.index}-${uuidv4()}`,
    currencyCode: currency,
    posTotal: fromCents(total),
    occurredAt,
    lines,
    tenders: [{ method: "cash", amount: fromCents(total) }],
    operatorUserId: terminal.cashierId,
  });
}

/** POST one sale; 201 (created) is the only success for a fresh Idempotency-Key. */
export function captureSale(terminal, body, flow) {
  const res = http.post(`${baseUrl()}/api/pos/v1/sales`, body, {
    headers: deviceHeaders(terminal.token, { "Idempotency-Key": uuidv4() }),
    tags: { flow, terminal: `t${terminal.index}` },
  });
  check(res, { "capture 201": (r) => r.status === 201 }, { flow });
  check(res, { "no 5xx": (r) => r.status < 500 }, { kind: "no_5xx" });
  return res;
}

/**
 * Catalog read-down as a terminal does between sales (snapshot once, then
 * deltas). Only the first snapshot page is read; with about 200 seeded products
 * that is the whole catalog, but it is not a full paged read-down.
 */
export function catalogDeltas(terminal, cursor) {
  const headers = deviceHeaders(terminal.token);
  if (!cursor) {
    const snap = http.get(`${baseUrl()}/api/pos/v1/catalog/snapshot`, { headers, tags: { flow: "catalog_snapshot" } });
    check(snap, { "snapshot 200": (r) => r.status === 200 }, { flow: "catalog_snapshot" });
    try {
      return snap.json("cursor") || null;
    } catch (_) {
      return null;
    }
  }
  const res = http.get(`${baseUrl()}/api/pos/v1/catalog/deltas?since=${encodeURIComponent(cursor)}`, {
    headers,
    tags: { flow: "catalog_deltas" },
  });
  check(res, { "deltas 200": (r) => r.status === 200 }, { flow: "catalog_deltas" });
  try {
    return res.json("cursor") || cursor;
  } catch (_) {
    return cursor;
  }
}

/** Owner-set abort thresholds; required so a run never starts without them. */
export function abortThresholds(flow) {
  const errorRate = requireEnv("LOAD_ABORT_ERROR_RATE");
  const p95 = requireEnv("LOAD_ABORT_P95_MS");
  return {
    [`http_req_duration{flow:${flow}}`]: [{ threshold: `p(95)<${p95}`, abortOnFail: true, delayAbortEval: "2m" }],
    http_req_failed: [{ threshold: `rate<${errorRate}`, abortOnFail: true, delayAbortEval: "1m" }],
    "checks{kind:no_5xx}": [{ threshold: "rate>0.99", abortOnFail: true, delayAbortEval: "1m" }],
  };
}
