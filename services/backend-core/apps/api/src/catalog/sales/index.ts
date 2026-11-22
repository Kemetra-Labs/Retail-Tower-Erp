/**
 * The public surface of sale capture (RT-1463): what the ERP posting code asks of sales. Today this
 * directory still sits inside `catalog`; RT-1463 moves it to `apps/api/src/sales/`, where this file
 * becomes the `sales` module's port (RT-1453 convention). Add an export here when another module
 * needs it; a port that touches the database takes the caller's `PoolClient`.
 */
export { SaleTendersNotVisibleError } from "./sale-errors";
export { replaySaleReturns } from "./sale-return-history";
export { SaleResponsibilitiesNotVisibleError } from "./sale-responsibilities";
