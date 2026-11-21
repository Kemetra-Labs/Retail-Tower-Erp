/**
 * The `console-sales` module's port (RT-1453 module boundaries). Other modules import from here, not
 * from the files inside. RT-1539 (Manager Sales Ask/Explain) reads the two deterministic sales reads
 * in-process, with the caller's own `ResolvedContext`, so their store-scope checks run again: the
 * summary (RT-649) and the sales by store (RT-1053), their wire types, their refusals and the
 * business-date schema of the request.
 */
export { ConsoleSalesByStoreService } from "./console-sales-by-store.service";
export { ConsoleSalesSummaryService } from "./console-sales-summary.service";
export { BusinessDateSchema, refineBusinessRange } from "./console-sales.query";
export type { ConsoleSalesByStore, StoreSalesByStore } from "./console-sales-by-store.projections";
export type { ConsoleSalesSummary, MoneyFacts, SalesKpis, StoreSalesSummary } from "./console-sales-summary.projections";
