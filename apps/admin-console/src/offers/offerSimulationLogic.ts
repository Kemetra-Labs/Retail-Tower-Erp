/**
 * RT-1338 simulation box: "a cart of these prices → this result" (spec 048 §18). Pure: it builds the
 * request only. The result is evaluated by Backend-Core with the §6 algorithm and the saved draft's
 * parameters; the Console renders it and computes nothing.
 *
 * A cart line is a unit price (an exact decimal string, never a float, at most 4 decimals) and a
 * quantity (1 to 999, default 1). 1 to 100 lines. Arabic-Indic digits and «٫» are accepted.
 */
import type { MessageKey } from "@/i18n";
import type { OfferSimulationRequest } from "@/lib/offer-queries";
import { normalizeLevel } from "@/stock-levels/stockLevelLogic";

export const MAX_SIM_LINES = 100;
const MAX_SIM_QUANTITY = 999;

export interface SimulationRow {
  /** The unit price as typed. */
  unitPrice: string;
  /** The quantity as typed; blank is 1. */
  quantity: string;
}

export const EMPTY_SIM_ROW: SimulationRow = { unitPrice: "", quantity: "1" };

export interface SimulationRowError {
  unitPrice?: MessageKey;
  quantity?: MessageKey;
}

export type SimulationResult =
  | { ok: true; request: OfferSimulationRequest }
  | { ok: false; errors: (SimulationRowError | undefined)[]; form?: MessageKey };

const PRICE = /^[0-9]{1,15}(\.[0-9]{1,4})?$/;

function rowError(row: SimulationRow): SimulationRowError | undefined {
  const error: SimulationRowError = {};
  if (!PRICE.test(normalizeLevel(row.unitPrice))) error.unitPrice = "offers.sim.error.price";
  const qty = normalizeLevel(row.quantity);
  if (qty !== "") {
    const n = /^\d{1,4}$/.test(qty) ? Number.parseInt(qty, 10) : 0;
    if (n < 1 || n > MAX_SIM_QUANTITY) error.quantity = "offers.sim.error.quantity";
  }
  return Object.keys(error).length > 0 ? error : undefined;
}

/** The request for the typed rows in `currency`, or the errors by row. */
export function buildSimulation(
  rows: readonly SimulationRow[],
  currency: string,
): SimulationResult {
  if (rows.length === 0) return { ok: false, errors: [], form: "offers.sim.error.noLines" };
  if (rows.length > MAX_SIM_LINES) {
    return { ok: false, errors: [], form: "offers.sim.error.tooManyLines" };
  }
  const errors = rows.map(rowError);
  if (errors.some((e) => e !== undefined)) return { ok: false, errors };
  return {
    ok: true,
    request: {
      currencyCode: currency,
      lines: rows.map((row) => {
        const qty = normalizeLevel(row.quantity);
        return {
          unitPrice: normalizeLevel(row.unitPrice),
          quantity: qty === "" ? 1 : Number.parseInt(qty, 10),
        };
      }),
    },
  };
}
