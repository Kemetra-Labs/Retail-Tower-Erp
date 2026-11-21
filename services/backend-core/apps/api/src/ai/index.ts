/**
 * The `ai` module's port (RT-1453 module boundaries). Other modules import from here, not from the
 * files inside. RT-1539: the Manager Sales Ask/Explain module, for the composition root.
 */
export { ManagerSalesModule } from "./manager-sales/manager-sales.module";
